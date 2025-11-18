import type { RequestHandler } from 'express';
import {
  createSession,
  deleteSession,
  getSession,
  getSessionStatus,
  listSessions,
  sessionExists,
} from '../wa.js';

import { useLogger, usePrisma } from '../repository/shared.js';

export const list: RequestHandler = (req, res) => {
  res.status(200).json(listSessions());
};

export const find: RequestHandler = (req, res) =>
  res.status(200).json({ message: 'Session found' });

export const status: RequestHandler = (req, res) => {
  const session = getSession(req.params.sessionId)!;
  res.status(200).json({ status: getSessionStatus(session) });
};

export const add: RequestHandler = async (req, res) => {
  const { sessionId, readIncomingMessages, ...socketConfig } = req.body;

  const logger = useLogger();
  logger.info({ sessionId, socketConfigProvided: !!Object.keys(socketConfig || {}).length }, 'Received request to add session');

  if (sessionExists(sessionId)) {
    const existing = getSession(sessionId)!;
    const status = getSessionStatus(existing);
    logger.info({ sessionId, status }, 'Session exists');
    // If session is authenticated, don't allow creating again
    if (status === 'AUTHENTICATED') {
      logger.warn({ sessionId }, 'Attempt to create already authenticated session');
      return res.status(400).json({ error: 'Session already exists' });
    }
    // otherwise try to (re)create to get a fresh QR — do not force destroy to avoid data loss
  }

  // createSession will return the QR via the provided `res` when available
  try {
    logger.info({ sessionId }, 'Creating session (will respond with QR when available)');
    createSession({ sessionId, res, readIncomingMessages, socketConfig });
  } catch (e) {
    logger.error(e, 'Error while creating session');
    res.status(500).json({ error: 'Unable to create session' });
  }
};

export const addSSE: RequestHandler = async (req, res) => {
  const { sessionId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (sessionExists(sessionId)) {
    const existing = getSession(sessionId)!;
    const status = getSessionStatus(existing);
    if (status === 'AUTHENTICATED') {
      res.write(`data: ${JSON.stringify({ error: 'Session already exists' })}\n\n`);
      res.end();
      return;
    }
  }
  const logger = useLogger();
  logger.info({ sessionId }, 'Creating session via SSE (will stream QR updates)');
  try {
    createSession({ sessionId, res, SSE: true });
  } catch (e) {
    logger.error(e, 'Error while creating session via SSE');
    res.write(`data: ${JSON.stringify({ error: 'Unable to create session' })}\n\n`);
    res.end();
  }
};

export const del: RequestHandler = async (req, res) => {
  await deleteSession(req.params.sessionId);
  res.status(200).json({ message: 'Session deleted' });
};

export const addWebhook: RequestHandler = async (req, res) => {
  const { sessionId } = req.params;
  const prisma = usePrisma();
  const logger = useLogger();
  logger.info('upserting webhook');
  await prisma.webhook.upsert({
    select: { pkId: true },
    create: { ...req.body, sessionId },
    update: { ...req.body },
    where: { sessionId: sessionId!},
  });
  res.status(200).json({ status: 'created' });
};

export const deleteWebhook: RequestHandler = async (req, res) => {
  const { sessionId } = req.params;
  const prisma = usePrisma();
  try {
    await prisma.webhook.delete({  
      where: { sessionId: sessionId!},
    });
  } catch (e) {

  }
  res.status(200).json({ status: 'deleted' });
};
