// Staff API (host stand, settings, guests, reports). Every route is scoped to
// one restaurant (:rid) and checks the caller's role.

import { computeAvailability, planDay, serviceWindows } from '../availability.js';
import {
  PROFILE_FIELDS,
  closureRow,
  comboRow,
  dayContext,
  loadFloor,
  loadShifts,
  restaurantSettings,
  sanitizeSettings,
  shiftRow,
  tableRow,
  validateClosure,
  validateCombo,
  validateShift,
  validateTable,
} from '../restaurants.js';
import { createReservation, dayBook, reservationView, setStatus, updateReservation } from '../reservations.js';
import { guestRow, mergeGuests, updateGuest } from '../guests.js';
import {
  addToWaitlist,
  estimateWait,
  notifyReady,
  removeFromWaitlist,
  seatFromWaitlist,
  updateWaitlistEntry,
  waitlistForDay,
  waitlistView,
} from '../waitlist.js';
import { buildReport } from '../reports.js';
import { exportAll, exportGuestsCsv, exportReservationsCsv, importGuests, importReservations, previewImport } from '../portability.js';
import { licenseState } from '../license.js';
import { chargeNoShowFee, createLicenseCheckout, StripeError } from '../integrations/stripe.js';
import { notifyGoogleBooking } from '../google.js';
import { createResetToken, validateEmail } from '../auth.js';
import { addDays, fmt12, isValidDate, isValidTimeZone, localDate } from '../time.js';
import { HttpError, sendText } from '../http.js';
import { parseJson } from '../db.js';
import { int, staff } from './helpers.js';

const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function fullRestaurant(app, r, role) {
  const base = app.config.baseUrl;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    timezone: r.timezone,
    phone: r.phone,
    email: r.email,
    website: r.website,
    address: r.address,
    city: r.city,
    region: r.region,
    postalCode: r.postal_code,
    country: r.country,
    cuisine: r.cuisine,
    latitude: r.latitude,
    longitude: r.longitude,
    onlineBooking: Boolean(r.online_booking),
    settings: restaurantSettings(r),
    license: { ...licenseState(r, app.now()), priceCents: app.config.license.priceCents, checkoutAvailable: Boolean(app.config.platformStripe.secretKey) },
    role,
    today: localDate(app.now(), r.timezone),
    links: {
      booking: `${base}/r/${r.slug}`,
      google: `${base}/r/${r.slug}?ref=google`,
      instagram: `${base}/r/${r.slug}?ref=instagram`,
      widget: `<script src="${base}/widget.js" data-restaurant="${r.slug}" async></script>`,
    },
    messaging: { email: app.notify.email?.name || null, sms: app.notify.sms?.name || null },
    stripeConnected: Boolean(app.integrations.stripeKey(r.id)),
  };
}

function audit(app, ctx, action, entity, entityId, detail) {
  app.db.run(
    'INSERT INTO audit_log (restaurant_id, user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ctx.restaurant.id,
    ctx.user.id,
    action,
    entity,
    entityId ?? null,
    detail ? JSON.stringify(detail) : null,
    app.now(),
  );
}

function requireDate(value) {
  if (!isValidDate(value)) throw new HttpError(400, 'invalid', 'Dates must be YYYY-MM-DD.');
  return value;
}

function owned(app, table, id, restaurantId) {
  const row = app.db.one(`SELECT * FROM ${table} WHERE id = ? AND restaurant_id = ?`, int(id), restaurantId);
  if (!row) throw new HttpError(404, 'not_found', 'Not found.');
  return row;
}

