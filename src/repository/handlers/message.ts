import type {
  BaileysEventEmitter,
  MessageUserReceipt,
  proto,
  WAMessageKey,
} from '@whiskeysockets/baileys';
// Avoid static import of ESM-only package; use dynamic import where runtime helpers are needed
import { useLogger, usePrisma } from '../shared.js';
import type { BaileysEventHandler } from '../types.js';
import { transformPrisma } from '../utils.js';
import axios from 'axios';

const getKeyAuthor = (key: WAMessageKey | undefined | null) =>
  (key?.fromMe ? 'me' : key?.participant || key?.remoteJid) || '';

/**
 * Nada no whats-api lê o conteúdo de mensagens recebidas do banco — a entrega
 * real acontece pelo webhook logo abaixo. Persistimos só o necessário pro
 * funcionamento do protocolo:
 *  - mensagens enviadas por nós (fromMe): a Baileys usa `getMessage()` (wa.ts)
 *    pra reenviar quando o destinatário pede retry de decriptação;
 *  - mensagens de criação de enquete: necessárias pra somar votos depois
 *    (getAggregateVotesInPollMessage precisa do conteúdo original).
 * Mensagem recebida comum (texto/mídia) não precisa virar linha no MySQL.
 */
function shouldPersist(message: proto.IWebMessageInfo): boolean {
  if (message.key?.fromMe) return true;
  const content = message.message;
  return !!(
    content?.pollCreationMessage ||
    content?.pollCreationMessageV2 ||
    content?.pollCreationMessageV3
  );
}

// Cache do webhook por sessão, invalidado por invalidateWebhookCache() quando
// o webhook é criado/removido (ver controllers/session.ts). Evita 1 SELECT
// por mensagem recebida só pra saber a URL de entrega.
const webhookUrlCache = new Map<string, string | null>();

export function invalidateWebhookCache(sessionId: string) {
  webhookUrlCache.delete(sessionId);
}

async function getWebhookUrl(sessionId: string): Promise<string | null> {
  if (webhookUrlCache.has(sessionId)) return webhookUrlCache.get(sessionId)!;

  const prisma = usePrisma();
  const webhook = await prisma.webhook.findFirst({ where: { sessionId } });
  const url = webhook?.url ?? null;
  webhookUrlCache.set(sessionId, url);
  return url;
}

// Dedupe do envio de webhook em memória (a Baileys pode reemitir o mesmo id
// em reconexões). Como mensagem comum não vai mais pro banco, não dá mais
// pra usar "já existe no banco?" como dedupe — por isso esse cache local,
// limitado em tamanho (FIFO) pra não crescer indefinidamente.
const recentlyForwarded = new Map<string, true>();
const MAX_DEDUPE_ENTRIES = 5000;

function markForwarded(dedupeKey: string): boolean {
  if (recentlyForwarded.has(dedupeKey)) return false;

  recentlyForwarded.set(dedupeKey, true);
  if (recentlyForwarded.size > MAX_DEDUPE_ENTRIES) {
    const oldestKey = recentlyForwarded.keys().next().value;
    if (oldestKey !== undefined) recentlyForwarded.delete(oldestKey);
  }
  return true;
}

