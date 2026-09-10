/**
 * Token-at-rest encryption for the Google integration.
 *
 * AES-256-GCM. Ciphertext is stored as `ivB64.tagB64.ctB64` so the format is
 * self-describing and a rotated key can be detected (decrypt throws).
 *
 * Key: `GOOGLE_TOKEN_ENC_KEY` (64 hex chars, or base64 of 32 bytes). If it is
 * absent — the normal case in local dev before a real key is provisioned — a
 * key is derived from `JWT_SECRET` via scrypt and a one-time warning is logged.
 * That keeps the flow working the moment the OAuth client id/secret land,
 * while production still gets a dedicated key.
 *
 * @module google/crypto.util
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { Logger } from '@nestjs/common';

const log = new Logger('GoogleTokenCrypto');
const ALGO = 'aes-256-gcm';
let cachedKey: Buffer | null = null;
let warned = false;

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = (process.env.GOOGLE_TOKEN_ENC_KEY || '').trim();
  if (raw) {
    let buf: Buffer | null = null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
    else {
      try {
        const b = Buffer.from(raw, 'base64');
        if (b.length === 32) buf = b;
      } catch {
        /* fall through */
      }
    }
    if (!buf) {
      throw new Error('GOOGLE_TOKEN_ENC_KEY must be 64 hex chars or base64 of exactly 32 bytes');
    }
    cachedKey = buf;
    return buf;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Cannot encrypt Google tokens: set GOOGLE_TOKEN_ENC_KEY (or JWT_SECRET for the dev fallback)');
  }
  if (!warned) {
    log.warn('GOOGLE_TOKEN_ENC_KEY not set — deriving a token key from JWT_SECRET (dev fallback). Set a dedicated key in production.');
    warned = true;
  }
  cachedKey = scryptSync(secret, 'cailyx.google.tokens.v1', 32);
  return cachedKey;
}

/** Encrypt a UTF-8 string. Returns `ivB64.tagB64.ctB64`. */
export function encryptToken(plain: string): string {
  const key = resolveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

/** Decrypt a value produced by {@link encryptToken}. Throws on tamper / wrong key. */
export function decryptToken(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted token');
  const key = resolveKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
