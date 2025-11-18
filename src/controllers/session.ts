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

  if (sessionExists(sessionId)) {
    const existing = getSession(sessionId)!;
    const status = getSessionStatus(existing);
    // If session is authenticated, don't allow creating again
    if (status === 'AUTHENTICATED') return res.status(400).json({ error: 'Session already exists' });
    // otherwise try to (re)create to get a fresh QR — do not force destroy to avoid data loss
  }

  // createSession will return the QR via the provided `res` when available
  createSession({ sessionId, res, readIncomingMessages, socketConfig });
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
  createSession({ sessionId, res, SSE: true });
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
