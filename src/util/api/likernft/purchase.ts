import axios from 'axios';
import BigNumber from 'bignumber.js';
import { parseTxInfoFromIndexedTx, parseAuthzGrant } from '@likecoin/iscn-js/dist/messages/parsing';
import { formatMsgExecSendAuthorization } from '@likecoin/iscn-js/dist/messages/authz';
import { formatMsgSend } from '@likecoin/iscn-js/dist/messages/likenft';
import { parseAndCalculateStakeholderRewards } from '@likecoin/iscn-js/dist/iscn/parsing';
// eslint-disable-next-line import/no-extraneous-dependencies
import { Transaction } from '@google-cloud/firestore';
import { Request } from 'express';
import { db, likeNFTCollection, FieldValue } from '../../firebase';
import {
  getNFTQueryClient, getNFTISCNData, getLikerNFTSigningClient, getLikerNFTSigningAddressInfo,
} from '../../cosmos/nft';
import {
  DEFAULT_GAS_PRICE, calculateTxGasFee, sendTransactionWithSequence, MAX_MEMO_LENGTH,
} from '../../cosmos/tx';
import {
  COSMOS_LCD_INDEXER_ENDPOINT,
  NFT_COSMOS_DENOM,
  NFT_CHAIN_ID,
  LIKER_NFT_TARGET_ADDRESS,
  LIKER_NFT_FEE_ADDRESS,
  LIKER_NFT_GAS_FEE,
  LIKER_NFT_STARTING_PRICE,
  LIKER_NFT_PRICE_MULTIPLY,
  LIKER_NFT_PRICE_DECAY,
  LIKER_NFT_DECAY_START_BATCH,
  LIKER_NFT_DECAY_END_BATCH,
} from '../../../../config/config';
import { ValidationError } from '../../ValidationError';
import { getISCNPrefixDocName } from '.';
import publisher from '../../gcloudPub';
import { PUBSUB_TOPIC_MISC } from '../../../constant';

const FEE_RATIO = LIKER_NFT_FEE_ADDRESS ? 0.025 : 0;
const EXPIRATION_BUFFER_TIME = 10000;

export function getNFTBatchInfo(batchNumber) {
  const count = batchNumber + 1;
  const baseMultiplier = Math.min(batchNumber, LIKER_NFT_DECAY_START_BATCH);
  let price = LIKER_NFT_STARTING_PRICE * (LIKER_NFT_PRICE_MULTIPLY ** baseMultiplier);
  const decayMultiplier = Math.min(
    LIKER_NFT_DECAY_END_BATCH - LIKER_NFT_DECAY_START_BATCH,
    Math.max(batchNumber - LIKER_NFT_DECAY_START_BATCH, 0),
  );
  let lastPrice = price;
  for (let i = 1; i <= decayMultiplier; i += 1) {
    price += Math.round(lastPrice * (1 - LIKER_NFT_PRICE_DECAY * i));
    lastPrice = price;
  }
  return {
    price,
    count,
  };
}

export async function getFirstUnsoldNFT(
  iscnPrefixDocName,
  classId,
  { transaction }: { transaction?: Transaction } = {},
) {
  const ref = likeNFTCollection.doc(iscnPrefixDocName)
    .collection('class').doc(classId)
    .collection('nft')
    .where('isSold', '==', false)
    .where('isProcessing', '==', false)
    .where('price', '==', 0)
    .limit(1);
  const res = await (transaction ? transaction.get(ref as any) : ref.get());
  if (!res.docs.length) return null;
  const doc = res.docs[0];
  const payload = {
    id: doc.id,
    ...doc.data(),
  };
  return payload;
}

