import { PrismaClient } from '@prisma/client';
import pino from 'pino';

export const prisma = new PrismaClient();
export const logger = (pino as any)({ level: process.env.LOG_LEVEL || 'debug' });
