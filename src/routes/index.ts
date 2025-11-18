import { Router } from 'express';
import chatRoutes from './chats.js';
import contactRoutes from './contacts.js';
import groupRoutes from './groups.js';
import messageRoutes from './messages.js';
import sessionRoutes from './sessions.js';

const router = Router();
router.use('/sessions', sessionRoutes);
router.use('/:sessionId/chats', chatRoutes);
router.use('/:sessionId/contacts', contactRoutes);
router.use('/:sessionId/groups', groupRoutes);
router.use('/:sessionId/messages', messageRoutes);

export default router;
