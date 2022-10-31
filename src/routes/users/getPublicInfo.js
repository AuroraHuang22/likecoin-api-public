import { Router } from 'express';
import axios from 'axios';
import sharp from 'sharp';
import { ValidationError } from '../../util/ValidationError';
import {
  filterUserDataMin,
} from '../../util/ValidationHelper';
import {
  getUserWithCivicLikerProperties,
  getUserAvatar,
  getUserWithCivicLikerPropertiesByWallet,
} from '../../util/api/users/getPublicInfo';
import { ONE_DAY_IN_S, DEFAULT_AVATAR_SIZE } from '../../constant';

const router = Router();

router.get('/id/:id/min', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type } = req.query;
    let types = [];
    if (type) {
      types = type.split(',');
    }
    const payload = await getUserWithCivicLikerProperties(id);
    if (!payload) {
      res.sendStatus(404);
      return;
    }
    res.set('Cache-Control', 'public, max-age=30');
    res.json(filterUserDataMin(payload, types));
  } catch (err) {
    next(err);
  }
});


router.get('/id/:id/avatar', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { size: inputSizeStr = DEFAULT_AVATAR_SIZE } = req.query;
    const inputSizeNum = parseInt(inputSizeStr, 10);
    if (Number.isNaN(inputSizeNum)) {
      throw new ValidationError('Invalid size');
    }
    const size = Math.min(Math.max(inputSizeNum, 1), 1920);

    const avatar = await getUserAvatar(id);
    if (!avatar) {
      res.sendStatus(404);
      return;
    }
    const { headers, data } = await axios.get(avatar, {
      responseType: 'stream',
    });
    const resizer = sharp().resize(size, size);
    const cacheTime = 3600;
    res.set('Cache-Control', `public, max-age=${cacheTime}, s-maxage=${cacheTime}, stale-if-error=${ONE_DAY_IN_S}`);
    res.type(headers['content-type'] || 'image/jpeg');
    data.pipe(resizer).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get('/addr/:addr/min', async (req, res, next) => {
  try {
    const { addr } = req.params;
    const { type } = req.query;
    let types = [];
    if (type) {
      types = type.split(',');
    }
    const payload = await getUserWithCivicLikerPropertiesByWallet(addr);
    if (!payload) {
      res.sendStatus(404);
      return;
    }
    res.set('Cache-Control', 'public, max-age=30');
    res.json(filterUserDataMin(payload, types));
  } catch (err) {
    next(err);
  }
});

export default router;