export async function getLatestNFTPriceAndInfo(iscnPrefix, classId) {
  const iscnPrefixDocName = getISCNPrefixDocName(iscnPrefix);
  const [newNftData, nftDoc] = await Promise.all([
    getFirstUnsoldNFT(iscnPrefixDocName, classId),
    likeNFTCollection.doc(iscnPrefixDocName).get(),
  ]);
  const nftDocData = nftDoc.data();
  let price = -1;
  let nextNewNFTId;
  const {
    currentPrice,
    currentBatch,
    lastSoldPrice,
  } = nftDocData;
  if (newNftData) {
    price = currentPrice;
    // This NFT ID represents a possible NFT of that NFT Class for purchasing only,
    // another fresh one might be used on purchase instead
    nextNewNFTId = newNftData.id;
  }
  const { price: nextPriceLevel } = getNFTBatchInfo(currentBatch + 1);
  return {
    ...nftDocData,
    nextNewNFTId,
    lastSoldPrice: lastSoldPrice || currentPrice,
    price,
    nextPriceLevel,
  };
}

export async function softGetLatestNFTPriceAndInfo(iscnPrefix, classId) {
  try {
    const priceInfo = await getLatestNFTPriceAndInfo(iscnPrefix, classId);
    return priceInfo;
  } catch (error) {
    return null;
  }
}

export function getGasPrice() {
  return new BigNumber(LIKER_NFT_GAS_FEE).multipliedBy(DEFAULT_GAS_PRICE).shiftedBy(-9).toNumber();
}

export async function checkWalletGrantAmount(granter, grantee, targetAmount) {
  const client = await getNFTQueryClient();
  const qs = await client.getQueryClient();
  let grant;
  try {
    const c = await qs.authz.grants(granter, grantee, '/cosmos.bank.v1beta1.MsgSend');
    if (!c) throw new ValidationError('GRANT_NOT_FOUND');
    ([grant] = c.grants.map(parseAuthzGrant));
  } catch (err) {
    if ((err as Error).message.includes('no authorization found')) {
      throw new ValidationError('GRANT_NOT_FOUND');
    }
    throw err;
  }
  if (!grant) throw new ValidationError('GRANT_NOT_FOUND');
  const { expiration, authorization } = grant;
  const { spendLimit } = authorization.value;
  const limit = spendLimit.find((s) => s.denom === NFT_COSMOS_DENOM);
  if (!limit) throw new ValidationError('SEND_GRANT_DENOM_NOT_FOUND');
  const { amount } = limit;
  const amountInLIKE = new BigNumber(amount).shiftedBy(-9);
  if (amountInLIKE.lt(targetAmount)) throw new ValidationError('GRANT_AMOUNT_NOT_ENOUGH');
  if (Date.now() + EXPIRATION_BUFFER_TIME > expiration * 1000) throw new ValidationError('GRANT_EXPIRED');
  return amountInLIKE.toFixed();
}

export async function checkTxGrantAndAmount(txHash, totalPrice, target = LIKER_NFT_TARGET_ADDRESS) {
  const client = await getNFTQueryClient();
  const q = await client.getStargateClient();
  const tx = await q.getTx(txHash);
  if (!tx) throw new Error('TX_NOT_FOUND');
  const parsed = parseTxInfoFromIndexedTx(tx);
  const { memo } = parsed.tx.body;
  let messages = parsed.tx.body.messages
    .filter((m) => m.typeUrl === '/cosmos.authz.v1beta1.MsgGrant');
  if (!messages.length) throw new ValidationError('GRANT_MSG_NOT_FOUND');
  messages = messages.filter((m) => m.value.grantee === target);
  if (!messages.length) throw new ValidationError('INCORRECT_GRANT_TARGET');
  const message = messages.find((m) => m.value.grant.authorization.typeUrl === '/cosmos.bank.v1beta1.SendAuthorization');
  if (!message) throw new ValidationError('SEND_GRANT_NOT_FOUND');
  const { granter } = message.value;
  const amountInLIKEString = await checkWalletGrantAmount(granter, target, totalPrice);
  const balance = await q.getBalance(granter, NFT_COSMOS_DENOM);
  const balanceAmountInLIKE = new BigNumber(balance.amount || 0).shiftedBy(-9);
  if (balanceAmountInLIKE.lt(totalPrice)) throw new ValidationError('GRANTER_AMOUNT_NOT_ENOUGH');
  return {
    memo,
    granter,
    spendLimit: new BigNumber(amountInLIKEString).toNumber(),
  };
}

