// Small crypto toolkit on node:crypto: tokens, hashing, HMAC, and AES-256-GCM
// for integration credentials stored at rest.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const hmac = (key, data, encoding = 'hex') => createHmac('sha256', key).update(data).digest(encoding);

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) {
    timingSafeEqual(x, x); // keep timing roughly constant
    return false;
  }
  return timingSafeEqual(x, y);
}

// Human-friendly reservation codes: no 0/O/1/I/L confusion.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function randomCode(length = 8) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

// Independent keys per purpose from the one APP_SECRET.
export function deriveKey(secret, purpose) {
  return Buffer.from(hkdfSync('sha256', secret, 'freeheld', purpose, 32));
}

export function makeVault(secret) {
  const key = deriveKey(secret, 'credentials-v1');
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },
    decrypt(text) {
      const [version, iv, tag, body] = String(text).split('.');
      if (version !== 'v1') throw new Error('Unknown credential format');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    },
  };
}

// Signs short-lived values (OAuth state) without storing them.
export function makeSigner(secret) {
  const key = deriveKey(secret, 'signer-v1');
  return {
    sign(payload, ttlMs = 15 * 60 * 1000) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
      return `${body}.${hmac(key, body, 'base64url')}`;
    },
    verify(token) {
      const [body, sig] = String(token ?? '').split('.');
      if (!body || !sig || !safeEqual(sig, hmac(key, body, 'base64url'))) return null;
      try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return data.exp > Date.now() ? data : null;
      } catch {
        return null;
      }
    },
  };
}
