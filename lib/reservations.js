// Reservation service: the only code that writes reservations. Every write is
// one synchronous transaction that re-checks availability, so two diners can
// never be handed the same table. Notifications are queued in the same
// transaction (outbox pattern) and sent by the worker.

import { resolveBooking, tablesFree, turnTimeFor } from './availability.js';
import { dayContext, loadFloor, restaurantSettings } from './restaurants.js';
import { findOrCreateGuest, normalizeEmail, normalizePhone, refreshGuestStats, splitName } from './guests.js';
import { hmac, randomCode, randomToken, safeEqual } from './crypto.js';
import { calendarSlot, fmt12, isValidDate, zonedToUtc } from './time.js';
import { HttpError } from './http.js';
import { parseJson } from './db.js';
import { canTakeOnlineBookings } from './license.js';

export const STATUSES = ['pending', 'booked', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show'];
export const SOURCES = ['online', 'website', 'google', 'instagram', 'agent', 'phone', 'walkin', 'staff', 'import'];
// 'agent' is set only by the AI agent server (lib/mcp.js), never from a request body.
export const PUBLIC_SOURCES = ['online', 'website', 'google', 'instagram', 'agent'];

// Allowed status moves. Most "backwards" moves exist so hosts can undo a
// mis-tap at a busy stand.
const TRANSITIONS = {
  pending: ['booked', 'cancelled'],
  booked: ['confirmed', 'arrived', 'seated', 'cancelled', 'no_show'],
  confirmed: ['booked', 'arrived', 'seated', 'cancelled', 'no_show'],
  arrived: ['booked', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'],
  seated: ['arrived', 'completed', 'booked', 'confirmed'],
  completed: ['seated'],
  cancelled: ['booked'],
  no_show: ['booked', 'arrived', 'seated', 'completed'],
};
const STAMP = {
  confirmed: 'confirmed_at',
  arrived: 'arrived_at',
  seated: 'seated_at',
  completed: 'completed_at',
};
const HOLDING = new Set(['pending', 'booked', 'confirmed', 'arrived', 'seated']);

export function reservationView(r, guest) {
  const view = {
    id: r.id,
    code: r.code,
    date: r.date,
    time: r.start_min,
    timeLabel: fmt12(r.start_min),
    duration: r.duration_min,
    startsAt: r.starts_at,
    partySize: r.party_size,
    status: r.status,
    source: r.source,
    tableIds: parseJson(r.table_ids, []),
    tableLocked: Boolean(r.table_locked),
    guestId: r.guest_id,
    name: r.guest_name,
    phone: r.guest_phone,
    email: r.guest_email,
    guestNotes: r.guest_notes,
    occasion: r.occasion,
    staffNotes: r.staff_notes,
    card: r.card_status ? { status: r.card_status, feeCents: r.no_show_fee_cents, chargedCents: r.charged_cents } : null,
    spendCents: r.spend_cents,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    seatedAt: r.seated_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
  };
  if (guest) {
    view.guest = {
      id: guest.id,
      tags: parseJson(guest.tags, []),
      notes: guest.notes,
      visits: guest.visit_count,
      noShows: guest.no_show_count,
      cancels: guest.cancel_count,
      spendCents: guest.total_spend_cents,
      lastVisit: guest.last_visit_date,
    };
  }
  return view;
}

// What a diner may see about their own booking. No staff notes, no tables.
export function publicReservationView(r, restaurant) {
  return {
    code: r.code,
    date: r.date,
    displayDate: calendarSlot(r.date, r.start_min).date,
    time: r.start_min,
    timeLabel: fmt12(r.start_min),
    partySize: r.party_size,
    status: r.status,
    name: r.guest_name,
    phone: r.guest_phone,
    email: r.guest_email,
    notes: r.guest_notes,
    occasion: r.occasion,
    card: r.card_status ? { status: r.card_status } : null,
    restaurant: { name: restaurant.name, slug: restaurant.slug, phone: restaurant.phone, address: restaurant.address },
  };
}

function uniqueCode(db) {
  for (let i = 0; i < 10; i++) {
    const code = randomCode(8);
    if (!db.one('SELECT 1 FROM reservations WHERE code = ?', code)) return code;
  }
  throw new Error('Could not allocate a reservation code');
}

// Manage links are derived, not stored: HMAC(secret, code + per-booking salt).
// Reminders can rebuild the link days later; a database leak alone reveals
// nothing; rotating the salt revokes one booking's link.
export function manageToken(app, row) {
  return hmac(app.keys.manage, `${row.code}.${row.manage_salt}`, 'base64url').slice(0, 32);
}

export function manageUrl(app, row) {
  return `${app.config.baseUrl}/m/${row.code}?t=${manageToken(app, row)}`;
}

export function verifyManageToken(app, row, token) {
  return Boolean(row && token && safeEqual(String(token), manageToken(app, row)));
}

function audit(db, restaurantId, userId, action, entityId, detail, now) {
  db.run(
    'INSERT INTO audit_log (restaurant_id, user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    restaurantId,
    userId ?? null,
    action,
    'reservation',
    entityId,
    detail ? JSON.stringify(detail) : null,
    now,
  );
}

function getRow(db, restaurantId, id) {
  const r = db.one('SELECT * FROM reservations WHERE id = ? AND restaurant_id = ?', id, restaurantId);
  if (!r) throw new HttpError(404, 'not_found', 'Reservation not found.');
  return r;
}

function applyMoves(db, restaurantId, moves, userId, now) {
  for (const m of moves) {
    db.run(
      'UPDATE reservations SET table_ids = ?, updated_at = ? WHERE id = ? AND restaurant_id = ? AND table_locked = 0',
      JSON.stringify(m.tableIds),
      now,
      m.reservationId,
      restaurantId,
    );
    audit(db, restaurantId, userId, 'reservation.reseated', m.reservationId, { tableIds: m.tableIds, auto: true }, now);
  }
}

function validateTime(value) {
  const t = Number(value);
  if (!Number.isInteger(t) || t < 0 || t >= 30 * 60) throw new HttpError(400, 'invalid', 'Pick a valid time.');
  return t;
}

function validateParty(value, max = 100) {
  const p = Number(value);
  if (!Number.isInteger(p) || p < 1 || p > max) throw new HttpError(400, 'invalid', `Party size must be 1-${max}.`);
  return p;
}

function hasActiveBooking(db, restaurantId, date, phone, email) {
  if (!phone && !email) return false;
  return Boolean(
    db.one(
      `SELECT 1 FROM reservations WHERE restaurant_id = ? AND date = ? AND status IN ('pending', 'booked', 'confirmed')
         AND ((? IS NOT NULL AND guest_phone = ?) OR (? IS NOT NULL AND guest_email = ?)) LIMIT 1`,
      restaurantId,
      date,
      phone,
      phone,
      email,
      email,
    ),
  );
}

function checkTables(db, restaurantId, tableIds) {
  if (tableIds !== undefined && tableIds !== null && !Array.isArray(tableIds)) throw new HttpError(400, 'invalid', 'tableIds must be a list.');
  const ids = [...new Set((tableIds || []).map(Number))];
  if (ids.some((id) => !Number.isInteger(id))) throw new HttpError(400, 'invalid', 'Unknown table.');
  if (!ids.length) return [];
  const found = db.all(
    `SELECT id FROM tables WHERE restaurant_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    restaurantId,
    ...ids,
  );
  if (found.length !== ids.length) throw new HttpError(400, 'invalid', 'Unknown table.');
  return ids.sort((a, b) => a - b);
}

// Creates a reservation.
//   channel 'online': public booking page rules (license, grid, notice, pacing).
//   channel 'staff':  host stand rules (any time, optional manual tables).
// `trustedContact` is set only by server-side callers whose contact details
// come verified from elsewhere (the Google booking server). It is never
// derived from anything a client sends.
export function createReservation(app, restaurant, input, { channel = 'online', userId = null, trustedContact = false } = {}) {
  const { db } = app;
  const now = app.now();
  const settings = restaurantSettings(restaurant);

  if (!isValidDate(input.date)) throw new HttpError(400, 'invalid', 'Pick a valid date.');
  const time = validateTime(input.time);
  const partySize = validateParty(input.partySize);
  let { firstName, lastName } = input;
  if (!firstName && !lastName && input.name) ({ firstName, lastName } = splitName(input.name));
  firstName = String(firstName ?? '').trim().slice(0, 80);
  lastName = String(lastName ?? '').trim().slice(0, 80);
  const phone = input.phone ? normalizePhone(input.phone, restaurant.country) : null;
  const email = input.email ? normalizeEmail(input.email) : null;
  if (input.phone && !phone) throw new HttpError(400, 'invalid', 'That phone number does not look right.');
  if (input.email && !email) throw new HttpError(400, 'invalid', 'That email does not look right.');

  let source;
  let status = 'booked';
  if (channel === 'online') {
    if (!canTakeOnlineBookings(restaurant, now)) {
      throw new HttpError(403, 'booking_unavailable', 'Online booking is not available right now. Please call the restaurant.');
    }
    source = PUBLIC_SOURCES.includes(input.source) ? input.source : 'online';
    if (!firstName) throw new HttpError(400, 'invalid', 'Please enter your name.');
    if (!trustedContact) {
      if (settings.requirePhone && !phone) throw new HttpError(400, 'invalid', 'Please enter a phone number.');
      if (settings.requireEmail && !email) throw new HttpError(400, 'invalid', 'Please enter an email address.');
    }
    if (!phone && !email) throw new HttpError(400, 'invalid', 'Please enter a phone number or email.');
  } else {
    if (!firstName && !lastName) throw new HttpError(400, 'invalid', 'Guest name is required.');
    source = SOURCES.includes(input.source) ? input.source : 'phone';
    if (input.status && ['booked', 'confirmed', 'arrived', 'seated'].includes(input.status)) status = input.status;
  }

  const cardRequired =
    channel === 'online' &&
    settings.cardRequiredMinParty > 0 &&
    partySize >= settings.cardRequiredMinParty &&
    Boolean(input.cardAvailable);
  if (cardRequired) status = 'pending';

  const result = db.tx(() => {
    const ctx = dayContext(db, restaurant, input.date, { nowMs: now, channel });
    let duration;
    let tableIds;
    let tableLocked = 0;
    let warnings = [];

    if (channel === 'staff' && input.tableIds?.length) {
      tableIds = checkTables(db, restaurant.id, input.tableIds);
      duration = Number(input.duration) > 0 ? Math.min(600, Number(input.duration)) : turnTimeFor(settings, partySize);
      const check = tablesFree(ctx, tableIds, time, duration);
      if (!check.free && !input.force) {
        throw new HttpError(409, 'table_conflict', 'Those tables are taken at that time.', { conflicts: check.conflicts });
      }
      if (!check.free) warnings.push('table_conflict');
      tableLocked = 1;
    } else {
      const decision = resolveBooking({
        ...ctx,
        time,
        partySize,
        duration: channel === 'staff' && Number(input.duration) > 0 ? Math.min(600, Number(input.duration)) : undefined,
        allowUnassigned: channel === 'staff' && Boolean(input.allowUnassigned),
      });
      if (!decision.ok) {
        throw new HttpError(409, 'unavailable', decision.message || 'That time is not available.', { reason: decision.reason });
      }
      duration = decision.duration;
      tableIds = decision.tableIds;
      warnings = decision.warnings;
      // One active online booking per person per service date: stops
      // double-submits and table hoarding. Checked only after the request is
      // otherwise valid and bookable, and the reply never says when the other
      // booking is, so it cannot be used to look up someone's plans.
      if (channel === 'online' && hasActiveBooking(db, restaurant.id, input.date, phone, email)) {
        throw new HttpError(409, 'duplicate', 'You already have a reservation that day. Use the link in your confirmation to change it.');
      }
      applyMoves(db, restaurant.id, decision.moves, userId, now);
    }

    const guest = findOrCreateGuest(
      db,
      restaurant.id,
      { firstName, lastName, phone, email, marketingOptIn: Boolean(input.marketingOptIn), country: restaurant.country },
      now,
    );
    const code = uniqueCode(db);
    const stamps = { confirmed_at: null, arrived_at: null, seated_at: null };
    if (status === 'confirmed') stamps.confirmed_at = now;
    if (status === 'arrived') stamps.arrived_at = now;
    if (status === 'seated') stamps.seated_at = now;

    const { id } = db.run(
      `INSERT INTO reservations (restaurant_id, guest_id, code, date, start_min, duration_min, starts_at, party_size,
         status, source, table_ids, table_locked, guest_name, guest_phone, guest_email, guest_notes, occasion,
         staff_notes, manage_salt, card_status, no_show_fee_cents, external_ref, created_by, created_at,
         updated_at, confirmed_at, arrived_at, seated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      restaurant.id,
      guest?.id ?? null,
      code,
      input.date,
      time,
      duration,
      zonedToUtc(input.date, time, restaurant.timezone),
      partySize,
      status,
      source,
      JSON.stringify(tableIds),
      tableLocked,
      [firstName, lastName].filter(Boolean).join(' '),
      phone,
      email,
      String(input.notes ?? '').slice(0, 1000),
      settings.collectOccasion || channel === 'staff' ? String(input.occasion ?? '').slice(0, 60) : '',
      channel === 'staff' ? String(input.staffNotes ?? '').slice(0, 2000) : '',
      randomToken(8),
      cardRequired ? 'required' : null,
      cardRequired ? settings.noShowFeeCents * partySize : null,
      input.externalRef ?? null,
      userId,
      now,
      now,
      stamps.confirmed_at,
      stamps.arrived_at,
      stamps.seated_at,
    );
    const row = db.one('SELECT * FROM reservations WHERE id = ?', id);
    if (guest) refreshGuestStats(db, guest.id, now);
    audit(db, restaurant.id, userId, 'reservation.created', id, { channel, source, partySize, date: input.date, time }, now);
    if (status !== 'pending' && input.notify !== false) {
      app.notify.queueReservation(restaurant, row, 'confirmation');
      if (channel === 'online' && settings.staffAlertEmail) app.notify.queueStaffAlert(restaurant, row);
    }
    return { row, warnings };
  });

  app.events.publish(restaurant.id, { type: 'reservations', date: input.date });
  return { reservation: result.row, manageToken: manageToken(app, result.row), warnings: result.warnings };
}

// Staff edit: time, date, party, duration, tables, notes, guest details.
export function updateReservation(app, restaurant, id, patch, { userId = null, channel = 'staff' } = {}) {
  const { db } = app;
  const now = app.now();
  const settings = restaurantSettings(restaurant);
  let notifyKind = null;

  const out = db.tx(() => {
    const r = getRow(db, restaurant.id, id);
    if (!HOLDING.has(r.status) && (patch.date || patch.time !== undefined || patch.partySize)) {
      throw new HttpError(409, 'not_editable', 'Only upcoming reservations can be moved.');
    }
    const date = patch.date ?? r.date;
    if (!isValidDate(date)) throw new HttpError(400, 'invalid', 'Pick a valid date.');
    const time = patch.time !== undefined ? validateTime(patch.time) : r.start_min;
    const partySize = patch.partySize !== undefined ? validateParty(patch.partySize) : r.party_size;
    let duration =
      patch.duration !== undefined
        ? Math.min(600, Math.max(15, Number(patch.duration) || r.duration_min))
        : partySize !== r.party_size
          ? turnTimeFor(settings, partySize)
          : r.duration_min;
    let tableIds = parseJson(r.table_ids, []);
    let tableLocked = r.table_locked;
    const moved = date !== r.date || time !== r.start_min || partySize !== r.party_size || duration !== r.duration_min;

    if (patch.tableIds !== undefined && channel === 'staff') {
      tableIds = checkTables(db, restaurant.id, patch.tableIds);
      tableLocked = tableIds.length ? 1 : 0;
      if (tableIds.length) {
        const ctx = dayContext(db, restaurant, date, { nowMs: now, channel: 'staff' });
        const check = tablesFree({ ...ctx, excludeReservationId: r.id }, tableIds, time, duration);
        if (!check.free && !patch.force) {
          throw new HttpError(409, 'table_conflict', 'Those tables are taken at that time.', { conflicts: check.conflicts });
        }
      }
    } else if (moved && HOLDING.has(r.status)) {
      const ctx = dayContext(db, restaurant, date, { nowMs: now, channel });
      // Staff may keep a pinned table even if the party outgrew it (their
      // call); a guest editing online always gets a table that fits.
      const keep =
        tableIds.length &&
        tablesFree({ ...ctx, excludeReservationId: r.id }, tableIds, time, duration).free &&
        (fitsTables(ctx, tableIds, partySize) || (tableLocked && channel === 'staff'));
      if (!keep) {
        const decision = resolveBooking({
          ...ctx,
          time,
          partySize,
          duration: patch.duration !== undefined ? duration : undefined,
          excludeReservationId: r.id,
          allowUnassigned: channel === 'staff' && Boolean(patch.allowUnassigned),
        });
        if (!decision.ok) {
          throw new HttpError(409, 'unavailable', decision.message || 'That time is not available.', { reason: decision.reason });
        }
        duration = decision.duration;
        tableIds = decision.tableIds;
        tableLocked = 0;
        applyMoves(db, restaurant.id, decision.moves, userId, now);
      } else if (channel === 'online') {
        // Diners get the same pacing and notice rules as a fresh booking.
        const decision = resolveBooking({ ...ctx, time, partySize, excludeReservationId: r.id });
        if (!decision.ok) throw new HttpError(409, 'unavailable', decision.message || 'That time is not available.');
      }
    }

    let phone = r.guest_phone;
    let email = r.guest_email;
    if (patch.phone !== undefined) {
      phone = patch.phone ? normalizePhone(patch.phone, restaurant.country) : null;
      if (patch.phone && !phone) throw new HttpError(400, 'invalid', 'That phone number does not look right.');
    }
    if (patch.email !== undefined) {
      email = patch.email ? normalizeEmail(patch.email) : null;
      if (patch.email && !email) throw new HttpError(400, 'invalid', 'That email does not look right.');
    }
    const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 160) || r.guest_name : r.guest_name;
    let guestId = r.guest_id;
    if ((patch.phone !== undefined || patch.email !== undefined) && (phone || email) && channel === 'staff') {
      const { firstName, lastName } = splitName(name);
      guestId = findOrCreateGuest(db, restaurant.id, { firstName, lastName, phone, email }, now)?.id ?? guestId;
    }

    db.run(
      `UPDATE reservations SET date = ?, start_min = ?, duration_min = ?, starts_at = ?, party_size = ?, table_ids = ?,
         table_locked = ?, guest_name = ?, guest_phone = ?, guest_email = ?, guest_id = ?, guest_notes = ?, occasion = ?,
         staff_notes = ?, reminder_sent_at = CASE WHEN ? THEN NULL ELSE reminder_sent_at END, updated_at = ?
       WHERE id = ?`,
      date,
      time,
      duration,
      zonedToUtc(date, time, restaurant.timezone),
      partySize,
      JSON.stringify(tableIds),
      tableLocked,
      name,
      phone,
      email,
      guestId,
      patch.notes !== undefined ? String(patch.notes).slice(0, 1000) : r.guest_notes,
      patch.occasion !== undefined ? String(patch.occasion).slice(0, 60) : r.occasion,
      patch.staffNotes !== undefined && channel === 'staff' ? String(patch.staffNotes).slice(0, 2000) : r.staff_notes,
      date !== r.date || time !== r.start_min ? 1 : 0,
      now,
      r.id,
    );
    if (guestId !== r.guest_id) refreshGuestStats(db, r.guest_id, now);
    refreshGuestStats(db, guestId, now);
    const row = db.one('SELECT * FROM reservations WHERE id = ?', r.id);
    audit(db, restaurant.id, userId, 'reservation.updated', r.id, { channel, fields: Object.keys(patch) }, now);
    if (date !== r.date || time !== r.start_min || partySize !== r.party_size) {
      notifyKind = 'modified';
      if (patch.notify !== false && HOLDING.has(row.status) && row.status !== 'pending') {
        app.notify.queueReservation(restaurant, row, 'modified');
      }
    }
    return { row, previousDate: r.date };
  });

  app.events.publish(restaurant.id, { type: 'reservations', date: out.row.date });
  if (out.previousDate !== out.row.date) app.events.publish(restaurant.id, { type: 'reservations', date: out.previousDate });
  return { reservation: out.row, notified: notifyKind };
}

