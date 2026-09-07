import type { BaileysEventEmitter } from '@whiskeysockets/baileys';
import { useLogger, usePrisma } from '../shared.js';
import type { BaileysEventHandler } from '../types.js';
import { transformPrisma } from '../utils.js';

export default function chatHandler(sessionId: string, event: BaileysEventEmitter) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ chats, isLatest }) => {
    try {
      await prisma.$transaction(async (tx) => {
        if (isLatest) await tx.chat.deleteMany({ where: { sessionId } });

        // Ensure we only work with chats that have a valid id (string)
        const chatIds = chats.map((c) => c.id).filter((id): id is string => typeof id === 'string' && id !== '');
        const existingIds = chatIds.length
          ? (await tx.chat.findMany({ select: { id: true }, where: { id: { in: chatIds }, sessionId } })).map((i) => i.id)
          : [];

        const toCreate = chats
          .filter((c) => typeof c.id === 'string' && c.id && !existingIds.includes(c.id))
          .map((c) => ({ ...transformPrisma(c), id: c.id as string, sessionId }));

        const chatsAdded = toCreate.length ? (await tx.chat.createMany({ data: toCreate })).count : 0;

        logger.info({ chatsAdded }, 'Synced chats');
      });
    } catch (e) {
      logger.error(e, 'An error occured during chats set');
    }
  };

  const upsert: BaileysEventHandler<'chats.upsert'> = async (chats) => {
    try {
      // Promise.any resolve no primeiro sucesso e só rejeita se TODOS falharem
      // — com vários chats no lote, upserts que falham silenciosamente nunca
      // eram reportados. Promise.all garante que toda falha caia no catch.
      await Promise.all(
        chats
          .map((c) => transformPrisma(c))
          .filter((data) => typeof data.id === 'string' && data.id)
          .map((data) =>
            prisma.chat.upsert({
              select: { pkId: true },
              create: { ...(data as any), id: data.id as string, sessionId },
              update: data as any,
              where: { sessionId_id: { id: data.id as string, sessionId } },
            })
          )
      );
    } catch (e) {
      logger.error(e, 'An error occured during chats upsert');
    }
  };

  const update: BaileysEventHandler<'chats.update'> = async (updates) => {
    for (const update of updates) {
      try {
        const data = transformPrisma(update);
        await prisma.chat.update({
          select: { pkId: true },
          data: {
            ...data,
            unreadCount:
              typeof data.unreadCount === 'number'
                ? data.unreadCount > 0
                  ? { increment: data.unreadCount }
                  : { set: data.unreadCount }
                : undefined,
          },
          where: { sessionId_id: { id: update.id!, sessionId } },
        });
      } catch (e) {
        if ((e as any)?.code === 'P2025') {
          return logger.info({ update }, 'Got update for non existent chat');
        }
        logger.error(e, 'An error occured during chat update');
      }
    }
  };

  const del: BaileysEventHandler<'chats.delete'> = async (ids) => {
    try {
      // Faltava filtrar por sessionId: o `id` de um chat é o JID do contato,
      // que é o mesmo em qualquer sessão que fale com ele — sem esse filtro,
      // apagar um chat numa sessão apagava o mesmo chat de TODAS as outras
      // sessões que conversam com o mesmo número.
      await prisma.chat.deleteMany({
        where: { id: { in: ids }, sessionId },
      });
    } catch (e) {
      logger.error(e, 'An error occured during chats delete');
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('chats.upsert', upsert);
    event.on('chats.update', update);
    event.on('chats.delete', del);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('chats.upsert', upsert);
    event.off('chats.update', update);
    event.off('chats.delete', del);
    listening = false;
  };

  return { listen, unlisten };
}
