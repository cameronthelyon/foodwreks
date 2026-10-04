// Accounts and sessions. Passwords use scrypt; session cookies carry a random
// token whose SHA-256 is what the database stores.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { randomToken, sha256 } from './crypto.js';
import { HttpError, parseCookies, serializeCookie, appendHeader } from './http.js';

const scryptAsync = promisify(scrypt);
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const SESSION_COOKIE = 'fh_sid';
const SESSION_TTL_MS = 30 * 86400_000;
const RENEW_BELOW_MS = 15 * 86400_000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password).normalize('NFKC'), salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await scryptAsync('x', 'y', KEYLEN, PARAMS); // equalize timing for unusable hashes
    return false;
  }
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function validatePassword(pw) {
  const s = String(pw ?? '');
  if (s.length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters.');
  if (s.length > 200) throw new HttpError(400, 'invalid', 'That password is too long.');
  return s;
}

export function validateEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new HttpError(400, 'invalid', 'Enter a valid email address.');
  return e;
}

export function createSession(app, res, userId, userAgent = '') {
  const token = randomToken(32);
  const now = app.now();
  app.db.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    now,
    now + SESSION_TTL_MS,
    String(userAgent).slice(0, 200),
  );
  app.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now, userId);
  appendHeader(
    res,
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS / 1000, secure: app.config.secureCookies }),
  );
  return token;
}

// Resolves the signed-in user, sliding the session forward when it is more
// than half used.
export function sessionUser(app, req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const now = app.now();
  const row = app.db.one(
    `SELECT s.token_hash, s.expires_at, u.id, u.email, u.name, u.is_platform_admin
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row || row.expires_at <= now) return null;
  if (row.expires_at - now < RENEW_BELOW_MS && res) {
    app.db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now + SESSION_TTL_MS, row.token_hash);
    appendHeader(
      res,
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS / 1000, secure: app.config.secureCookies }),
    );
  }
  return { id: row.id, email: row.email, name: row.name, isPlatformAdmin: Boolean(row.is_platform_admin) };
}

export function destroySession(app, req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) app.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  appendHeader(res, 'Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: app.config.secureCookies }));
}

export function membershipsFor(db, userId) {
  return db.all(
    `SELECT m.role, r.id, r.slug, r.name, r.timezone, r.license_status, r.trial_ends_at
       FROM memberships m JOIN restaurants r ON r.id = m.restaurant_id
      WHERE m.user_id = ? ORDER BY r.name`,
    userId,
  );
}

export const ROLE_RANK = { host: 1, manager: 2, owner: 3 };

// Loads the restaurant and checks the user's role. Unknown restaurants and
// restaurants the user cannot see both return 404, so ids are not probeable.
export function requireMember(db, user, restaurantId, minRole = 'host') {
  const id = Number(restaurantId);
  if (!Number.isInteger(id)) throw new HttpError(404, 'not_found', 'Restaurant not found.');
  const restaurant = db.one('SELECT * FROM restaurants WHERE id = ?', id);
  if (!restaurant) throw new HttpError(404, 'not_found', 'Restaurant not found.');
  const m = db.one('SELECT role FROM memberships WHERE user_id = ? AND restaurant_id = ?', user.id, id);
  const role = m?.role || (user.isPlatformAdmin ? 'owner' : null);
  if (!role) throw new HttpError(404, 'not_found', 'Restaurant not found.');
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw new HttpError(403, 'forbidden', `This needs the ${minRole} role.`);
  return { restaurant, role };
}

export function createResetToken(app, userId, ttlMs = 3600_000) {
  const token = randomToken(32);
  app.db.run(
    'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    sha256(token),
    userId,
    app.now() + ttlMs,
  );
  return token;
}

export async function consumeResetToken(app, token, password) {
  validatePassword(password);
  const row = app.db.one('SELECT * FROM password_resets WHERE token_hash = ?', sha256(String(token ?? '')));
  if (!row || row.used_at || row.expires_at <= app.now()) {
    throw new HttpError(400, 'invalid_token', 'That link has expired. Request a new one.');
  }
  const hash = await hashPassword(password);
  app.db.tx(() => {
    app.db.run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', app.now(), row.token_hash);
    app.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.user_id);
    app.db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
  });
  return row.user_id;
}
