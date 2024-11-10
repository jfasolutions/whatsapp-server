import { Router } from 'express';
import { body } from 'express-validator';
import * as controller from '../controllers/session';
import requestValidator from '../middlewares/request-validator';
import sessionValidator from '../middlewares/session-validator';

const router = Router();
router.get('/', controller.list);
router.get('/:sessionId', sessionValidator, controller.find);
router.get('/:sessionId/status', sessionValidator, controller.status);
router.post('/add', body('sessionId').isString().notEmpty(), requestValidator, controller.add);
router.get('/:sessionId/add-sse', controller.addSSE);
router.post('/:sessionId/webhook', controller.addWebhook);
router.delete('/:sessionId/webhook', controller.deleteWebhook);
router.delete('/:sessionId', sessionValidator, controller.del);

export default router;