async function calculateLIKEAndPopulateTxMsg({
  iscnData,
  classId,
  nftId,
  nftPrice,
  sellerWallet,
  buyerWallet,
  granterWallet,
  feeWallet,
}) {
  const STAKEHOLDERS_RATIO = 1 - FEE_RATIO;
  const SELLER_RATIO = 1 - FEE_RATIO - STAKEHOLDERS_RATIO;
  const gasFee = getGasPrice();
  const { owner, data } = iscnData;
  const totalPrice = nftPrice + gasFee;
  const totalAmount = new BigNumber(totalPrice).shiftedBy(9).toFixed(0);
  const feeAmount = new BigNumber(nftPrice)
    .multipliedBy(FEE_RATIO).shiftedBy(9).toFixed(0);
  const sellerAmount = new BigNumber(nftPrice)
    .multipliedBy(SELLER_RATIO).shiftedBy(9).toFixed(0);
  const stakeholdersAmount = new BigNumber(nftPrice)
    .multipliedBy(STAKEHOLDERS_RATIO).shiftedBy(9).toFixed(0);
  const transferMessages: any = [];
  if (sellerAmount && new BigNumber(sellerAmount).gt(0)) {
    transferMessages.push({
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: LIKER_NFT_TARGET_ADDRESS,
        toAddress: sellerWallet,
        amount: [{ denom: NFT_COSMOS_DENOM, amount: sellerAmount }],
      },
    });
  }
  if (feeAmount && new BigNumber(feeAmount).gt(0)) {
    transferMessages.push({
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: LIKER_NFT_TARGET_ADDRESS,
        toAddress: feeWallet,
        amount: [{ denom: NFT_COSMOS_DENOM, amount: feeAmount }],
      },
    });
  }

  const stakeholderMap = await parseAndCalculateStakeholderRewards(
    data,
    owner,
    { totalAmount: stakeholdersAmount, precision: 0 },
  );
  stakeholderMap.forEach(({ amount }, wallet) => {
    transferMessages.push(
      {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: LIKER_NFT_TARGET_ADDRESS,
          toAddress: wallet,
          // TODO: fix iscn-js to use string for amount input and output
          amount: [{
            denom: NFT_COSMOS_DENOM,
            amount,
          }],
        },
      },
    );
  });
  const txMessages = [
    formatMsgExecSendAuthorization(
      LIKER_NFT_TARGET_ADDRESS,
      granterWallet,
      LIKER_NFT_TARGET_ADDRESS,
      [{ denom: NFT_COSMOS_DENOM, amount: totalAmount }],
    ),
    formatMsgSend(
      LIKER_NFT_TARGET_ADDRESS,
      buyerWallet,
      classId,
      nftId,
    ),
    ...transferMessages,
  ];
  const sellerLIKE = new BigNumber(sellerAmount).shiftedBy(-9).toFixed();
  const feeLIKE = new BigNumber(feeAmount).shiftedBy(-9).toFixed();
  const stakeholderWallets = [...stakeholderMap.keys()];
  const stakeholderLIKEs = [...stakeholderMap.values()]
    .map((a) => new BigNumber(a.amount).shiftedBy(-9).toFixed());
  return {
    txMessages,
    sellerLIKE,
    feeLIKE,
    stakeholderWallets,
    stakeholderLIKEs,
    gasFee,
  };
}

