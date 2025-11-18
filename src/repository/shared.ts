import type { PrismaClient } from '@prisma/client';
import type { SocketConfig } from '@whiskeysockets/baileys';
import invariant from 'tiny-invariant';

let prisma: PrismaClient | null = null;
let logger: SocketConfig['logger'] | null = null;

export function setPrisma(prismaClient: PrismaClient) {
  prisma = prismaClient;
}

export async function setLogger(pinoLogger?: SocketConfig['logger']) {
  if (pinoLogger) {
    logger = pinoLogger;
    return;
  }

  // Dynamic import to avoid require()ing an ESM-only package when compiled to CommonJS
  const baileys = await import('@whiskeysockets/baileys');
  logger = baileys.DEFAULT_CONNECTION_CONFIG?.logger ?? null;
}

export function usePrisma() {
  invariant(prisma, 'Prisma client cannot be used before initialization');
  return prisma;
}

export function useLogger() {
  invariant(logger, 'Pino logger cannot be used before initialization');
  return logger;
}
