import type { BaileysEventEmitter } from '@whiskeysockets/baileys';
import { useLogger, usePrisma } from '../shared.js';
import type { BaileysEventHandler } from '../types.js';
import { transformPrisma } from '../utils.js';

// Grupo e contato individual moram na mesma tabela, diferenciados só pelo
// sufixo do JID. Calculamos isso uma vez na escrita e guardamos em `type`
// pra /contacts e /groups poderem filtrar por índice em vez de LIKE '%sufixo'.
const resolveContactType = (id: string) => (id.endsWith('g.us') ? 'group' : 'contact');

export default function contactHandler(sessionId: string, event: BaileysEventEmitter) {
  const prisma = usePrisma();
  const logger = useLogger();
  let listening = false;

  const set: BaileysEventHandler<'messaging-history.set'> = async ({ contacts }) => {
    try {
      const contactIds = contacts.map((c) => c.id);
      const deletedOldContactIds = (
        await prisma.contact.findMany({
          select: { id: true },
          where: { id: { notIn: contactIds }, sessionId },
        })
      ).map((c) => c.id);

      const upsertPromises = contacts
        .map((c) => transformPrisma(c))
        .map((data) =>
          prisma.contact.upsert({
            select: { pkId: true },
            create: { ...data, sessionId, type: resolveContactType(data.id) },
            update: data,
            where: { sessionId_id: { id: data.id, sessionId } },
          })
        );

      // Promise.any resolve no 1º sucesso e só rejeita se TODOS falharem —
      // com várias promises no lote, falha em upsert/delete individual nunca
      // caía no catch. Promise.all garante que qualquer falha seja reportada.
      await Promise.all([
        ...upsertPromises,
        prisma.contact.deleteMany({ where: { id: { in: deletedOldContactIds }, sessionId } }),
      ]);
      logger.info(
        { deletedContacts: deletedOldContactIds.length, newContacts: contacts.length },
        'Synced contacts'
      );
      } catch (e) {
      logger.error(e, 'An error occured during contacts set');
    }
  };

  const upsert: BaileysEventHandler<'contacts.upsert'> = async (contacts) => {
    try {
      await Promise.all(
        contacts
          .map((c) => transformPrisma(c))
          .map((data) =>
            prisma.contact.upsert({
              select: { pkId: true },
              create: { ...data, sessionId, type: resolveContactType(data.id) },
              update: data,
              where: { sessionId_id: { id: data.id, sessionId } },
            })
          )
      );
      } catch (e) {
        logger.error(e, 'An error occured during contacts upsert');
      }
  };

  const update: BaileysEventHandler<'contacts.update'> = async (updates) => {
    for (const update of updates) {
      try {
        await prisma.contact.update({
          select: { pkId: true },
          data: transformPrisma(update),
          where: { sessionId_id: { id: update.id!, sessionId } },
        });
      } catch (e) {
        if ((e as any)?.code === 'P2025') {
          return logger.info({ update }, 'Got update for non existent contact');
        }
        logger.error(e, 'An error occured during contact update');
      }
    }
  };

  const listen = () => {
    if (listening) return;

    event.on('messaging-history.set', set);
    event.on('contacts.upsert', upsert);
    event.on('contacts.update', update);
    listening = true;
  };

  const unlisten = () => {
    if (!listening) return;

    event.off('messaging-history.set', set);
    event.off('contacts.upsert', upsert);
    event.off('contacts.update', update);
    listening = false;
  };

  return { listen, unlisten };
}