function sendCsv(res, filename, body) {
  sendText(res, 200, body, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
}

export function registerStaff(router, app) {
  const { db } = app;
  const touch = (ctx) => app.events.publish(ctx.restaurant.id, { type: 'config' });

  // ---- Restaurant -----------------------------------------------------------
  router.get('/api/r/:rid', staff('host'), (ctx) => fullRestaurant(app, ctx.restaurant, ctx.role));

  router.patch('/api/r/:rid', staff('manager'), (ctx) => {
    const b = ctx.body;
    const r = ctx.restaurant;
    const next = {};
    for (const f of PROFILE_FIELDS) {
      const key = f === 'postal_code' ? 'postalCode' : f;
      if (b[key] !== undefined) next[f] = String(b[key]).trim().slice(0, f === 'address' ? 300 : 200);
    }
    if (next.name === '') throw new HttpError(400, 'invalid', 'Name cannot be empty.');
    if (b.timezone !== undefined) {
      if (!isValidTimeZone(b.timezone)) throw new HttpError(400, 'invalid', 'Unknown time zone.');
      next.timezone = b.timezone;
    }
    if (b.onlineBooking !== undefined) next.online_booking = b.onlineBooking ? 1 : 0;
    for (const k of ['latitude', 'longitude']) {
      if (b[k] !== undefined) next[k] = b[k] === null || b[k] === '' ? null : Number(b[k]);
      if (next[k] !== undefined && next[k] !== null && !Number.isFinite(next[k])) throw new HttpError(400, 'invalid', `Bad ${k}.`);
    }
    const keys = Object.keys(next);
    if (keys.length) {
      db.run(`UPDATE restaurants SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => next[k]), app.now(), r.id);
      audit(app, ctx, 'restaurant.updated', 'restaurant', r.id, { fields: keys });
    }
    touch(ctx);
    return fullRestaurant(app, db.one('SELECT * FROM restaurants WHERE id = ?', r.id), ctx.role);
  });

  router.patch('/api/r/:rid/settings', staff('manager'), (ctx) => {
    const current = restaurantSettings(ctx.restaurant);
    const settings = sanitizeSettings(ctx.body, current);
    db.run('UPDATE restaurants SET settings = ?, updated_at = ? WHERE id = ?', JSON.stringify(settings), app.now(), ctx.restaurant.id);
    audit(app, ctx, 'settings.updated', 'restaurant', ctx.restaurant.id, { fields: Object.keys(ctx.body) });
    touch(ctx);
    return settings;
  });

  // ---- Host stand -------------------------------------------------------------
  router.get('/api/r/:rid/day/:date', staff('host'), (ctx) => {
    const r = ctx.restaurant;
    const date = requireDate(ctx.params.date);
    const dc = dayContext(db, r, date, { nowMs: app.now(), channel: 'staff' });
    const reservations = dayBook(db, r, date);
    const plan = planDay(dc);
    const active = reservations.filter((x) => !['cancelled', 'no_show'].includes(x.status));
    return {
      date,
      reservations,
      waitlist: waitlistForDay(db, r, date),
      tables: dc.tables,
      combos: dc.combos,
      closure: dc.closure,
      windows: serviceWindows({ ...dc, channel: 'staff' }).windows,
      overbooked: plan.overbooked,
      autoSeats: Object.fromEntries([...plan.placed].filter(([id]) => !reservations.find((x) => x.id === id)?.tableIds.length)),
      stats: {
        parties: active.length,
        covers: active.reduce((a, x) => a + x.partySize, 0),
        seated: reservations.filter((x) => ['seated', 'completed'].includes(x.status)).reduce((a, x) => a + x.partySize, 0),
        noShows: reservations.filter((x) => x.status === 'no_show').length,
        cancelled: reservations.filter((x) => x.status === 'cancelled').length,
      },
    };
  });

  router.get('/api/r/:rid/availability', staff('host'), (ctx) => {
    const date = requireDate(ctx.query.date);
    const partySize = int(ctx.query.party);
    if (!partySize || partySize < 1 || partySize > 100) throw new HttpError(400, 'invalid', 'Pick a party size.');
    const dc = dayContext(db, ctx.restaurant, date, { nowMs: app.now(), channel: ctx.query.channel === 'online' ? 'online' : 'staff' });
    const result = computeAvailability({ ...dc, partySize, excludeReservationId: int(ctx.query.exclude) });
    return { ...result, slots: result.slots.map((s) => ({ ...s, label: fmt12(s.time) })) };
  });

  // ---- Reservations -----------------------------------------------------------
  router.post('/api/r/:rid/reservations', staff('host'), (ctx) => {
    const { reservation, warnings } = createReservation(app, ctx.restaurant, ctx.body, { channel: 'staff', userId: ctx.user.id });
    return { reservation: reservationView(reservation), warnings };
  });

  router.get('/api/r/:rid/reservations/:id', staff('host'), (ctx) => {
    const row = owned(app, 'reservations', ctx.params.id, ctx.restaurant.id);
    const guest = row.guest_id ? db.one('SELECT * FROM guests WHERE id = ?', row.guest_id) : null;
    const history = db.all(
      `SELECT a.action, a.detail, a.created_at, u.name AS user_name, u.email AS user_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.restaurant_id = ? AND a.entity = 'reservation' AND a.entity_id = ? ORDER BY a.id`,
      ctx.restaurant.id,
      row.id,
    );
    return {
      reservation: reservationView(row, guest),
      history: history.map((h) => ({ action: h.action, detail: parseJson(h.detail, null), at: h.created_at, by: h.user_name || h.user_email || null })),
      checks: db.all('SELECT provider, external_id, closed_at, total_cents, table_ref, match_method FROM pos_checks WHERE reservation_id = ?', row.id),
      messages: db.all('SELECT kind, channel, status, created_at, sent_at, error FROM outbox WHERE reservation_id = ? ORDER BY id', row.id),
    };
  });

  router.patch('/api/r/:rid/reservations/:id', staff('host'), (ctx) => {
    const { reservation } = updateReservation(app, ctx.restaurant, int(ctx.params.id), ctx.body, { userId: ctx.user.id });
    return { reservation: reservationView(reservation) };
  });

  router.post('/api/r/:rid/reservations/:id/status', staff('host'), (ctx) => {
    const row = setStatus(app, ctx.restaurant, int(ctx.params.id), String(ctx.body.status), {
      userId: ctx.user.id,
      reason: String(ctx.body.reason ?? '').slice(0, 300),
      notify: ctx.body.notify !== false,
    });
    if (row.source === 'google') notifyGoogleBooking(app, row, app.fetch).catch((err) => app.log.warn?.(`google notify: ${err.message}`));
    return { reservation: reservationView(row) };
  });

  router.post('/api/r/:rid/reservations/:id/resend', staff('host'), (ctx) => {
    const row = owned(app, 'reservations', ctx.params.id, ctx.restaurant.id);
    if (!['booked', 'confirmed'].includes(row.status)) throw new HttpError(409, 'invalid', 'Only upcoming reservations can be re-sent.');
    if (!row.guest_email && !row.guest_phone) throw new HttpError(409, 'invalid', 'No email or phone on this reservation.');
    app.notify.queueReservation(ctx.restaurant, row, 'confirmation');
    return { ok: true };
  });

  router.post('/api/r/:rid/reservations/:id/charge', staff('manager'), async (ctx) => {
    const r = ctx.restaurant;
    const row = owned(app, 'reservations', ctx.params.id, r.id);
    if (row.status !== 'no_show') throw new HttpError(409, 'invalid', 'Mark the reservation as a no-show first.');
    if (row.card_status !== 'on_file' || !row.card_ref) throw new HttpError(409, 'invalid', 'There is no card on file for this reservation.');
    const amount = Math.min(int(ctx.body.amountCents, row.no_show_fee_cents) || 0, row.no_show_fee_cents || 0);
    if (amount < 50) throw new HttpError(409, 'invalid', 'No fee to charge.');
    const key = app.integrations.stripeKey(r.id);
    const guest = row.guest_id ? db.one('SELECT stripe_customer_id FROM guests WHERE id = ?', row.guest_id) : null;
    if (!key || !guest?.stripe_customer_id) throw new HttpError(409, 'invalid', 'Stripe is not connected.');
    try {
      const pi = await chargeNoShowFee(key, { customerId: guest.stripe_customer_id, paymentMethod: row.card_ref, amountCents: amount, reservation: row, restaurant: r, fetchImpl: app.fetch });
      const ok = pi.status === 'succeeded';
      db.run('UPDATE reservations SET card_status = ?, charged_cents = ?, updated_at = ? WHERE id = ?', ok ? 'charged' : 'failed', ok ? amount : null, app.now(), row.id);
      audit(app, ctx, ok ? 'reservation.fee_charged' : 'reservation.fee_failed', 'reservation', row.id, { amount, status: pi.status });
      if (!ok) throw new HttpError(402, 'card_declined', 'The bank asked the cardholder to confirm. The fee was not charged.');
    } catch (err) {
      if (err instanceof StripeError) {
        db.run("UPDATE reservations SET card_status = 'failed', updated_at = ? WHERE id = ?", app.now(), row.id);
        audit(app, ctx, 'reservation.fee_failed', 'reservation', row.id, { amount, error: err.code || err.message });
        throw new HttpError(402, 'card_declined', `Charge failed: ${err.message}`);
      }
      throw err;
    }
    return { reservation: reservationView(db.one('SELECT * FROM reservations WHERE id = ?', row.id)) };
  });

  router.get('/api/r/:rid/search', staff('host'), (ctx) => {
    const q = String(ctx.query.q ?? '').trim();
    if (q.length < 2) return { reservations: [], guests: [] };
    const digits = q.replace(/\D/g, '');
    const today = localDate(app.now(), ctx.restaurant.timezone);
    const reservations = db
      .all(
        `SELECT * FROM reservations WHERE restaurant_id = ? AND date BETWEEN ? AND ?
           AND (guest_name LIKE ? ESCAPE '\\' OR code = ? OR guest_email LIKE ? ESCAPE '\\' OR (? != '' AND guest_phone LIKE ?))
         ORDER BY abs(julianday(date) - julianday(?)), start_min LIMIT 25`,
        ctx.restaurant.id,
        addDays(today, -60),
        addDays(today, 365),
        like(q),
        q.toUpperCase(),
        like(q),
        digits.length >= 4 ? digits : '',
        `%${digits}%`,
        today,
      )
      .map((r) => reservationView(r));
    const guests = db
      .all(
        `SELECT * FROM guests WHERE restaurant_id = ?
           AND ((first_name || ' ' || last_name) LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR (? != '' AND phone LIKE ?))
         ORDER BY visit_count DESC LIMIT 10`,
        ctx.restaurant.id,
        like(q),
        like(q),
        digits.length >= 4 ? digits : '',
        `%${digits}%`,
      )
      .map(guestRow);
    return { reservations, guests };
  });

  // ---- Floor plan -------------------------------------------------------------
  router.get('/api/r/:rid/floor', staff('host'), (ctx) => loadFloor(db, ctx.restaurant.id));

  router.post('/api/r/:rid/tables', staff('manager'), (ctx) => {
    const t = validateTable(ctx.body);
    if (db.one('SELECT 1 FROM tables WHERE restaurant_id = ? AND name = ?', ctx.restaurant.id, t.name)) throw new HttpError(409, 'exists', 'A table with that name exists.');
    const { id } = db.run(
      'INSERT INTO tables (restaurant_id, name, section, min_covers, max_covers, online, active, sort, pos_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ctx.restaurant.id,
      t.name,
      t.section,
      t.min_covers,
      t.max_covers,
      t.online,
      t.active,
      t.sort,
      t.pos_ref,
    );
    audit(app, ctx, 'table.created', 'table', id, t);
    touch(ctx);
    return tableRow(db.one('SELECT * FROM tables WHERE id = ?', id));
  });

  router.patch('/api/r/:rid/tables/:id', staff('manager'), (ctx) => {
    const cur = owned(app, 'tables', ctx.params.id, ctx.restaurant.id);
    const t = validateTable({ ...cur, ...ctx.body });
    if (t.name !== cur.name && db.one('SELECT 1 FROM tables WHERE restaurant_id = ? AND name = ? AND id != ?', ctx.restaurant.id, t.name, cur.id)) {
      throw new HttpError(409, 'exists', 'A table with that name exists.');
    }
    db.run(
      'UPDATE tables SET name = ?, section = ?, min_covers = ?, max_covers = ?, online = ?, active = ?, sort = ?, pos_ref = ? WHERE id = ?',
      t.name,
      t.section,
      t.min_covers,
      t.max_covers,
      t.online,
      t.active,
      t.sort,
      t.pos_ref,
      cur.id,
    );
    audit(app, ctx, 'table.updated', 'table', cur.id, t);
    touch(ctx);
    return tableRow(db.one('SELECT * FROM tables WHERE id = ?', cur.id));
  });

  // Tables in reservation history are retired, not deleted, so old bookings
  // still show where the party sat.
  router.delete('/api/r/:rid/tables/:id', staff('manager'), (ctx) => {
    const cur = owned(app, 'tables', ctx.params.id, ctx.restaurant.id);
    const used = db.one(
      'SELECT 1 FROM reservations WHERE restaurant_id = ? AND EXISTS (SELECT 1 FROM json_each(reservations.table_ids) WHERE value = ?) LIMIT 1',
      ctx.restaurant.id,
      cur.id,
    );
    db.tx(() => {
      for (const c of db.all('SELECT id, table_ids FROM table_combos WHERE restaurant_id = ?', ctx.restaurant.id)) {
        if (parseJson(c.table_ids, []).includes(cur.id)) db.run('DELETE FROM table_combos WHERE id = ?', c.id);
      }
      if (used) db.run('UPDATE tables SET active = 0 WHERE id = ?', cur.id);
      else db.run('DELETE FROM tables WHERE id = ?', cur.id);
    });
    audit(app, ctx, used ? 'table.retired' : 'table.deleted', 'table', cur.id);
    touch(ctx);
    return { ok: true, retired: Boolean(used) };
  });

  router.post('/api/r/:rid/combos', staff('manager'), (ctx) => {
    const c = validateCombo(db, ctx.restaurant.id, ctx.body);
    const { id } = db.run(
      'INSERT INTO table_combos (restaurant_id, name, table_ids, min_covers, max_covers, online, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ctx.restaurant.id,
      c.name,
      c.table_ids,
      c.min_covers,
      c.max_covers,
      c.online,
      c.active,
    );
    audit(app, ctx, 'combo.created', 'combo', id, c);
    touch(ctx);
    return comboRow(db.one('SELECT * FROM table_combos WHERE id = ?', id));
  });

  router.patch('/api/r/:rid/combos/:id', staff('manager'), (ctx) => {
    const cur = comboRow(owned(app, 'table_combos', ctx.params.id, ctx.restaurant.id));
    const c = validateCombo(db, ctx.restaurant.id, { ...cur, ...ctx.body });
    db.run(
      'UPDATE table_combos SET name = ?, table_ids = ?, min_covers = ?, max_covers = ?, online = ?, active = ? WHERE id = ?',
      c.name,
      c.table_ids,
      c.min_covers,
      c.max_covers,
      c.online,
      c.active,
      cur.id,
    );
    touch(ctx);
    return comboRow(db.one('SELECT * FROM table_combos WHERE id = ?', cur.id));
  });

  router.delete('/api/r/:rid/combos/:id', staff('manager'), (ctx) => {
    const cur = owned(app, 'table_combos', ctx.params.id, ctx.restaurant.id);
    db.run('DELETE FROM table_combos WHERE id = ?', cur.id);
    touch(ctx);
    return { ok: true };
  });

  // ---- Schedule -----------------------------------------------------------------
  router.get('/api/r/:rid/shifts', staff('host'), (ctx) => loadShifts(db, ctx.restaurant.id));

  router.post('/api/r/:rid/shifts', staff('manager'), (ctx) => {
    const s = validateShift(ctx.body);
    const { id } = db.run(
      `INSERT INTO shifts (restaurant_id, name, days, start_min, last_seating_min, end_min, interval_min, max_covers_per_slot,
         max_parties_per_slot, online, active, starts_on, ends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.restaurant.id,
      s.name,
      s.days,
      s.start_min,
      s.last_seating_min,
      s.end_min,
      s.interval_min,
      s.max_covers_per_slot,
      s.max_parties_per_slot,
      s.online,
      s.active,
      s.starts_on,
      s.ends_on,
    );
    audit(app, ctx, 'shift.created', 'shift', id, s);
    touch(ctx);
    return shiftRow(db.one('SELECT * FROM shifts WHERE id = ?', id));
  });

  router.patch('/api/r/:rid/shifts/:id', staff('manager'), (ctx) => {
    const cur = shiftRow(owned(app, 'shifts', ctx.params.id, ctx.restaurant.id));
    const s = validateShift({ ...cur, ...ctx.body });
    db.run(
      `UPDATE shifts SET name = ?, days = ?, start_min = ?, last_seating_min = ?, end_min = ?, interval_min = ?,
         max_covers_per_slot = ?, max_parties_per_slot = ?, online = ?, active = ?, starts_on = ?, ends_on = ? WHERE id = ?`,
      s.name,
      s.days,
      s.start_min,
      s.last_seating_min,
      s.end_min,
      s.interval_min,
      s.max_covers_per_slot,
      s.max_parties_per_slot,
      s.online,
      s.active,
      s.starts_on,
      s.ends_on,
      cur.id,
    );
    audit(app, ctx, 'shift.updated', 'shift', cur.id, s);
    touch(ctx);
    return shiftRow(db.one('SELECT * FROM shifts WHERE id = ?', cur.id));
  });

  router.delete('/api/r/:rid/shifts/:id', staff('manager'), (ctx) => {
    const cur = owned(app, 'shifts', ctx.params.id, ctx.restaurant.id);
    db.run('DELETE FROM shifts WHERE id = ?', cur.id);
    audit(app, ctx, 'shift.deleted', 'shift', cur.id);
    touch(ctx);
    return { ok: true };
  });

  router.get('/api/r/:rid/closures', staff('host'), (ctx) => {
    const today = localDate(app.now(), ctx.restaurant.timezone);
    return db.all('SELECT * FROM closures WHERE restaurant_id = ? AND date >= ? ORDER BY date', ctx.restaurant.id, addDays(today, -7)).map(closureRow);
  });

  router.post('/api/r/:rid/closures', staff('manager'), (ctx) => {
    const c = validateClosure(ctx.body);
    db.run(
      `INSERT INTO closures (restaurant_id, date, closed, start_min, last_seating_min, end_min, note) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (restaurant_id, date) DO UPDATE SET closed = excluded.closed, start_min = excluded.start_min,
         last_seating_min = excluded.last_seating_min, end_min = excluded.end_min, note = excluded.note`,
      ctx.restaurant.id,
      c.date,
      c.closed,
      c.start_min,
      c.last_seating_min,
      c.end_min,
      c.note,
    );
    const booked = db.one(
      "SELECT count(*) AS n FROM reservations WHERE restaurant_id = ? AND date = ? AND status IN ('booked', 'confirmed', 'pending')",
      ctx.restaurant.id,
      c.date,
    ).n;
    audit(app, ctx, 'closure.saved', 'closure', null, c);
    touch(ctx);
    return { closure: closureRow(db.one('SELECT * FROM closures WHERE restaurant_id = ? AND date = ?', ctx.restaurant.id, c.date)), existingReservations: booked };
  });

  router.delete('/api/r/:rid/closures/:id', staff('manager'), (ctx) => {
    const cur = owned(app, 'closures', ctx.params.id, ctx.restaurant.id);
    db.run('DELETE FROM closures WHERE id = ?', cur.id);
    touch(ctx);
    return { ok: true };
  });

  // ---- Guests ---------------------------------------------------------------------
  router.get('/api/r/:rid/guests', staff('host'), (ctx) => {
    const q = String(ctx.query.q ?? '').trim();
    const tag = String(ctx.query.tag ?? '').trim();
    const limit = Math.min(200, Math.max(1, int(ctx.query.limit, 50)));
    const offset = Math.max(0, int(ctx.query.offset, 0));
    const order =
      { visits: 'visit_count DESC, id DESC', spend: 'total_spend_cents DESC, id DESC', name: 'last_name, first_name, id', noshows: 'no_show_count DESC, id DESC' }[
        ctx.query.sort
      ] || 'coalesce(last_visit_date, \'\') DESC, updated_at DESC';
    const digits = q.replace(/\D/g, '');
    const where = ['restaurant_id = ?'];
    const args = [ctx.restaurant.id];
    if (q) {
      where.push(`((first_name || ' ' || last_name) LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR (? != '' AND phone LIKE ?))`);
      args.push(like(q), like(q), digits.length >= 4 ? digits : '', `%${digits}%`);
    }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(guests.tags) WHERE value = ?)');
      args.push(tag);
    }
    const total = db.one(`SELECT count(*) AS n FROM guests WHERE ${where.join(' AND ')}`, ...args).n;
    const guests = db.all(`SELECT * FROM guests WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, offset).map(guestRow);
    const tags = db
      .all('SELECT value AS tag, count(*) AS n FROM guests, json_each(guests.tags) WHERE restaurant_id = ? GROUP BY value ORDER BY n DESC LIMIT 50', ctx.restaurant.id)
      .map((t) => t.tag);
    return { total, guests, tags };
  });

  router.get('/api/r/:rid/guests/:id', staff('host'), (ctx) => {
    const g = owned(app, 'guests', ctx.params.id, ctx.restaurant.id);
    const reservations = db.all('SELECT * FROM reservations WHERE guest_id = ? ORDER BY date DESC, start_min DESC LIMIT 200', g.id).map((r) => reservationView(r));
    return { guest: guestRow(g), reservations };
  });

  router.patch('/api/r/:rid/guests/:id', staff('host'), (ctx) => updateGuest(db, ctx.restaurant.id, int(ctx.params.id), ctx.body, app.now()));

  router.post('/api/r/:rid/guests/:id/merge', staff('manager'), (ctx) => {
    const guest = mergeGuests(db, ctx.restaurant.id, int(ctx.params.id), int(ctx.body.otherId), app.now());
    audit(app, ctx, 'guest.merged', 'guest', guest.id, { merged: int(ctx.body.otherId) });
    return guest;
  });

  // ---- Waitlist -------------------------------------------------------------------
  router.get('/api/r/:rid/waitlist', staff('host'), (ctx) => {
    const date = ctx.query.date ? requireDate(ctx.query.date) : localDate(app.now(), ctx.restaurant.timezone);
    return waitlistForDay(db, ctx.restaurant, date);
  });

  router.get('/api/r/:rid/waitlist/estimate', staff('host'), (ctx) => ({ quotedMin: estimateWait(app, ctx.restaurant, int(ctx.query.party, 2)) }));

  router.post('/api/r/:rid/waitlist', staff('host'), (ctx) => waitlistView(addToWaitlist(app, ctx.restaurant, ctx.body, { source: 'staff', userId: ctx.user.id })));
  router.patch('/api/r/:rid/waitlist/:id', staff('host'), (ctx) => waitlistView(updateWaitlistEntry(app, ctx.restaurant, int(ctx.params.id), ctx.body)));
  router.post('/api/r/:rid/waitlist/:id/notify', staff('host'), (ctx) => waitlistView(notifyReady(app, ctx.restaurant, int(ctx.params.id))));
  router.post('/api/r/:rid/waitlist/:id/seat', staff('host'), (ctx) => {
    const { entry, reservation } = seatFromWaitlist(app, ctx.restaurant, int(ctx.params.id), { tableIds: ctx.body.tableIds || [], userId: ctx.user.id });
    return { entry: waitlistView(entry), reservation: reservationView(reservation) };
  });
  router.post('/api/r/:rid/waitlist/:id/remove', staff('host'), (ctx) =>
    waitlistView(removeFromWaitlist(app, ctx.restaurant, int(ctx.params.id), String(ctx.body.status || 'left'))),
  );

  // ---- Reports --------------------------------------------------------------------
  router.get('/api/r/:rid/reports', staff('manager'), (ctx) => {
    const today = localDate(app.now(), ctx.restaurant.timezone);
    return buildReport(db, ctx.restaurant, ctx.query.from || addDays(today, -29), ctx.query.to || today, app.now());
  });

  // ---- Team -----------------------------------------------------------------------
  const team = (rid) =>
    db.all(
      `SELECT u.id, u.email, u.name, m.role, u.last_login_at, (u.password_hash = 'invited') AS pending
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.restaurant_id = ? ORDER BY m.role DESC, u.name`,
      rid,
    ).map((m) => ({ ...m, pending: Boolean(m.pending) }));

  router.get('/api/r/:rid/staff', staff('manager'), (ctx) => team(ctx.restaurant.id));

  router.post('/api/r/:rid/staff', staff('owner'), (ctx) => {
    const email = validateEmail(ctx.body.email);
    const role = ['owner', 'manager', 'host'].includes(ctx.body.role) ? ctx.body.role : 'host';
    const name = String(ctx.body.name ?? '').trim().slice(0, 100);
    const now = app.now();
    let user = db.one('SELECT * FROM users WHERE email = ?', email);
    const existing = Boolean(user);
    if (user && db.one('SELECT 1 FROM memberships WHERE user_id = ? AND restaurant_id = ?', user.id, ctx.restaurant.id)) {
      throw new HttpError(409, 'exists', 'That person is already on the team.');
    }
    db.tx(() => {
      if (!user) {
        const { id } = db.run("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, 'invited', ?)", email, name, now);
        user = { id, email };
      }
      db.run('INSERT INTO memberships (user_id, restaurant_id, role, created_at) VALUES (?, ?, ?, ?)', user.id, ctx.restaurant.id, role, now);
      const link = existing ? `${app.config.baseUrl}/login` : `${app.config.baseUrl}/reset?token=${createResetToken(app, user.id, 7 * 86400_000)}&invite=1`;
      app.notify.queueAccountEmail(email, 'staff_invite', { link, existing, restaurantName: ctx.restaurant.name, inviter: ctx.user.name || ctx.user.email });
    });
    audit(app, ctx, 'staff.added', 'user', user.id, { email, role });
    return team(ctx.restaurant.id);
  });

  const owners = (rid) => db.one("SELECT count(*) AS n FROM memberships WHERE restaurant_id = ? AND role = 'owner'", rid).n;

  router.patch('/api/r/:rid/staff/:uid', staff('owner'), (ctx) => {
    const role = ctx.body.role;
    if (!['owner', 'manager', 'host'].includes(role)) throw new HttpError(400, 'invalid', 'Unknown role.');
    const m = db.one('SELECT role FROM memberships WHERE user_id = ? AND restaurant_id = ?', int(ctx.params.uid), ctx.restaurant.id);
    if (!m) throw new HttpError(404, 'not_found', 'Not on this team.');
    if (m.role === 'owner' && role !== 'owner' && owners(ctx.restaurant.id) <= 1) throw new HttpError(409, 'last_owner', 'Every restaurant needs at least one owner.');
    db.run('UPDATE memberships SET role = ? WHERE user_id = ? AND restaurant_id = ?', role, int(ctx.params.uid), ctx.restaurant.id);
    audit(app, ctx, 'staff.role', 'user', int(ctx.params.uid), { role });
    return team(ctx.restaurant.id);
  });

  router.delete('/api/r/:rid/staff/:uid', staff('owner'), (ctx) => {
    const m = db.one('SELECT role FROM memberships WHERE user_id = ? AND restaurant_id = ?', int(ctx.params.uid), ctx.restaurant.id);
    if (!m) throw new HttpError(404, 'not_found', 'Not on this team.');
    if (m.role === 'owner' && owners(ctx.restaurant.id) <= 1) throw new HttpError(409, 'last_owner', 'Every restaurant needs at least one owner.');
    db.run('DELETE FROM memberships WHERE user_id = ? AND restaurant_id = ?', int(ctx.params.uid), ctx.restaurant.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ?)', int(ctx.params.uid), int(ctx.params.uid));
    audit(app, ctx, 'staff.removed', 'user', int(ctx.params.uid));
    return team(ctx.restaurant.id);
  });

  // ---- Import / export --------------------------------------------------------------
  router.post('/api/r/:rid/import/preview', staff('manager'), (ctx) => previewImport(ctx.body.csv, ctx.body.kind === 'reservations' ? 'reservations' : 'guests'));

  router.post('/api/r/:rid/import/commit', staff('manager'), (ctx) => {
    const kind = ctx.body.kind === 'reservations' ? 'reservations' : 'guests';
    const result =
      kind === 'guests'
        ? importGuests(app, ctx.restaurant, ctx.body.csv, ctx.body.mapping)
        : importReservations(app, ctx.restaurant, ctx.body.csv, { mapping: ctx.body.mapping, includePast: Boolean(ctx.body.includePast) });
    audit(app, ctx, `import.${kind}`, 'restaurant', ctx.restaurant.id, { created: result.created, skipped: result.skipped });
    return result;
  });

  router.get('/api/r/:rid/export/guests.csv', staff('manager'), (ctx) => sendCsv(ctx.res, `${ctx.restaurant.slug}-guests.csv`, exportGuestsCsv(db, ctx.restaurant)));
  router.get('/api/r/:rid/export/reservations.csv', staff('manager'), (ctx) =>
    sendCsv(ctx.res, `${ctx.restaurant.slug}-reservations.csv`, exportReservationsCsv(db, ctx.restaurant)),
  );
  router.get('/api/r/:rid/export/all.json', staff('owner'), (ctx) => {
    audit(app, ctx, 'export.all', 'restaurant', ctx.restaurant.id);
    const body = JSON.stringify(exportAll(db, ctx.restaurant), null, 2);
    sendText(ctx.res, 200, body, 'application/json; charset=utf-8', {
      'Content-Disposition': `attachment; filename="${ctx.restaurant.slug}-export.json"`,
      'Cache-Control': 'no-store',
    });
  });

  // ---- License ----------------------------------------------------------------------
  router.post('/api/r/:rid/license/checkout', staff('owner'), async (ctx) => {
    const key = app.config.platformStripe.secretKey;
    if (!key) throw new HttpError(409, 'unavailable', `Online payment is not set up. Email ${app.config.brand.supportEmail} to activate.`);
    if (licenseState(ctx.restaurant, app.now()).kind === 'lifetime') throw new HttpError(409, 'invalid', 'This location already has a lifetime license.');
    const { url } = await createLicenseCheckout(key, {
      restaurant: ctx.restaurant,
      priceCents: app.config.license.priceCents,
      brand: app.config.brand.name,
      email: ctx.user.email,
      successUrl: `${app.config.baseUrl}/app#/settings/license?paid=1`,
      cancelUrl: `${app.config.baseUrl}/app#/settings/license`,
      fetchImpl: app.fetch,
    });
    return { url };
  });

  // ---- Live updates and logs ----------------------------------------------------------
  router.get('/api/r/:rid/events', staff('host'), (ctx) => app.events.subscribe(ctx.restaurant.id, ctx.req, ctx.res));

  router.get('/api/r/:rid/activity', staff('manager'), (ctx) =>
    db
      .all(
        `SELECT a.action, a.entity, a.entity_id, a.detail, a.created_at, u.name AS user_name, u.email AS user_email
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.restaurant_id = ? ORDER BY a.id DESC LIMIT 200`,
        ctx.restaurant.id,
      )
      .map((a) => ({ ...a, detail: parseJson(a.detail, null) })),
  );

  router.get('/api/r/:rid/messages', staff('manager'), (ctx) =>
    db.all(
      `SELECT id, kind, channel, recipient, subject, status, attempts, error, created_at, sent_at FROM outbox
        WHERE restaurant_id = ? ORDER BY id DESC LIMIT 200`,
      ctx.restaurant.id,
    ),
  );
}