export default function messageHandler(sessionId: string, event: BaileysEventEmitter) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ messages, isLatest }) => {
    try {
      const validMessages = messages.filter(
        (m) => m.key?.id && m.key?.remoteJid && shouldPersist(m)
      );

      await prisma.$transaction(async (tx) => {
        if (isLatest) await tx.message.deleteMany({ where: { sessionId } });

        if (validMessages.length) {
          await tx.message.createMany({
            data: validMessages.map((message) => ({
              ...transformPrisma(message),
              key: message.key as unknown as object,
              remoteJid: message.key.remoteJid!,
              id: message.key.id!,
              sessionId,
            })),
          });
        }
      });
      logger.info(
        { received: messages.length, stored: validMessages.length },
        'Synced messages'
      );
    } catch (e) {
      logger.error(e, 'An error occured during messages set');
    }
  };

  const upsert: BaileysEventHandler<'messages.upsert'> = async ({ messages, type }) => {
    if (type !== 'append' && type !== 'notify') return;

    const webhookUrl = await getWebhookUrl(sessionId);

    for (const message of messages) {
      try {
        const dedupeKey = `${sessionId}:${message.key.id}`;
        if (message.message && webhookUrl && markForwarded(dedupeKey)) {
          axios
            .post(webhookUrl, { message })
            .catch((e) => logger.error(e, 'Failed to deliver webhook'));
        }

        if (!message.key.id || !message.key.remoteJid) continue;

        const baileys = await import('@whiskeysockets/baileys');
        const { jidNormalizedUser, toNumber } = baileys;
        const jid = jidNormalizedUser(message.key.remoteJid);

        if (shouldPersist(message)) {
          const data = transformPrisma(message);
          await prisma.message.upsert({
            select: { pkId: true },
            create: { ...data, remoteJid: jid, id: message.key.id, sessionId },
            update: { ...data },
            where: { sessionId_remoteJid_id: { remoteJid: jid, id: message.key.id, sessionId } },
          });
        }

        if (type === 'notify') {
          const chatExists = (await prisma.chat.count({ where: { id: jid, sessionId } })) > 0;
          if (!chatExists) {
            event.emit('chats.upsert', [
              {
                id: jid,
                conversationTimestamp: toNumber(message.messageTimestamp),
                unreadCount: message.key.fromMe ? 0 : 1,
              },
            ]);
          }
        }
      } catch (e) {
        logger.error(e, 'An error occured during message upsert');
      }
    }
  };

  const update: BaileysEventHandler<'messages.update'> = async (updates) => {
    const webhookUrl = await getWebhookUrl(sessionId);

    for (const { update, key } of updates) {
      try {
        // removeNullable=false: um update de revogação zera `message` pra
        // null explicitamente — precisamos mandar esse null pro updateMany,
        // senão o conteúdo antigo fica preso na linha.
        const result = await prisma.message.updateMany({
          data: transformPrisma(update as Record<string, any>, false),
          where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
        });
        if (result.count === 0) {
          logger.info({ update }, 'Got update for non existent message');
        }

        // Status de entrega/leitura só interessa pra mensagem que NÓS mandamos
        // (fromMe) - status >= DELIVERY_ACK(3) é o que dá pra mostrar como
        // check duplo (entregue) / check colorido (lido) no painel. Ninguém
        // encaminhava isso antes - só ficava salvo aqui, sem sair pro webhook.
        if (key.fromMe && webhookUrl && typeof update.status === 'number' && update.status >= 3) {
          axios
            .post(webhookUrl, { status_update: { key, status: update.status } })
            .catch((e) => logger.error(e, 'Failed to deliver status webhook'));
        }
      } catch (e) {
        logger.error(e, 'An error occured during message update');
      }
    }
  };

  const del: BaileysEventHandler<'messages.delete'> = async (item) => {
    try {
      if ('all' in item) {
        await prisma.message.deleteMany({ where: { remoteJid: item.jid, sessionId } });
        return;
      }

      const jid = item.keys[0].remoteJid!;
      await prisma.message.deleteMany({
        where: { id: { in: item.keys.map((k) => k.id!) }, remoteJid: jid, sessionId },
      });
    } catch (e) {
      logger.error(e, 'An error occured during message delete');
    }
  };

  const updateReceipt: BaileysEventHandler<'message-receipt.update'> = async (updates) => {
    for (const { key, receipt } of updates) {
      try {
        await prisma.$transaction(async (tx) => {
          const message = await tx.message.findFirst({
            select: { userReceipt: true },
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          });
          if (!message) {
            return logger.debug({ receipt }, 'Got receipt update for non existent message');
          }

          let userReceipt = (message.userReceipt || []) as unknown as MessageUserReceipt[];
          const recepient = userReceipt.find((m) => m.userJid === receipt.userJid);

          if (recepient) {
            userReceipt = [...userReceipt.filter((m) => m.userJid !== receipt.userJid), receipt];
          } else {
            userReceipt.push(receipt);
          }

          await tx.message.update({
            select: { pkId: true },
            data: transformPrisma({ userReceipt: userReceipt }),
            where: {
              sessionId_remoteJid_id: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
            },
          });
        });
      } catch (e) {
        logger.error(e, 'An error occured during message receipt update');
      }
    }
  };

  const updateReaction: BaileysEventHandler<'messages.reaction'> = async (reactions) => {
    for (const { key, reaction } of reactions) {
      try {
        await prisma.$transaction(async (tx) => {
          const message = await tx.message.findFirst({
            select: { reactions: true },
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          });
          if (!message) {
            return logger.debug({ update: reaction }, 'Got reaction update for non existent message');
          }

          const authorID = getKeyAuthor(reaction.key);
          const reactions = ((message.reactions || []) as proto.IReaction[]).filter(
            (r) => getKeyAuthor(r.key) !== authorID
          );

          if (reaction.text) reactions.push(reaction);
          await tx.message.update({
            select: { pkId: true },
            data: transformPrisma({ reactions: reactions }),
            where: {
              sessionId_remoteJid_id: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
            },
          });
        });
      } catch (e) {
        logger.error(e, 'An error occured during message reaction update');
      }
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('messages.upsert', upsert);
    event.on('messages.update', update);
    event.on('messages.delete', del);
    event.on('message-receipt.update', updateReceipt);
    event.on('messages.reaction', updateReaction);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('messages.upsert', upsert);
    event.off('messages.update', update);
    event.off('messages.delete', del);
    event.off('message-receipt.update', updateReceipt);
    event.off('messages.reaction', updateReaction);
    listening = false;
  };

  return { listen, unlisten };
}