function fitsTables(ctx, tableIds, partySize) {
  const tables = ctx.tables.filter((t) => tableIds.includes(t.id));
  if (tables.length === 1) return partySize >= tables[0].min_covers && partySize <= tables[0].max_covers;
  const combo = ctx.combos.find((c) => c.table_ids.length === tableIds.length && c.table_ids.every((id) => tableIds.includes(id)));
  if (combo) return partySize >= combo.min_covers && partySize <= combo.max_covers;
  return partySize <= tables.reduce((a, t) => a + t.max_covers, 0);
}

export function setStatus(app, restaurant, id, status, { userId = null, by = 'restaurant', reason = '', notify = true } = {}) {
  const { db } = app;
  const now = app.now();
  if (!STATUSES.includes(status)) throw new HttpError(400, 'invalid', 'Unknown status.');
  const out = db.tx(() => {
    const r = getRow(db, restaurant.id, id);
    if (r.status === status) return { row: r, changed: false };
    if (!TRANSITIONS[r.status].includes(status)) {
      throw new HttpError(409, 'bad_transition', `Cannot change a ${r.status.replace('_', '-')} reservation to ${status.replace('_', '-')}.`);
    }
    let tableIds = parseJson(r.table_ids, []);
    let tableLocked = r.table_locked;
    // Restoring a cancelled or no-show booking re-checks the floor.
    if (HOLDING.has(status) && !HOLDING.has(r.status)) {
      const ctx = dayContext(db, restaurant, r.date, { nowMs: now, channel: 'staff' });
      const free = tableIds.length && tablesFree({ ...ctx, excludeReservationId: r.id }, tableIds, r.start_min, r.duration_min).free;
      if (!free) {
        const decision = resolveBooking({ ...ctx, time: r.start_min, partySize: r.party_size, duration: r.duration_min, excludeReservationId: r.id, allowUnassigned: true });
        tableIds = decision.tableIds;
        tableLocked = 0;
        applyMoves(db, restaurant.id, decision.moves || [], userId, now);
      }
    }
    const stamp = STAMP[status];
    db.run(
      `UPDATE reservations SET status = ?, table_ids = ?, table_locked = ?, updated_at = ?,
         ${stamp ? `${stamp} = ?,` : ''}
         cancelled_by = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN coalesce(cancelled_at, ?) ELSE NULL END
       WHERE id = ?`,
      ...[status, JSON.stringify(tableIds), tableLocked, now],
      ...(stamp ? [now] : []),
      status === 'cancelled' ? by : null,
      status,
      now,
      r.id,
    );
    const row = db.one('SELECT * FROM reservations WHERE id = ?', r.id);
    refreshGuestStats(db, r.guest_id, now);
    audit(db, restaurant.id, userId, `reservation.${status}`, r.id, { from: r.status, by, reason: reason || undefined }, now);
    if (notify && status === 'cancelled' && r.status !== 'pending') {
      app.notify.queueReservation(restaurant, row, by === 'guest' ? 'cancelled_by_guest' : 'cancelled', { reason });
    }
    if (notify && status === 'booked' && r.status === 'pending') {
      app.notify.queueReservation(restaurant, row, 'confirmation');
    }
    return { row, changed: true };
  });
  if (out.changed) app.events.publish(restaurant.id, { type: 'reservations', date: out.row.date });
  return out.row;
}

