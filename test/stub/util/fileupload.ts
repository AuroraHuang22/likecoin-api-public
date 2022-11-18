/* eslint-disable import/no-unresolved */
/* eslint-disable import/extensions */
import axios from 'axios';
import sharp from 'sharp';
import fileType from 'file-type';
import { sha256 } from 'js-sha256';
import md5 from 'md5-hex';
import {
  IS_TESTNET,
  SUPPORTED_AVATAR_TYPE,
// eslint-disable-next-line @typescript-eslint/ban-ts-ignore
// @ts-ignore
} from '../constant';
// eslint-disable-next-line @typescript-eslint/ban-ts-ignore
// @ts-ignore
import { ValidationError } from './ValidationError';

export function uploadFileAndGetLink() {
  return 'fakeAvatarUrl';
}

export async function handleAvatarUploadAndGetURL(user, file, avatarSHA256) {
  const type = fileType(file.buffer);
  if (!type || !SUPPORTED_AVATAR_TYPE.has(type && type.ext)) {
    throw new ValidationError(`unsupported file format! ${(type || {}).ext || JSON.stringify(type)}`);
  }

  if (avatarSHA256) {
    const hash256 = sha256(file.buffer);
    if (hash256 !== avatarSHA256) throw new ValidationError('avatar sha not match');
  }

  const resizedBuffer = await sharp(file.buffer).resize(400, 400).toBuffer();
  file.buffer = resizedBuffer; // eslint-disable-line no-param-reassign
  const [avatarUrl] = uploadFileAndGetLink();
  const versionHash = md5(file.buffer).substring(0, 7);
  return `${avatarUrl}&${versionHash}`;
}

export async function handleAvatarLinkAndGetURL(user, url) {
  let { data } = await axios.get(url, {
    responseType: 'stream',
    timeout: 5000,
  });
  data = await fileType.stream(data);
  const type = data.fileType;
  if (!type || !SUPPORTED_AVATAR_TYPE.has(type && type.ext)) {
    throw new ValidationError(`unsupported file format! ${(type || {}).ext || JSON.stringify(type)}`);
  }
  let transformer = sharp();
  transformer = transformer.resize(400, 400);
  data.pipe(transformer);
  const [avatarUrl] = uploadFileAndGetLink();
  return avatarUrl;
}

export default uploadFileAndGetLink;
