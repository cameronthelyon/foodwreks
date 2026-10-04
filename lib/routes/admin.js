// Platform administration for the organization running the service:
// licenses, health, delivery failures. Deliberately small.

import { licenseState } from '../license.js';
import { createRestaurant, seedStarterSetup } from '../restaurants.js';
import { createResetToken, validateEmail } from '../auth.js';
import { HttpError } from '../http.js';
import { int, platformAdmin } from './helpers.js';

export function registerAdmin(router, app) {
  const { db } = app;

  router.get('/api/admin/restaurants', platformAdmin(), () =>
    db
      .all(
        `SELECT r.*, (SELECT count(*) FROM reservations x WHERE x.restaurant_id = r.id) AS reservation_count,
                (SELECT max(created_at) FROM reservations x WHERE x.restaurant_id = r.id) AS last_booking_at,
                (SELECT group_concat(u.email, ', ') FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.restaurant_id = r.id AND m.role = 'owner') AS owners
           FROM restaurants r ORDER BY r.created_at DESC`,
      )
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        owners: r.owners,
        createdAt: r.created_at,
        reservations: r.reservation_count,
        lastBookingAt: r.last_booking_at,
        license: licenseState(r, app.now()),
        licenseRef: r.license_ref,
      })),
  );

  // Invite-only onboarding (SIGNUPS_OPEN=0): create the restaurant with the
  // starter setup and invite its owner. The link is returned too, so it can
  // be sent by hand before email is configured.
  router.post('/api/admin/restaurants', platformAdmin(), (ctx) => {
    const name = String(ctx.body.restaurantName ?? '').trim();
    if (!name) throw new HttpError(400, 'invalid', 'Restaurant name is required.');
    const email = validateEmail(ctx.body.ownerEmail);
    const ownerName = String(ctx.body.ownerName ?? '').trim().slice(0, 100);
    const now = app.now();
    const result = db.tx(() => {
      let user = db.one('SELECT id FROM users WHERE email = ?', email);
      const existing = Boolean(user);
      if (!user) user = { id: db.run("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, 'invited', ?)", email, ownerName, now).id };
      const r = createRestaurant(db, { name, timezone: ctx.body.timezone, ownerId: user.id, trialDays: app.config.license.trialDays, now, email });
      seedStarterSetup(db, r.id);
      const link = existing ? `${app.config.baseUrl}/login` : `${app.config.baseUrl}/reset?token=${createResetToken(app, user.id, 7 * 86400_000)}&invite=1`;
      app.notify.queueAccountEmail(email, 'staff_invite', { link, existing, restaurantName: r.name, inviter: ctx.user.name || ctx.user.email });
      return { restaurantId: r.id, slug: r.slug, inviteLink: link, existing };
    });
    return result;
  });

  router.post('/api/admin/restaurants/:id/license', platformAdmin(), (ctx) => {
    const id = int(ctx.params.id);
    const status = ctx.body.status;
    if (!['trial', 'lifetime', 'comped', 'suspended'].includes(status)) throw new HttpError(400, 'invalid', 'Unknown license status.');
    if (!db.one('SELECT 1 FROM restaurants WHERE id = ?', id)) throw new HttpError(404, 'not_found', 'Not found.');
    const now = app.now();
    const trialEnds = status === 'trial' ? now + Math.max(1, int(ctx.body.trialDays, 14)) * 86400_000 : null;
    db.run(
      `UPDATE restaurants SET license_status = ?, trial_ends_at = coalesce(?, trial_ends_at),
         license_paid_at = CASE WHEN ? IN ('lifetime', 'comped') THEN coalesce(license_paid_at, ?) ELSE license_paid_at END,
         license_ref = coalesce(?, license_ref), updated_at = ? WHERE id = ?`,
      status,
      trialEnds,
      status,
      now,
      ctx.body.ref ? String(ctx.body.ref).slice(0, 200) : null,
      now,
      id,
    );
    db.run(
      'INSERT INTO audit_log (restaurant_id, user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      ctx.user.id,
      'license.changed',
      'restaurant',
      id,
      JSON.stringify({ status, ref: ctx.body.ref || null }),
      now,
    );
    app.events.publish(id, { type: 'config' });
    return { ok: true };
  });

  router.get('/api/admin/health', platformAdmin(), () => ({
    restaurants: db.one('SELECT count(*) AS n FROM restaurants').n,
    lifetime: db.one("SELECT count(*) AS n FROM restaurants WHERE license_status = 'lifetime'").n,
    reservations30d: db.one('SELECT count(*) AS n FROM reservations WHERE created_at > ?', app.now() - 30 * 86400_000).n,
    outbox: db.all('SELECT status, channel, count(*) AS n FROM outbox WHERE created_at > ? GROUP BY status, channel', app.now() - 7 * 86400_000),
    recentFailures: db.all("SELECT id, restaurant_id, kind, channel, error, created_at FROM outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 25"),
    integrationErrors: db.all("SELECT restaurant_id, provider, last_error, last_sync_at FROM integrations WHERE status = 'error'"),
  }));
}
