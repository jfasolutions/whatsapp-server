// Avoid importing ESM-only package at top-level. Provide a local safe toNumber
function toNumberSafe(val: any) {
  // If it's a Long-like object with toNumber, use it
  if (val && typeof val.toNumber === 'function') return val.toNumber();
  if (typeof val === 'bigint') return Number(val);
  return Number(val || 0);
}
import Long from 'long';
import type { MakeTransformedPrisma, MakeSerializedPrisma } from './types';

/** Transform object props value into Prisma-supported types */
export function transformPrisma<T extends Record<string, any>>(
  data: T,
  removeNullable = true
): MakeTransformedPrisma<T> {
  const obj = { ...data } as any;

  for (const [key, val] of Object.entries(obj)) {
    if (val instanceof Uint8Array) {
      obj[key] = Buffer.from(val);
    } else if (typeof val === 'number' || val instanceof Long) {
      obj[key] = toNumberSafe(val);
    } else if (removeNullable && (typeof val === 'undefined' || val === null)) {
      delete obj[key];
    }
  }

  return obj;
}

/** Transform prisma result into JSON serializable types */
export function serializePrisma<T extends Record<string, any>>(
  data: T,
  removeNullable = true
): MakeSerializedPrisma<T> {
  const obj = { ...data } as any;

  for (const [key, val] of Object.entries(obj)) {
    if (val instanceof Buffer) {
      obj[key] = val.toJSON();
    } else if (typeof val === 'bigint' || val instanceof BigInt) {
      obj[key] = val.toString();
    } else if (removeNullable && (typeof val === 'undefined' || val === null)) {
      delete obj[key];
    }
  }

  return obj;
}
