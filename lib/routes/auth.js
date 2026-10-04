// Sign up, log in, password reset.

import {
  consumeResetToken,
  createResetToken,
  createSession,
  destroySession,
  hashPassword,
  membershipsFor,
  sessionUser,
  validateEmail,
  validatePassword,
  verifyPassword,
} from '../auth.js';
import { createRestaurant, seedStarterSetup } from '../restaurants.js';
import { HttpError } from '../http.js';
import { rateLimit, requireUser } from './helpers.js';

export function registerAuth(router, app) {
  const me = (user) => ({
    user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: Boolean(user.isPlatformAdmin ?? user.is_platform_admin) },
    memberships: membershipsFor(app.db, user.id).map((m) => ({
      restaurantId: m.id,
      slug: m.slug,
      name: m.name,
      role: m.role,
      timezone: m.timezone,
    })),
  });

  router.post('/api/auth/signup', rateLimit('signup', 5, 3600_000), async (ctx) => {
    if (!app.config.signupsOpen) throw new HttpError(403, 'closed', 'Sign-ups are closed right now.');
    const b = ctx.body;
    const email = validateEmail(b.email);
    const password = validatePassword(b.password);
    const name = String(b.name ?? '').trim().slice(0, 100);
    const restaurantName = String(b.restaurantName ?? '').trim();
    if (!restaurantName) throw new HttpError(400, 'invalid', 'Restaurant name is required.');
    if (app.db.one('SELECT 1 FROM users WHERE email = ?', email)) {
      throw new HttpError(409, 'exists', 'An account with this email already exists. Log in instead.');
    }
    const hash = await hashPassword(password);
    const now = app.now();
    const { userId, restaurant } = app.db.tx(() => {
      const { id } = app.db.run('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)', email, name, hash, now);
      const r = createRestaurant(app.db, {
        name: restaurantName,
        timezone: b.timezone,
        ownerId: id,
        trialDays: app.config.license.trialDays,
        now,
        phone: b.phone,
        email,
      });
      if (b.starter !== false) seedStarterSetup(app.db, r.id);
      return { userId: id, restaurant: r };
    });
    createSession(app, ctx.res, userId, ctx.req.headers['user-agent']);
    return { ...me({ id: userId, email, name }), restaurantId: restaurant.id };
  });

  router.post('/api/auth/login', rateLimit('login', 20, 15 * 60_000), async (ctx) => {
    const email = String(ctx.body.email ?? '').trim().toLowerCase();
    app.limiter.check(`login-email:${email}`, 10, 15 * 60_000, 'Too many attempts for this account. Wait 15 minutes or reset your password.');
    const user = app.db.one('SELECT * FROM users WHERE email = ?', email);
    const ok = await verifyPassword(String(ctx.body.password ?? ''), user?.password_hash);
    if (!user || !ok) throw new HttpError(401, 'bad_credentials', 'That email and password do not match.');
    createSession(app, ctx.res, user.id, ctx.req.headers['user-agent']);
    return me(user);
  });

  router.post('/api/auth/logout', (ctx) => {
    destroySession(app, ctx.req, ctx.res);
    return { ok: true };
  });

  router.get('/api/auth/me', (ctx) => {
    const user = sessionUser(app, ctx.req, ctx.res);
    if (!user) throw new HttpError(401, 'unauthenticated', 'Please log in.');
    return me(user);
  });

  router.post('/api/auth/forgot', rateLimit('forgot', 5, 3600_000), (ctx) => {
    const email = String(ctx.body.email ?? '').trim().toLowerCase();
    const user = app.db.one('SELECT id, email FROM users WHERE email = ?', email);
    if (user) {
      const token = createResetToken(app, user.id);
      app.notify.queueAccountEmail(user.email, 'password_reset', { link: `${app.config.baseUrl}/reset?token=${token}` });
    }
    // Same answer either way, so the form cannot be used to probe accounts.
    return { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  });

  router.post('/api/auth/reset', rateLimit('reset', 10, 3600_000), async (ctx) => {
    await consumeResetToken(app, ctx.body.token, ctx.body.password);
    return { ok: true };
  });

  router.post('/api/auth/password', async (ctx) => {
    const user = requireUser(ctx);
    const row = app.db.one('SELECT password_hash FROM users WHERE id = ?', user.id);
    if (!(await verifyPassword(String(ctx.body.currentPassword ?? ''), row.password_hash))) {
      throw new HttpError(400, 'bad_credentials', 'Current password is incorrect.');
    }
    const hash = await hashPassword(validatePassword(ctx.body.newPassword));
    app.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, user.id);
    return { ok: true };
  });
}