// Diner self-service cancel, bounded by the restaurant's cutoff.
export function cancelByGuest(app, restaurant, row) {
  const settings = restaurantSettings(restaurant);
  if (!HOLDING.has(row.status) || ['arrived', 'seated'].includes(row.status)) {
    throw new HttpError(409, 'not_cancellable', 'This reservation can no longer be cancelled online.');
  }
  if (row.status !== 'pending' && row.starts_at - app.now() < settings.cancelCutoffMinutes * 60000) {
    throw new HttpError(409, 'too_late', 'It is too close to your reservation to cancel online. Please call the restaurant.');
  }
  return setStatus(app, restaurant, row.id, 'cancelled', { by: 'guest' });
}

export function modifyByGuest(app, restaurant, row, patch) {
  const settings = restaurantSettings(restaurant);
  if (!['booked', 'confirmed'].includes(row.status)) {
    throw new HttpError(409, 'not_editable', 'This reservation can no longer be changed online.');
  }
  if (row.starts_at - app.now() < settings.cancelCutoffMinutes * 60000) {
    throw new HttpError(409, 'too_late', 'It is too close to your reservation to change it online. Please call the restaurant.');
  }
  if (patch.partySize !== undefined && Number(patch.partySize) > settings.maxPartySize) {
    throw new HttpError(409, 'party_size', settings.largePartyMessage.replace('{max}', String(settings.maxPartySize)));
  }
  const growsIntoCardHold =
    patch.partySize !== undefined &&
    settings.cardRequiredMinParty > 0 &&
    Number(patch.partySize) >= settings.cardRequiredMinParty &&
    row.card_status !== 'on_file' &&
    Boolean(app.integrations?.stripeKey(restaurant.id));
  if (growsIntoCardHold) {
    throw new HttpError(
      409,
      'card_required',
      `Parties of ${settings.cardRequiredMinParty} or more need a card on file. Please cancel and book again for the larger party, or call us.`,
    );
  }
  const allowed = {};
  for (const k of ['date', 'time', 'partySize', 'notes']) if (patch[k] !== undefined) allowed[k] = patch[k];
  return updateReservation(app, restaurant, row.id, allowed, { channel: 'online' }).reservation;
}

