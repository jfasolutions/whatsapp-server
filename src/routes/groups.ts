import { Router } from 'express';
import { query } from 'express-validator';
import * as controller from '../controllers/group.js';
import requestValidator from '../middlewares/request-validator.js';
import sessionValidator from '../middlewares/session-validator.js';

const router = Router({ mergeParams: true });
router.get(
  '/',
  query('cursor').isNumeric().optional(),
  query('limit').isInt({ min: 1, max: 100 }).optional(),
  requestValidator,
  controller.list
);
router.get('/:jid', sessionValidator, controller.find);
router.get('/:jid/photo', sessionValidator, controller.photo);

export default router;
