import type { AuthenticationCreds, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { useLogger, usePrisma } from './shared.js';

const fixId = (id: string) => id.replace(/\//g, '__').replace(/:/g, '-');

export async function useSession(sessionId: string) {
  // Dynamically import runtime helpers from baileys (ESM-only)
  const baileys = await import('@whiskeysockets/baileys');
  const { proto, BufferJSON, initAuthCreds } = baileys as any;
  const model = usePrisma().session;
  const logger = useLogger();

  const write = async (data: any, id: string) => {
    try {
      data = JSON.stringify(data, BufferJSON.replacer);
      id = fixId(id);
      await model.upsert({
        select: { pkId: true },
        create: { data, id, sessionId },
        update: { data },
        where: { sessionId_id: { id, sessionId } },
      });
    } catch (e) {
      logger.error(e, 'An error occured during session write');
    }
  };

  const read = async (id: string) => {
    try {
      const { data } = await model.findUniqueOrThrow({
        select: { data: true },
        where: { sessionId_id: { id: fixId(id), sessionId } },
      });
      return JSON.parse(data, BufferJSON.reviver);
    } catch (e) {
      if ((e as any)?.code === 'P2025') {
        logger.info({ id }, 'Trying to read non existent session data');
      } else {
        logger.error(e, 'An error occured during session read');
      }
      return null;
    }
  };

  const del = async (id: string) => {
    try {
      await model.delete({
        select: { pkId: true },
        where: { sessionId_id: { id: fixId(id), sessionId } },
      });
    } catch (e) {
      logger.error(e, 'An error occured during session delete');
    }
  };

  // Lê várias chaves de uma vez (1 query com IN) em vez de uma query por id —
  // a Baileys costuma pedir várias sender-keys/session-records juntas
  // (ex: distribuir chave de grupo pra N participantes).
  const readMany = async (ids: string[]) => {
    try {
      const rows = await model.findMany({
        select: { id: true, data: true },
        where: { sessionId, id: { in: ids } },
      });
      const byId = new Map(rows.map((r) => [r.id, r.data]));
      return ids.map((id) => {
        const raw = byId.get(id);
        return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
      });
    } catch (e) {
      logger.error(e, 'An error occured during session batch read');
      return ids.map(() => null);
    }
  };

  const creds: AuthenticationCreds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const data: { [key: string]: SignalDataTypeMap[typeof type] } = {};
          const fixedIds = ids.map((id) => fixId(`${type}-${id}`));
          const values = await readMany(fixedIds);

          ids.forEach((id, index) => {
            let value = values[index];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          });
          return data;
        },
        set: async (data: any) => {
          const tasks: Promise<void>[] = [];

          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const sId = `${category}-${id}`;
              tasks.push(value ? write(value, sId) : del(sId));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write(creds, 'creds'),
  };
}