export function assignTables(app, restaurant, id, tableIds, { userId = null, force = false } = {}) {
  return updateReservation(app, restaurant, id, { tableIds, force }, { userId, channel: 'staff' }).reservation;
}

// Everything the host stand shows for one service date.
export function dayBook(db, restaurant, date) {
  const rows = db.all(
    `SELECT r.*, g.id AS g_id, g.tags AS g_tags, g.notes AS g_notes, g.visit_count AS g_visits,
            g.no_show_count AS g_no_shows, g.cancel_count AS g_cancels, g.total_spend_cents AS g_spend,
            g.last_visit_date AS g_last
       FROM reservations r LEFT JOIN guests g ON g.id = r.guest_id
      WHERE r.restaurant_id = ? AND r.date = ?
      ORDER BY r.start_min, r.id`,
    restaurant.id,
    date,
  );
  return rows.map((r) =>
    reservationView(
      r,
      r.g_id
        ? {
            id: r.g_id,
            tags: r.g_tags,
            notes: r.g_notes,
            visit_count: r.g_visits,
            no_show_count: r.g_no_shows,
            cancel_count: r.g_cancels,
            total_spend_cents: r.g_spend,
            last_visit_date: r.g_last,
          }
        : null,
    ),
  );
}

export function floorFor(db, restaurant) {
  return loadFloor(db, restaurant.id);
}
