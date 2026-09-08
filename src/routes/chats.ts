import { Router } from 'express';
import { query } from 'express-validator';
import * as controller from '../controllers/chat.js';
import requestValidator from '../middlewares/request-validator.js';

const router = Router({ mergeParams: true });
router.get(
  '/',
  query('cursor').isNumeric().optional(),
  query('limit').isInt({ min: 1, max: 100 }).optional(),
  requestValidator,
  controller.list
);
router.get(
  '/:jid',
  query('cursor').isNumeric().optional(),
  query('limit').isInt({ min: 1, max: 100 }).optional(),
  requestValidator,
  controller.find
);

export default router;
