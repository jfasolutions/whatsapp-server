import type { ConnectionState, proto, SocketConfig, WASocket } from '@whiskeysockets/baileys';
// Use dynamic import for runtime values from baileys (ESM-only) inside createSession
import type { Boom } from '@hapi/boom';
import { initStore, Store, useSession } from './repository/index.js';
//import { useSession } from '@f3lpz/baileys-store';
import type { Response } from 'express';
import { toDataURL } from 'qrcode';
import type { WebSocket } from 'ws';
import { logger, prisma } from './shared.js';
import { delay } from './utils.js';

type Session = WASocket & {
  destroy: () => Promise<void>;
  store: Store;
};

const sessions = new Map<string, Session>();
const retries = new Map<string, number>();
const SSEQRGenerations = new Map<string, number>();

const RECONNECT_INTERVAL = Number(process.env.RECONNECT_INTERVAL || 0);
const MAX_RECONNECT_RETRIES = Number(process.env.MAX_RECONNECT_RETRIES || 5);
const SSE_MAX_QR_GENERATION = Number(process.env.SSE_MAX_QR_GENERATION || 5);
const SESSION_CONFIG_ID = 'session-config';

export async function init() {
  await initStore({ prisma, logger });
  const sessions = await prisma.session.findMany({
    select: { sessionId: true, data: true },
    where: { id: { startsWith: SESSION_CONFIG_ID } },
  });

  for (const { sessionId, data } of sessions) {
    const { readIncomingMessages, ...socketConfig } = JSON.parse(data);
    createSession({ sessionId, readIncomingMessages, socketConfig });
  }
}

function shouldReconnect(sessionId: string) {
  let attempts = retries.get(sessionId) ?? 0;

  if (attempts < MAX_RECONNECT_RETRIES) {
    attempts += 1;
    retries.set(sessionId, attempts);
    return true;
  }
  return false;
}

type createSessionOptions = {
  sessionId: string;
  res?: Response;
  SSE?: boolean;
  readIncomingMessages?: boolean;
  socketConfig?: SocketConfig;
};

