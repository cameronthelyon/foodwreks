// Walk-in waitlist. Quotes are estimated from the live floor: when does a
// table that fits this party next free up for a full turn, given who is
// already waiting ahead?

import { planDay, turnTimeFor } from './availability.js';
import { dayContext, restaurantSettings } from './restaurants.js';
import { findOrCreateGuest, normalizePhone, splitName } from './guests.js';
import { createReservation } from './reservations.js';
import { hmac, safeEqual } from './crypto.js';
import { serviceNow } from './time.js';
import { HttpError } from './http.js';
import { canTakeOnlineBookings } from './license.js';

const OPEN = ['waiting', 'notified'];

export function waitlistToken(app, entry) {
  return hmac(app.keys.waitlist, `${entry.id}.${entry.created_at}`, 'base64url').slice(0, 24);
}

export function verifyWaitlistToken(app, entry, token) {
  return Boolean(entry && token && safeEqual(String(token), waitlistToken(app, entry)));
}

export function waitlistView(e) {
  return {
    id: e.id,
    name: e.name,
    phone: e.phone,
    partySize: e.party_size,
    quotedMin: e.quoted_min,
    status: e.status,
    source: e.source,
    notes: e.notes,
    guestId: e.guest_id,
    reservationId: e.reservation_id,
    createdAt: e.created_at,
    notifiedAt: e.notified_at,
    seatedAt: e.seated_at,
  };
}

// Earliest minute >= from at which the unit is free for `duration`.
function earliestFree(tableIds, occ, from, duration) {
  const intervals = tableIds.flatMap((id) => occ.get(id) || []).sort((a, b) => a.start - b.start);
  let t = from;
  for (let guard = 0; guard < 200; guard++) {
    const clash = intervals.find((iv) => t < iv.end && iv.start < t + duration);
    if (!clash) return t;
    t = clash.end;
  }
  return null;
}

export function estimateWait(app, restaurant, partySize, { excludeId = null } = {}) {
  const { db } = app;
  const now = app.now();
  const { date, minutes: nowMin } = serviceNow(now, restaurant.timezone);
  const settings = restaurantSettings(restaurant);
  const ctx = dayContext(db, restaurant, date, { nowMs: now, channel: 'staff' });
  const plan = planDay(ctx);
  const duration = turnTimeFor(settings, partySize);
  const units = plan.staffUnits.filter((u) => partySize >= u.min && partySize <= u.max && !u.combo);
  if (!units.length) return null;
  const freeTimes = units
    .map((u) => earliestFree(u.tableIds, plan.occ, nowMin, duration))
    .filter((t) => t != null)
    .sort((a, b) => a - b);
  if (!freeTimes.length) return null;
  // Parties already waiting that compete for the same tables go first.
  const maxFit = Math.max(...units.map((u) => u.max));
  const ahead = db.one(
    `SELECT count(*) AS n FROM waitlist WHERE restaurant_id = ? AND date = ? AND status IN ('waiting', 'notified')
       AND party_size <= ? AND (? IS NULL OR id != ?)`,
    restaurant.id,
    date,
    maxFit,
    excludeId,
    excludeId,
  ).n;
  const turns = Math.floor(ahead / freeTimes.length);
  const slot = freeTimes[ahead % freeTimes.length] + turns * duration;
  const minutes = Math.max(0, slot - nowMin);
  return Math.min(240, Math.ceil(minutes / 5) * 5);
}

