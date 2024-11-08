import type {
  BaileysEventEmitter,
  MessageUserReceipt,
  proto,
  WAMessageKey,
} from '@whiskeysockets/baileys';
import { jidNormalizedUser, toNumber } from '@whiskeysockets/baileys';
import { useLogger, usePrisma } from '../shared';
import type { BaileysEventHandler, MakeTransformedPrisma } from '../types';
import { transformPrisma } from '../utils';
import axios from 'axios';
import { send } from '../../controllers/message';

const getKeyAuthor = (key: WAMessageKey | undefined | null) =>
  (key?.fromMe ? 'me' : key?.participant || key?.remoteJid) || '';

export default function messageHandler(sessionId: string, event: BaileysEventEmitter) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ messages, isLatest }) => {
    try {
      await prisma.$transaction(async (tx: { message: { deleteMany: (arg0: { where: { sessionId: string; }; }) => any; createMany: (arg0: { data: { remoteJid: string; id: string; sessionId: string; key: object; message?: object | undefined; messageTimestamp?: number | undefined; status?: proto.WebMessageInfo.Status | undefined; participant?: string | undefined; messageC2STimestamp?: number | undefined; ignore?: boolean | undefined; starred?: boolean | undefined; broadcast?: boolean | undefined; pushName?: string | undefined; mediaCiphertextSha256?: Buffer | undefined; multicast?: boolean | undefined; urlText?: boolean | undefined; urlNumber?: boolean | undefined; messageStubType?: proto.WebMessageInfo.StubType | undefined; clearMedia?: boolean | undefined; messageStubParameters?: object | undefined; duration?: number | undefined; labels?: object | undefined; paymentInfo?: object | undefined; finalLiveLocation?: object | undefined; quotedPaymentInfo?: object | undefined; ephemeralStartTimestamp?: number | undefined; ephemeralDuration?: number | undefined; ephemeralOffToOn?: boolean | undefined; ephemeralOutOfSync?: boolean | undefined; bizPrivacyStatus?: proto.WebMessageInfo.BizPrivacyStatus | undefined; verifiedBizName?: string | undefined; mediaData?: object | undefined; photoChange?: object | undefined; userReceipt?: object | undefined; reactions?: object | undefined; quotedStickerData?: object | undefined; futureproofData?: Buffer | undefined; statusPsa?: object | undefined; pollUpdates?: object | undefined; pollAdditionalMetadata?: object | undefined; agentId?: string | undefined; statusAlreadyViewed?: boolean | undefined; messageSecret?: Buffer | undefined; keepInChat?: object | undefined; originalSelfAuthorUserJidString?: string | undefined; revokeMessageTimestamp?: number | undefined; pinInChat?: object | undefined; }[]; }) => any; }; }) => {
        if (isLatest) await tx.message.deleteMany({ where: { sessionId } });

        await tx.message.createMany({
          data: messages.map((message) => ({
            ...transformPrisma(message),
            remoteJid: message.key.remoteJid!,
            id: message.key.id!,
            sessionId,
          })),
        });
      });
      logger.info({ messages: messages.length }, 'Synced messages');
    } catch (e) {
      logger.error(e, 'An error occured during messages set');
    }
  };

  const upsert: BaileysEventHandler<'messages.upsert'> = async ({ messages, type }) => {
    let sent: (string | null | undefined)[] = [];
    switch (type) {
      case 'append':
      case 'notify':
        for (const message of messages) {
          const storedMsg = await prisma.message.findFirst({
            where: {
              id: message.key.id!,
              // Adicione outras condições se necessário
            },
          });

          if (message.message) {
            axios.post(`http://api-documentor.test:81/api/whatsapp/${sessionId}/message`, {
                message
              } 
            ).then(response => {
              sent.push(message.key.id);
              console.log(response.data);
            })
          }

          if (storedMsg) {
              return;
          }
          
          try {
            const jid = jidNormalizedUser(message.key.remoteJid!);
            const data = transformPrisma(message);
            await prisma.message.upsert({
              select: { pkId: true },
              create: { ...data, remoteJid: jid, id: message.key.id!, sessionId },
              update: { ...data },
              where: { sessionId_remoteJid_id: { remoteJid: jid, id: message.key.id!, sessionId } },
            });

            const chatExists = (await prisma.chat.count({ where: { id: jid, sessionId } })) > 0;
            if (type === 'notify' && !chatExists) {
              event.emit('chats.upsert', [
                {
                  id: jid,
                  conversationTimestamp: toNumber(message.messageTimestamp),
                  unreadCount: 1,
                },
              ]);
            }
          } catch (e) {
            logger.error(e, 'An error occured during message upsert');
          }
        }
        break;
    }
  };

  const update: BaileysEventHandler<'messages.update'> = async (updates) => {
    for (const { update, key } of updates) {
      try {
        await prisma.$transaction(async (tx: { message: { findFirst: (arg0: { where: { id: string; remoteJid: string; sessionId: string; }; }) => any; delete: (arg0: { select: { pkId: boolean; }; where: { sessionId_remoteJid_id: { id: string; remoteJid: string; sessionId: string; }; }; }) => any; create: (arg0: { select: { pkId: boolean; }; data: { id: string; remoteJid: string; sessionId: string; key: object; message?: object | undefined; messageTimestamp?: number | undefined; status?: proto.WebMessageInfo.Status | undefined; participant?: string | undefined; messageC2STimestamp?: number | undefined; ignore?: boolean | undefined; starred?: boolean | undefined; broadcast?: boolean | undefined; pushName?: string | undefined; mediaCiphertextSha256?: Buffer | undefined; multicast?: boolean | undefined; urlText?: boolean | undefined; urlNumber?: boolean | undefined; messageStubType?: proto.WebMessageInfo.StubType | undefined; clearMedia?: boolean | undefined; messageStubParameters?: object | undefined; duration?: number | undefined; labels?: object | undefined; paymentInfo?: object | undefined; finalLiveLocation?: object | undefined; quotedPaymentInfo?: object | undefined; ephemeralStartTimestamp?: number | undefined; ephemeralDuration?: number | undefined; ephemeralOffToOn?: boolean | undefined; ephemeralOutOfSync?: boolean | undefined; bizPrivacyStatus?: proto.WebMessageInfo.BizPrivacyStatus | undefined; verifiedBizName?: string | undefined; mediaData?: object | undefined; photoChange?: object | undefined; userReceipt?: object | undefined; reactions?: object | undefined; quotedStickerData?: object | undefined; futureproofData?: Buffer | undefined; statusPsa?: object | undefined; pollUpdates?: object | undefined; pollAdditionalMetadata?: object | undefined; agentId?: string | undefined; statusAlreadyViewed?: boolean | undefined; messageSecret?: Buffer | undefined; keepInChat?: object | undefined; originalSelfAuthorUserJidString?: string | undefined; revokeMessageTimestamp?: number | undefined; pinInChat?: object | undefined; }; }) => any; }; }) => {
          const prevData = await tx.message.findFirst({
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          });
          if (!prevData) {
            return logger.info({ update }, 'Got update for non existent message');
          }

          const data = { ...prevData, ...update } as proto.IWebMessageInfo;
          await tx.message.delete({
            select: { pkId: true },
            where: {
              sessionId_remoteJid_id: {
                id: key.id!,
                remoteJid: key.remoteJid!,
                sessionId,
              },
            },
          });
          await tx.message.create({
            select: { pkId: true },
            data: {
              ...transformPrisma(data),
              id: data.key.id!,
              remoteJid: data.key.remoteJid!,
              sessionId,
            },
          });
        });
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
        await prisma.$transaction(async (tx: { message: { findFirst: (arg0: { select: { userReceipt: boolean; }; where: { id: string; remoteJid: string; sessionId: string; }; }) => any; update: (arg0: { select: { pkId: boolean; }; data: MakeTransformedPrisma<{ userReceipt: proto.IUserReceipt[]; }, true>; where: { sessionId_remoteJid_id: { id: string; remoteJid: string; sessionId: string; }; }; }) => any; }; }) => {
          const message = await tx.message.findFirst({
            select: { userReceipt: true },
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          });
          if (!message) {
            return logger.debug({ update }, 'Got receipt update for non existent message');
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
        await prisma.$transaction(async (tx: { message: { findFirst: (arg0: { select: { reactions: boolean; }; where: { id: string; remoteJid: string; sessionId: string; }; }) => any; update: (arg0: { select: { pkId: boolean; }; data: MakeTransformedPrisma<{ reactions: proto.IReaction[]; }, true>; where: { sessionId_remoteJid_id: { id: string; remoteJid: string; sessionId: string; }; }; }) => any; }; }) => {
          const message = await tx.message.findFirst({
            select: { reactions: true },
            where: { id: key.id!, remoteJid: key.remoteJid!, sessionId },
          });
          if (!message) {
            return logger.debug({ update }, 'Got reaction update for non existent message');
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