async function handleNFTPurchaseTransaction(txMessages, memo) {
  let res;
  const signingClient = await getLikerNFTSigningClient();
  const client = signingClient.getSigningStargateClient();
  if (!client) throw new Error('CANNOT_GET_SIGNING_CLIENT');
  const fee = calculateTxGasFee(txMessages.length, NFT_COSMOS_DENOM);
  const { address, accountNumber } = await getLikerNFTSigningAddressInfo();
  const txSigningFunction = ({ sequence }) => client.sign(
    address,
    txMessages,
    fee,
    memo,
    {
      accountNumber,
      sequence,
      chainId: NFT_CHAIN_ID,
    },
  );
  try {
    res = await sendTransactionWithSequence(
      address,
      txSigningFunction,
      client,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    throw new ValidationError(err);
  }
  const { transactionHash, code, rawLog } = res;
  if (code !== 0) {
    // eslint-disable-next-line no-console
    console.error(`Tx ${transactionHash} failed with code ${code}`);
    if (code === 4 && rawLog.includes('is not the owner of nft')) {
      throw new ValidationError('NFT_NOT_OWNED_BY_API_WALLET');
    } else {
      throw new ValidationError('TX_NOT_SUCCESS');
    }
  }

  return transactionHash;
}

async function updateDocsForSuccessPurchase(t, {
  iscnRef,
  classRef,
  nftRef,
  classId,
  nftId,
  sellerWallet,
  buyerWallet,
  granterWallet,
  currentBatch,
  nftPrice,
  timestamp,
  txHash,
  memo,
  grantTxHash,
  granterMemo,
  sellerLIKE,
  stakeholderWallets,
  stakeholderLIKEs,
}) {
  const doc = await t.get(iscnRef);
  const docData = doc.data();
  const {
    currentPrice: dbCurrentPrice,
    currentBatch: dbCurrentBatch,
    batchRemainingCount: dbBatchRemainingCount,
    processingCount: dbProcessingCount,
  } = docData;
  const fromWallet = LIKER_NFT_TARGET_ADDRESS;
  const toWallet = buyerWallet;
  let updatedBatch = dbCurrentBatch;
  let batchRemainingCount = dbBatchRemainingCount;
  let newPrice = dbCurrentPrice;
  let processingCount = dbProcessingCount;
  if (dbCurrentBatch === currentBatch) {
    processingCount = FieldValue.increment(-1);
    batchRemainingCount -= 1;
    const isNewBatch = batchRemainingCount <= 0;
    if (isNewBatch) {
      processingCount = 0;
      updatedBatch = dbCurrentBatch + 1;
      ({ price: newPrice, count: batchRemainingCount } = getNFTBatchInfo(updatedBatch));
    }
  }
  t.update(iscnRef, {
    currentPrice: newPrice,
    currentBatch: updatedBatch,
    batchRemainingCount,
    processingCount,
    soldCount: FieldValue.increment(1),
    nftRemainingCount: FieldValue.increment(-1),
    lastSoldPrice: nftPrice,
    lastSoldTimestamp: timestamp,
  });
  t.update(classRef, {
    lastSoldPrice: nftPrice,
    lastSoldNftId: nftId,
    lastSoldTimestamp: timestamp,
    soldCount: FieldValue.increment(1),
  });
  t.update(nftRef, {
    price: nftPrice,
    lastSoldPrice: nftPrice,
    soldCount: FieldValue.increment(1),
    isSold: true,
    isProcessing: false,
    ownerWallet: toWallet,
    lastSoldTimestamp: timestamp,
    sellerWallet: null,
  });
  t.create(iscnRef.collection('transaction')
    .doc(txHash), {
    event: 'purchase',
    txHash,
    grantTxHash,
    granterMemo,
    memo,
    price: nftPrice,
    classId,
    nftId,
    timestamp,
    fromWallet,
    toWallet,
    granterWallet,
    sellerWallet,
    sellerLIKE,
    stakeholderWallets,
    stakeholderLIKEs,
  });
}

async function fetchNFTSoldByAPIWalletEvent(classId: string, nftId: string) {
  const params = {
    class_id: classId,
    nft_id: nftId,
    sender: LIKER_NFT_TARGET_ADDRESS,
    action_type: '/cosmos.nft.v1beta1.MsgSend',
    'pagination.limit': 1,
    'pagination.reverse': true,
  };
  const { data: { events } } = await axios.get(`${COSMOS_LCD_INDEXER_ENDPOINT}/likechain/likenft/v1/event`, { params });
  return events.length ? events[0] : null;
}

function formatNFTEvent(event: any) {
  const timestamp = new Date(event.timestamp).getTime();
  // NOTE: event.price includes tx fee (e.g. 8002000000),
  // while price in DB does not, and  W.NFT is always sold in integer LIKE
  const price = Number(new BigNumber(event.price).shiftedBy(-9).toFixed(0));
  return {
    txHash: event.tx_hash,
    seller: event.sender,
    owner: event.receiver,
    memo: event.memo,
    timestamp,
    price,
  };
}

async function updateDocsForMissingSoldNFT(t, {
  iscnRef,
  classRef,
  classId,
  nftId,
  granterWallet,
  grantTxHash,
  granterMemo,
}) {
  const event = await fetchNFTSoldByAPIWalletEvent(classId, nftId);
  if (!event) {
    // eslint-disable-next-line no-console
    console.log(`API wallet sold event not found for NFT ${classId}/${nftId}`);
    return;
  }
  const {
    txHash,
    seller,
    owner,
    memo,
    timestamp,
    price,
  } = formatNFTEvent(event);
  const nftRef = classRef.collection('nft').doc(nftId);
  // intend to update NFT and transaction docs only, ISCN and class docs remain unchanged
  t.update(nftRef, {
    price,
    lastSoldPrice: price,
    soldCount: FieldValue.increment(1),
    isSold: true,
    isProcessing: false,
    ownerWallet: owner,
    lastSoldTimestamp: timestamp,
    sellerWallet: null,
  });
  t.create(iscnRef.collection('transaction')
    .doc(txHash), {
    event: 'purchase',
    txHash,
    grantTxHash,
    granterMemo,
    memo,
    price,
    classId,
    nftId,
    timestamp,
    fromWallet: seller,
    toWallet: owner,
    granterWallet,
  });
}

export async function processNFTPurchase({
  buyerWallet,
  iscnPrefix,
  classId,
  granterWallet = buyerWallet,
  grantedAmount,
  grantTxHash = '',
  granterMemo = '',
  retryTimes = 0,
}, req) {
  const iscnData = await getNFTISCNData(iscnPrefix); // always fetch from prefix
  if (!iscnData) throw new ValidationError('ISCN_DATA_NOT_FOUND');
  const { owner: sellerWallet } = iscnData;
  const iscnPrefixDocName = getISCNPrefixDocName(iscnPrefix);
  const iscnRef = likeNFTCollection.doc(iscnPrefixDocName);
  const classRef = iscnRef.collection('class').doc(classId);
  const classDoc = await classRef.get();
  const {
    metadata: {
      message = '',
    } = {},
  } = classDoc.data();
  let memo = message.replaceAll('{collector}', buyerWallet) || '';
  memo = Buffer.byteLength(memo, 'utf8') > MAX_MEMO_LENGTH ? Buffer.from(memo).slice(0, MAX_MEMO_LENGTH).toString() : memo;
  if (!iscnData) throw new ValidationError('CLASS_DATA_NOT_FOUND');

  // lock iscn nft
  const {
    nftId,
    nftPrice,
    currentBatch,
  } = await db.runTransaction(async (t) => {
    /* eslint-disable no-underscore-dangle */
    const nftDocData = await getFirstUnsoldNFT(iscnPrefixDocName, classId, { transaction: t });
    const {
      id: _nftId, isProcessing,
    } = nftDocData;
    if (isProcessing) throw new ValidationError('ANOTHER_PURCHASE_IN_PROGRESS');
    const doc = await t.get(iscnRef);
    const docData = doc.data();
    if (!docData) throw new ValidationError('ISCN_NFT_NOT_FOUND');
    const {
      processingCount = 0,
      currentPrice,
      currentBatch: batch,
      batchRemainingCount,
    } = docData;
    if (processingCount >= batchRemainingCount) {
      throw new ValidationError('ANOTHER_PURCHASE_IN_PROGRESS');
    }
    t.update(iscnRef, { processingCount: FieldValue.increment(1) });
    if (currentPrice > grantedAmount) {
      throw new ValidationError('GRANT_NOT_MATCH_UPDATED_PRICE');
    }
    const txNftRef = classRef.collection('nft').doc(_nftId);
    t.update(txNftRef, { isProcessing: true });
    return {
      nftId: _nftId,
      nftPrice: currentPrice,
      currentBatch: batch,
    };
    /* eslint-enable no-underscore-dangle */
  });
  const nftRef = classRef.collection('nft').doc(nftId);
  try {
    const feeWallet = LIKER_NFT_FEE_ADDRESS;
    const {
      txMessages,
      sellerLIKE,
      feeLIKE,
      stakeholderWallets,
      stakeholderLIKEs,
      gasFee,
    } = await calculateLIKEAndPopulateTxMsg({
      iscnData,
      nftPrice,
      sellerWallet,
      feeWallet,
      granterWallet,
      buyerWallet,
      classId,
      nftId,
    });
    const txHash = await handleNFTPurchaseTransaction(txMessages, memo);
    const timestamp = Date.now();

    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'LikerNFTPurchaseTransaction',
      txHash,
      iscnId: iscnPrefix,
      classId,
      nftId,
      buyerWallet,
    });

    await db.runTransaction(async (t) => {
      await updateDocsForSuccessPurchase(t, {
        iscnRef,
        classRef,
        nftRef,
        classId,
        nftId,
        sellerWallet,
        buyerWallet,
        granterWallet,
        currentBatch,
        nftPrice,
        timestamp,
        txHash,
        memo,
        grantTxHash,
        granterMemo,
        sellerLIKE,
        stakeholderWallets,
        stakeholderLIKEs,
      });
    });
    return {
      transactionHash: txHash,
      classId,
      nftId,
      nftPrice,
      gasFee,
      sellerWallet,
      sellerLIKE,
      stakeholderWallets,
      stakeholderLIKEs,
      feeWallet,
      feeLIKE,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    // reset lock
    const shouldRetryPurchase = await db.runTransaction(async (t) => {
      const doc = await t.get(iscnRef);
      const docData = doc.data();
      const { currentBatch: docCurrentBatch } = docData;
      if (docCurrentBatch === currentBatch) {
        t.update(iscnRef, { processingCount: FieldValue.increment(-1) });
      }
      // eslint-disable-next-line no-underscore-dangle
      const shouldUpdateSoldNFT = (
        err instanceof ValidationError
        && err.message === 'NFT_NOT_OWNED_BY_API_WALLET'
      );
      if (shouldUpdateSoldNFT) {
        await updateDocsForMissingSoldNFT(t, {
          iscnRef,
          classRef,
          classId,
          nftId,
          granterWallet,
          grantTxHash,
          granterMemo,
        });
      }
      t.update(nftRef, { isProcessing: false });
      return shouldUpdateSoldNFT && retryTimes < 1;
    });
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'LikerNFTPurchaseError',
      iscnId: iscnPrefix,
      classId,
      nftId,
      buyerWallet,
    });
    if (shouldRetryPurchase) {
      return processNFTPurchase({
        buyerWallet,
        iscnPrefix,
        classId,
        granterWallet,
        grantedAmount,
        grantTxHash,
        granterMemo,
        retryTimes: retryTimes + 1,
      }, req);
    }
    throw err;
  }
}