export function addToWaitlist(app, restaurant, input, { source = 'staff', userId = null } = {}) {
  const { db } = app;
  const now = app.now();
  const name = String(input.name ?? '').trim().slice(0, 120);
  const partySize = Number(input.partySize);
  if (!name) throw new HttpError(400, 'invalid', 'Name is required.');
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 100) throw new HttpError(400, 'invalid', 'Party size must be 1-100.');
  const phone = input.phone ? normalizePhone(input.phone, restaurant.country) : null;
  if (input.phone && !phone) throw new HttpError(400, 'invalid', 'That phone number does not look right.');
  if (source === 'online') {
    const settings = restaurantSettings(restaurant);
    if (!settings.waitlistOnline || !canTakeOnlineBookings(restaurant, now)) {
      throw new HttpError(403, 'waitlist_closed', 'The online waitlist is not open right now.');
    }
    if (!phone) throw new HttpError(400, 'invalid', 'A mobile number is required so we can text you.');
    if (partySize > settings.maxPartySize) throw new HttpError(400, 'invalid', 'Please see the host for large parties.');
  }
  const date = serviceNow(now, restaurant.timezone).date;
  const quoted =
    input.quotedMin !== undefined && input.quotedMin !== null && input.quotedMin !== ''
      ? Math.max(0, Math.min(600, Number.parseInt(input.quotedMin, 10) || 0))
      : estimateWait(app, restaurant, partySize) ?? 0;

  const entry = db.tx(() => {
    const { firstName, lastName } = splitName(name);
    const guest = phone ? findOrCreateGuest(db, restaurant.id, { firstName, lastName, phone }, now) : null;
    const { id } = db.run(
      `INSERT INTO waitlist (restaurant_id, guest_id, date, name, phone, party_size, quoted_min, source, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      restaurant.id,
      guest?.id ?? null,
      date,
      name,
      phone,
      partySize,
      quoted,
      source,
      String(input.notes ?? '').slice(0, 500),
      now,
    );
    const row = db.one('SELECT * FROM waitlist WHERE id = ?', id);
    db.run(
      'INSERT INTO audit_log (restaurant_id, user_id, action, entity, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      restaurant.id,
      userId,
      'waitlist.added',
      'waitlist',
      id,
      now,
    );
    if (phone && input.notify !== false) {
      const status = `${app.config.baseUrl}/w/${row.id}?t=${waitlistToken(app, row)}`;
      app.notify.queueWaitlist(restaurant, row, 'waitlist_added', { links: { status } });
    }
    return row;
  });
  app.events.publish(restaurant.id, { type: 'waitlist', date });
  return entry;
}

function getEntry(db, restaurantId, id) {
  const e = db.one('SELECT * FROM waitlist WHERE id = ? AND restaurant_id = ?', id, restaurantId);
  if (!e) throw new HttpError(404, 'not_found', 'Waitlist entry not found.');
  return e;
}

export function notifyReady(app, restaurant, id) {
  const { db } = app;
  const entry = db.tx(() => {
    const e = getEntry(db, restaurant.id, id);
    if (!OPEN.includes(e.status)) throw new HttpError(409, 'closed', 'This party is no longer waiting.');
    if (!e.phone) throw new HttpError(409, 'no_phone', 'No phone number to text.');
    const queued = app.notify.queueWaitlist(restaurant, e, 'waitlist_ready');
    if (!queued) throw new HttpError(409, 'sms_unavailable', 'Text messaging is not set up for this account.');
    db.run("UPDATE waitlist SET status = 'notified', notified_at = ? WHERE id = ?", app.now(), e.id);
    return db.one('SELECT * FROM waitlist WHERE id = ?', e.id);
  });
  app.events.publish(restaurant.id, { type: 'waitlist', date: entry.date });
  return entry;
}

export function seatFromWaitlist(app, restaurant, id, { tableIds = [], userId = null } = {}) {
  const { db } = app;
  const now = app.now();
  return db.tx(() => {
    const e = getEntry(db, restaurant.id, id);
    if (!OPEN.includes(e.status)) throw new HttpError(409, 'closed', 'This party is no longer waiting.');
    // Seated now, on the current service day (12:10 AM is minute 1450 of
    // the night before), whatever day the party joined the list.
    const { date: seatDate, minutes: seatMin } = serviceNow(now, restaurant.timezone);
    const { reservation } = createReservation(
      app,
      restaurant,
      {
        date: seatDate,
        time: seatMin,
        partySize: e.party_size,
        name: e.name,
        phone: e.phone,
        source: 'walkin',
        status: 'seated',
        tableIds,
        allowUnassigned: true,
        force: tableIds.length > 0,
        staffNotes: e.notes,
        notify: false,
      },
      { channel: 'staff', userId },
    );
    db.run("UPDATE waitlist SET status = 'seated', seated_at = ?, reservation_id = ? WHERE id = ?", now, reservation.id, e.id);
    app.events.publish(restaurant.id, { type: 'waitlist', date: e.date });
    return { entry: db.one('SELECT * FROM waitlist WHERE id = ?', e.id), reservation };
  });
}

export function removeFromWaitlist(app, restaurant, id, status = 'left') {
  const { db } = app;
  if (!['left', 'cancelled', 'waiting'].includes(status)) throw new HttpError(400, 'invalid', 'Unknown status.');
  const e = getEntry(db, restaurant.id, id);
  if (status === 'waiting') {
    if (!['left', 'cancelled', 'notified'].includes(e.status)) throw new HttpError(409, 'invalid', 'Cannot restore this entry.');
    db.run("UPDATE waitlist SET status = 'waiting', removed_at = NULL WHERE id = ?", e.id);
  } else {
    if (!OPEN.includes(e.status)) throw new HttpError(409, 'closed', 'This party is no longer waiting.');
    db.run('UPDATE waitlist SET status = ?, removed_at = ? WHERE id = ?', status, app.now(), e.id);
  }
  app.events.publish(restaurant.id, { type: 'waitlist', date: e.date });
  return db.one('SELECT * FROM waitlist WHERE id = ?', e.id);
}

export function updateWaitlistEntry(app, restaurant, id, patch) {
  const { db } = app;
  const e = getEntry(db, restaurant.id, id);
  const quoted = patch.quotedMin !== undefined ? Math.max(0, Math.min(600, Number.parseInt(patch.quotedMin, 10) || 0)) : e.quoted_min;
  const notes = patch.notes !== undefined ? String(patch.notes).slice(0, 500) : e.notes;
  const party = patch.partySize !== undefined ? Number(patch.partySize) : e.party_size;
  if (!Number.isInteger(party) || party < 1 || party > 100) throw new HttpError(400, 'invalid', 'Party size must be 1-100.');
  db.run('UPDATE waitlist SET quoted_min = ?, notes = ?, party_size = ? WHERE id = ?', quoted, notes, party, e.id);
  app.events.publish(restaurant.id, { type: 'waitlist', date: e.date });
  return db.one('SELECT * FROM waitlist WHERE id = ?', e.id);
}

export function waitlistForDay(db, restaurant, date) {
  return db
    .all('SELECT * FROM waitlist WHERE restaurant_id = ? AND date = ? ORDER BY created_at, id', restaurant.id, date)
    .map(waitlistView);
}

// What a guest sees on their status page.
export function publicWaitlistStatus(app, restaurant, entry) {
  const ahead = OPEN.includes(entry.status)
    ? app.db.one(
        `SELECT count(*) AS n FROM waitlist WHERE restaurant_id = ? AND date = ? AND status IN ('waiting', 'notified')
           AND created_at < ?`,
        restaurant.id,
        entry.date,
        entry.created_at,
      ).n
    : 0;
  return {
    restaurant: { name: restaurant.name, phone: restaurant.phone },
    name: entry.name.split(/\s+/)[0],
    partySize: entry.party_size,
    status: entry.status,
    position: OPEN.includes(entry.status) ? ahead + 1 : null,
    quotedMin: entry.quoted_min,
    waitedMin: Math.max(0, Math.round((app.now() - entry.created_at) / 60000)),
  };
}
