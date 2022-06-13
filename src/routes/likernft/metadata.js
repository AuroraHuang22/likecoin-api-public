import { Router } from 'express';
import { ONE_DAY_IN_S } from '../../constant';
import { likeNFTCollection } from '../../util/firebase';
import { ValidationError } from '../../util/ValidationError';
import { filterLikeNFTMetadata } from '../../util/ValidationHelper';
import { getISCNPrefixDocName } from '../../util/api/likernft/mint';
import { getLikerNFTDynamicData, getDynamicNFTImage } from '../../util/api/likernft/metadata';

const router = Router();

router.get(
  '/metadata',
  async (req, res, next) => {
    try {
      const {
        iscn_id: iscnId,
        class_id: inputClassId,
        // nft_id: nftId, // not used since all nft in a class use same metadata
      } = req.query;

      let classId = inputClassId;
      let classData;
      if (!classId && !iscnId) {
        throw new ValidationError('PLEASE_DEFINE_QUERY_ID');
      }
      if (iscnId) {
        let classDocRef;
        if (!classId) {
          const iscnPrefix = getISCNPrefixDocName(iscnId);
          const iscnDoc = await likeNFTCollection.doc(iscnPrefix).get();
          const iscnData = iscnDoc.data();
          if (!iscnData || !iscnData.classId) {
            res.status(404).send('ISCN_NFT_NOT_FOUND');
            return;
          }
          ({ classId } = iscnData);
          classDocRef = likeNFTCollection.doc(iscnPrefix).collection('class').doc(iscnData.classId);
        } else {
          const iscnPrefix = getISCNPrefixDocName(iscnId);
          classDocRef = likeNFTCollection.doc(iscnPrefix).collection('class').doc(classId);
        }
        classData = await classDocRef.get();
      } else {
        const query = await likeNFTCollection.collectionGroup('class').where('id', '==', classId).limit(1).get();
        if (!query.docs.length) {
          res.status(404).send('NFT_CLASS_NOT_FOUND');
          return;
        }
        classData = query.docs[0].data();
      }
      if (!classData) {
        res.status(404).send('NFT_DATA_NOT_FOUND');
        return;
      }
      const dynamicData = await getLikerNFTDynamicData(classId, classData);
      res.set('Cache-Control', `public, max-age=${60}, s-maxage=${60}, stale-if-error=${ONE_DAY_IN_S}`);
      res.json(filterLikeNFTMetadata({
        ...classData.metadata,
        ...dynamicData,
      }));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/metadata/image/class_(:classId)(.png)?',
  async (req, res, next) => {
    try {
      const { classId } = req.params;
      const query = await likeNFTCollection.collectionGroup('class').where('id', '==', classId).limit(1).get();
      if (!query.docs.length) {
        res.status(404).send('NFT_CLASS_NOT_FOUND');
        return;
      }
      const queryRef = query.docs[0];
      const classData = queryRef.data();
      // const iscnRef = queryRef.parent.parent;
      // const iscnDocRef = iscnDataRef.get();
      // const iscnData = await iscnDocRef();
      const dynamicData = await getDynamicNFTImage(classId, classData);
      res.set('Cache-Control', `public, max-age=${60}, s-maxage=${60}, stale-if-error=${ONE_DAY_IN_S}`);
      res.type('png').send(dynamicData);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