export async function createSession(options: createSessionOptions) {
  const { sessionId, res, SSE = false, readIncomingMessages = false, socketConfig } = options;
  const configID = `${SESSION_CONFIG_ID}-${sessionId}`;
  // Dynamically import baileys runtime helpers to avoid require() of ESM module
  const baileys = await import('@whiskeysockets/baileys');
  // makeWASocket may be the default export
  // cast to any to avoid circular type issues at runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeWASocket: any = baileys.default ?? (baileys as any).makeWASocket;
  const { Browsers, DisconnectReason, isJidBroadcast, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } =
    baileys as any;
  const { version } = await fetchLatestBaileysVersion();
  let connectionState: Partial<ConnectionState> = { connection: 'close' };
  // immediate console log to ensure we always see when a session creation starts
  // eslint-disable-next-line no-console
  console.log(`createSession START sessionId=${sessionId} SSE=${SSE} readIncoming=${readIncomingMessages}`);
  logger.info({ sessionId, SSE, readIncomingMessages }, 'Starting createSession');

  const destroy = async (logout = true) => {
    try {
      await Promise.all([
        logout && socket.logout(),
        prisma.chat.deleteMany({ where: { sessionId } }),
        prisma.contact.deleteMany({ where: { sessionId } }),
        prisma.message.deleteMany({ where: { sessionId } }),
        prisma.groupMetadata.deleteMany({ where: { sessionId } }),
        prisma.session.deleteMany({ where: { sessionId } }),
      ]);
    } catch (e) {
      logger.error(e, 'An error occurred during session destroy');
    } finally {
      sessions.delete(sessionId);
    }
  };

  const handleConnectionClose = () => {
    const code = (connectionState.lastDisconnect?.error as Boom)?.output?.statusCode;
    const restartRequired = code === DisconnectReason.restartRequired;
    const doNotReconnect = !shouldReconnect(sessionId);
    // eslint-disable-next-line no-console
    console.log(`handleConnectionClose sessionId=${sessionId} code=${code} restartRequired=${restartRequired} doNotReconnect=${doNotReconnect}`);
    // print lastDisconnect for debugging
    // eslint-disable-next-line no-console
    console.log('lastDisconnect:', connectionState.lastDisconnect);
    logger.info({ sessionId, code, restartRequired, doNotReconnect }, 'Connection closed');

    if (code === DisconnectReason.loggedOut || doNotReconnect) {
      if (res) {
        !SSE && !res.headersSent && res.status(500).json({ error: 'Unable to create session' });
        res.end();
      }
      destroy(doNotReconnect);
      return;
    }

    if (!restartRequired) {
      logger.info({ attempts: retries.get(sessionId) ?? 1, sessionId }, 'Reconnecting...');
    }
    setTimeout(() => createSession(options), restartRequired ? 0 : RECONNECT_INTERVAL);
  };

  const handleNormalConnectionUpdate = async () => {
    if (connectionState.qr?.length) {
      // eslint-disable-next-line no-console
      console.log(`connection.update QR for sessionId=${sessionId} qrLength=${connectionState.qr.length}`);
      logger.info({ sessionId, qrLength: connectionState.qr.length }, 'QR received in connection.update');
      if (res && !res.headersSent) {
        try {
          const qr = await toDataURL(connectionState.qr);
          logger.info({ sessionId, qrDataLength: qr.length }, 'QR converted to data URL; sending in HTTP response');
          res.status(200).json({ qr });
        } catch (e) {
          logger.error(e, 'An error occurred during QR generation');
          res.status(500).json({ error: 'Unable to generate QR' });
        }
        return;
      }
      // O QR já foi entregue na resposta HTTP. O WhatsApp gera um novo QR
      // a cada ~20s enquanto o usuário não escaneia (até uns 3 ciclos,
      // ~60s no total) — isso também dispara connection.update aqui. Antes
      // a sessão era destruída nesse ponto (por já não ter res disponível
      // pra responder de novo), matando o QR bem antes do cliente conseguir
      // ler/escanear. Só quem deve encerrar a sessão é o fechamento real da
      // conexão, tratado em handleConnectionClose.
    }
  };

  const handleSSEConnectionUpdate = async () => {
    let qr: string | undefined = undefined;
    if (connectionState.qr?.length) {
      logger.info({ sessionId, qrLength: connectionState.qr.length }, 'QR received in connection.update (SSE)');
      try {
        qr = await toDataURL(connectionState.qr);
        logger.info({ sessionId, qrDataLength: qr.length }, 'QR converted to data URL for SSE');
      } catch (e) {
        logger.error(e, 'An error occurred during QR generation');
      }
    }

    const currentGenerations = SSEQRGenerations.get(sessionId) ?? 0;
    if (!res || res.writableEnded || (qr && currentGenerations >= SSE_MAX_QR_GENERATION)) {
      res && !res.writableEnded && res.end();
      destroy();
      return;
    }

    const data = { ...connectionState, qr };
    if (qr) SSEQRGenerations.set(sessionId, currentGenerations + 1);
    logger.debug({ sessionId, data: { connection: connectionState.connection, hasQr: !!qr } }, 'Writing SSE data');
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const handleConnectionUpdate = SSE ? handleSSEConnectionUpdate : handleNormalConnectionUpdate;
  const { state, saveCreds } = await useSession(sessionId);
  logger.info({ sessionId, hasCreds: !!state?.creds }, 'Loaded session state');

  // Ensure user-provided socketConfig cannot force QR printing in terminal
  const finalSocketConfig = { ...(socketConfig || {}) };
  if ('printQRInTerminal' in finalSocketConfig) delete (finalSocketConfig as any).printQRInTerminal;

  const socket = makeWASocket({
    // Do not print QR in terminal; we'll return it via the HTTP response/SSE
    printQRInTerminal: false,
    version,
    auth: {
      creds: state.creds,
      // Sem isso, toda leitura de chave Signal (pre-key, session record, sender-key)
      // vai direto no MySQL — em cada mensagem enviada/recebida. O cache evita
      // reconsultar o banco pra chaves já lidas nesta sessão em memória.
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ["SendALL", "Chrome", "145.0.0"],
   //browser: Browsers.ubuntu('Chrome'),
   // generateHighQualityLinkPreview: true,
   // ...finalSocketConfig,
  logger,
  shouldIgnoreJid: (jid: string) => isJidBroadcast(jid),
  getMessage: async (key: any) => {
      const data = await prisma.message.findFirst({
        where: { remoteJid: key.remoteJid!, id: key.id!, sessionId },
      });
      return (data?.message || undefined) as proto.IMessage | undefined;
    },
  });
  logger.info({ sessionId }, 'Socket created');

  const store = new Store(sessionId, socket.ev);
  sessions.set(sessionId, { ...socket, destroy, store });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', (update: any) => {
    connectionState = update;
    const { connection } = update;

    if (connection === 'open') {
      retries.delete(sessionId);
      SSEQRGenerations.delete(sessionId);
    }
    if (connection === 'close') handleConnectionClose();
    handleConnectionUpdate();
  });

  if (readIncomingMessages) {
  socket.ev.on('messages.upsert', async (m: any) => {
      const message = m.messages[0];

      if (message.key.fromMe || m.type !== 'notify') return;

      await delay(1000);
      await socket.readMessages([message.key]);
    });
  }

  await prisma.session.upsert({
    create: {
      id: configID,
      sessionId,
      data: JSON.stringify({ readIncomingMessages, ...socketConfig }),
    },
    update: {},
    where: { sessionId_id: { id: configID, sessionId } },
  });
}

export function getSessionStatus(session: Session) {
  const state = ['CONNECTING', 'CONNECTED', 'DISCONNECTING', 'DISCONNECTED'];
  let status = state[(session.ws as unknown as WebSocket).readyState];
  status = session.user ? 'AUTHENTICATED' : status;
  return status;
}

export function listSessions() {
  return Array.from(sessions.entries()).map(([id, session]) => ({
    id,
    status: getSessionStatus(session),
  }));
}

export function getSession(sessionId: string) {
  return sessions.get(sessionId);
}

export async function deleteSession(sessionId: string) {
  sessions.get(sessionId)?.destroy();
}

export function sessionExists(sessionId: string) {
  return sessions.has(sessionId);
}

export async function jidExists(
  session: Session,
  jid: string,
  type: 'group' | 'number' = 'number'
) {
  try {
      if (type === 'number') {
      const resultArray = await session.onWhatsApp(jid);
      const result = resultArray?.[0] ?? null;
      return result?.jid || null;
    }

    const groupMeta = await session.groupMetadata(jid);
    return !!groupMeta.id;
  } catch (e) {
    return Promise.reject(e);
  }
}

export async function getJid(
  session: Session,
  jid: string,
  type: 'group' | 'number' = 'number'
) {
  try {
    if (type === 'number') {
      const resultArray = await session.onWhatsApp(jid);
      const result = resultArray?.[0] ?? null;
      return result?.jid || null;
    }

    const groupMeta = await session.groupMetadata(jid);
    return groupMeta.id;
  } catch (e) {
    return Promise.reject(e);
  }
}
