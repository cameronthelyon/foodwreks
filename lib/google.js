// Google Actions Center, "Reservations end-to-end" (formerly Reserve with
// Google). Google calls a booking server we host; we upload daily feeds.
// Written against the v3 REST docs:
//   developers.google.com/actions-center/verticals/reservations/e2e
// STATUS: requires Google partner approval and sandbox review before any
// traffic flows. The day-one path needs none of this: each restaurant adds
// its booking link (with ?ref=google) to its Google Business Profile.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { computeAvailability, turnTimeFor } from './availability.js';
import { dayContext, loadFloor, loadShifts, restaurantSettings } from './restaurants.js';
import { cancelByGuest, createReservation, modifyByGuest } from './reservations.js';
import { canTakeOnlineBookings } from './license.js';
import { addDays, localDate, localMinutes, zonedToUtc } from './time.js';
import { randomToken, safeEqual } from './crypto.js';
import { HttpError } from './http.js';

export const SERVICE_ID = 'dining';

const STATUS = {
  pending: 'PENDING_MERCHANT_CONFIRMATION',
  booked: 'CONFIRMED',
  confirmed: 'CONFIRMED',
  arrived: 'CONFIRMED',
  seated: 'CONFIRMED',
  completed: 'CONFIRMED',
  cancelled: 'CANCELED',
  no_show: 'NO_SHOW',
};

export function googleAuthorized(req, config) {
  const { bookingUser, bookingPassword } = config.google;
  if (!bookingUser || !bookingPassword) return false;
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), bookingUser) && safeEqual(decoded.slice(i + 1), bookingPassword);
}

const enabled = (r, now) => restaurantSettings(r).googleEndToEnd && canTakeOnlineBookings(r, now);

function merchant(app, merchantId) {
  const r = app.db.one('SELECT * FROM restaurants WHERE slug = ?', String(merchantId ?? ''));
  if (!r || !enabled(r, app.now())) throw new HttpError(400, 'unknown_merchant', 'Unknown merchant_id.');
  return r;
}

// A UTC instant -> service date + minutes. Slots after midnight belong to the
// previous service date when that date's grid has them.
function serviceTime(restaurant, startMs) {
  const date = localDate(startMs, restaurant.timezone);
  return { date, minutes: localMinutes(startMs, restaurant.timezone), prevDate: addDays(date, -1) };
}

function cardRequired(settings, party) {
  return settings.cardRequiredMinParty > 0 && party >= settings.cardRequiredMinParty;
}

function bookingObject(restaurant, r) {
  const [given, ...rest] = String(r.guest_name || '').split(' ');
  return {
    booking_id: r.code,
    slot: {
      merchant_id: restaurant.slug,
      service_id: SERVICE_ID,
      start_sec: String(Math.floor(r.starts_at / 1000)),
      duration_sec: String(r.duration_min * 60),
      resources: { party_size: r.party_size },
    },
    user_information: {
      user_id: String(r.external_ref || '').replace(/^google:/, ''),
      given_name: given || '',
      family_name: rest.join(' '),
      telephone: r.guest_phone || '',
      email: r.guest_email || '',
    },
    status: STATUS[r.status],
    payment_information: { prepayment_status: 'PREPAYMENT_NOT_PROVIDED' },
  };
}

function failure(cause, description) {
  return { booking_failure: { cause, description } };
}

function remember(app, key, response) {
  app.db.run('INSERT OR REPLACE INTO idempotency (key, response, created_at) VALUES (?, ?, ?)', key, JSON.stringify(response), app.now());
  return response;
}

function recall(app, key) {
  const row = key ? app.db.one('SELECT response FROM idempotency WHERE key = ?', key) : null;
  return row ? JSON.parse(row.response) : null;
}

export function healthCheck() {
  return {};
}

export function batchAvailabilityLookup(app, body) {
  const restaurant = merchant(app, body.merchant_id);
  const settings = restaurantSettings(restaurant);
  const now = app.now();
  const floor = loadFloor(app.db, restaurant.id);
  const shifts = loadShifts(app.db, restaurant.id);
  const cache = new Map();
  const lookup = (date, party) => {
    const key = `${date}:${party}`;
    if (!cache.has(key)) {
      const ctx = dayContext(app.db, restaurant, date, { nowMs: now, channel: 'online', floor, shifts });
      cache.set(key, computeAvailability({ ...ctx, partySize: party }));
    }
    return cache.get(key);
  };
  const slotTimeAvailability = (body.slot_time || []).map((st) => {
    const party = Number(st.resource_ids?.party_size || 0);
    let available = false;
    if (st.service_id === SERVICE_ID && party > 0 && !cardRequired(settings, party)) {
      const { date, minutes, prevDate } = serviceTime(restaurant, Number(st.start_sec) * 1000);
      available =
        lookup(date, party).slots.some((s) => s.time === minutes && s.available) ||
        lookup(prevDate, party).slots.some((s) => s.time === minutes + 1440 && s.available);
    }
    return { slot_time: st, available };
  });
  return { slot_time_availability: slotTimeAvailability };
}

export function createBooking(app, body) {
  const key = body.idempotency_token ? `google:create:${body.idempotency_token}` : null;
  const prior = recall(app, key);
  if (prior) return prior;
  const slot = body.slot || {};
  const restaurant = merchant(app, slot.merchant_id);
  if (slot.service_id !== SERVICE_ID) throw new HttpError(400, 'unknown_service', 'Unknown service_id.');
  const settings = restaurantSettings(restaurant);
  const party = Number(slot.resources?.party_size || 0);
  if (!party || cardRequired(settings, party)) return remember(app, key, failure('SLOT_UNAVAILABLE', 'Not bookable for this party size.'));
  const user = body.user_information || {};
  let { date, minutes, prevDate } = serviceTime(restaurant, Number(slot.start_sec) * 1000);
  const ctx = dayContext(app.db, restaurant, prevDate, { nowMs: app.now(), channel: 'online' });
  if (computeAvailability({ ...ctx, partySize: party }).slots.some((s) => s.time === minutes + 1440)) {
    date = prevDate;
    minutes += 1440;
  }
  try {
    const { reservation } = createReservation(
      app,
      restaurant,
      {
        date,
        time: minutes,
        partySize: party,
        firstName: user.given_name || 'Guest',
        lastName: user.family_name || '',
        phone: user.telephone || undefined,
        email: user.email || undefined,
        notes: body.additional_request || '',
        source: 'google',
        externalRef: user.user_id ? `google:${user.user_id}` : null,
      },
      { channel: 'online' },
    );
    return remember(app, key, { booking: bookingObject(restaurant, reservation) });
  } catch (err) {
    if (err instanceof HttpError && [403, 409].includes(err.status)) {
      return remember(app, key, failure('SLOT_UNAVAILABLE', err.message));
    }
    if (err instanceof HttpError && err.status === 400) return remember(app, key, failure('CAUSE_UNSPECIFIED', err.message));
    throw err;
  }
}

function findBooking(app, bookingId) {
  const r = app.db.one("SELECT * FROM reservations WHERE code = ? AND source = 'google'", String(bookingId ?? ''));
  if (!r) throw new HttpError(400, 'unknown_booking', 'Unknown booking_id.');
  const restaurant = app.db.one('SELECT * FROM restaurants WHERE id = ?', r.restaurant_id);
  return { r, restaurant };
}

export function updateBooking(app, body) {
  const key = body.idempotency_token ? `google:update:${body.idempotency_token}` : null;
  const prior = recall(app, key);
  if (prior) return prior;
  const b = body.booking || {};
  const { r, restaurant } = findBooking(app, b.booking_id);
  const mask = String(typeof body.update_mask === 'object' ? (body.update_mask.paths || []).join(',') : body.update_mask || '');
  try {
    if (mask.includes('status') && b.status === 'CANCELED') {
      if (r.status === 'cancelled') return remember(app, key, failure('BOOKING_ALREADY_CANCELLED', 'Already cancelled.'));
      const row = cancelByGuest(app, restaurant, r);
      return remember(app, key, { booking: bookingObject(restaurant, row) });
    }
    const patch = {};
    if (mask.includes('start_sec') && b.slot?.start_sec) {
      const t = serviceTime(restaurant, Number(b.slot.start_sec) * 1000);
      patch.date = t.date;
      patch.time = t.minutes;
    }
    if (mask.includes('party_size') && b.slot?.resources?.party_size) patch.partySize = Number(b.slot.resources.party_size);
    const row = Object.keys(patch).length ? modifyByGuest(app, restaurant, r, patch) : r;
    return remember(app, key, { booking: bookingObject(restaurant, row) });
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.code === 'too_late') return remember(app, key, failure('OUTSIDE_CANCELLATION_WINDOW', err.message));
      if (err.code === 'not_cancellable' || err.code === 'not_editable') return remember(app, key, failure('BOOKING_NOT_CANCELLABLE', err.message));
      if (err.status === 409) return remember(app, key, failure('SLOT_UNAVAILABLE', err.message));
    }
    throw err;
  }
}

export function getBookingStatus(app, body) {
  const { r } = findBooking(app, body.booking_id);
  return { booking_id: r.code, booking_status: STATUS[r.status], prepayment_status: 'PREPAYMENT_NOT_PROVIDED' };
}

export function listBookings(app, body) {
  const rows = app.db.all(
    `SELECT * FROM reservations WHERE source = 'google' AND external_ref = ? AND status NOT IN ('cancelled', 'no_show', 'completed')
       AND starts_at > ? ORDER BY starts_at`,
    `google:${body.user_id}`,
    app.now(),
  );
  return {
    bookings: rows.map((r) => bookingObject(app.db.one('SELECT * FROM restaurants WHERE id = ?', r.restaurant_id), r)),
  };
}

// ---- Feeds (uploaded daily by SFTP; see docs/INTEGRATIONS.md) --------------

function metadata(app) {
  return {
    processing_instruction: 'PROCESS_AS_COMPLETE',
    shard_number: 0,
    total_shards: 1,
    nonce: randomToken(8),
    generation_timestamp: String(Math.floor(app.now() / 1000)),
  };
}

const feedRestaurants = (app) => app.db.all('SELECT * FROM restaurants ORDER BY id').filter((r) => enabled(r, app.now()));

export function merchantFeed(app) {
  return {
    metadata: metadata(app),
    merchant: feedRestaurants(app).map((r) => ({
      merchant_id: r.slug,
      name: r.name,
      telephone: r.phone,
      url: r.website || `${app.config.baseUrl}/r/${r.slug}`,
      category: 'restaurant',
      geo: {
        ...(r.latitude != null ? { latitude: r.latitude, longitude: r.longitude } : {}),
        address: { street_address: r.address, locality: r.city, region: r.region, postal_code: r.postal_code, country: r.country },
      },
    })),
  };
}

export function serviceFeed(app) {
  return {
    metadata: metadata(app),
    service: feedRestaurants(app).map((r) => ({
      merchant_id: r.slug,
      service_id: SERVICE_ID,
      localized_service_name: { value: 'Table reservation' },
      prepayment_type: 'NOT_SUPPORTED',
    })),
  };
}

export function availabilityFeed(app, { days = 30 } = {}) {
  const availability = [];
  const now = app.now();
  for (const r of feedRestaurants(app)) {
    const settings = restaurantSettings(r);
    const floor = loadFloor(app.db, r.id);
    const shifts = loadShifts(app.db, r.id);
    const today = localDate(now, r.timezone);
    for (let d = 0; d <= Math.min(days, settings.bookingWindowDays); d++) {
      const date = addDays(today, d);
      const ctx = dayContext(app.db, r, date, { nowMs: now, channel: 'online', floor, shifts });
      for (let party = settings.minPartySize; party <= settings.maxPartySize; party++) {
        if (cardRequired(settings, party)) continue;
        const result = computeAvailability({ ...ctx, partySize: party });
        for (const s of result.slots) {
          if (!s.available) continue;
          availability.push({
            merchant_id: r.slug,
            service_id: SERVICE_ID,
            start_sec: String(Math.floor(zonedToUtc(date, s.time, r.timezone) / 1000)),
            duration_sec: String(turnTimeFor(settings, party) * 60),
            spots_total: 1,
            spots_open: 1,
            resources: { party_size: party },
            confirmation_mode: 'CONFIRMATION_MODE_SYNCHRONOUS',
          });
        }
      }
    }
  }
  return { metadata: metadata(app), service_availability: [{ availability }] };
}

// ---- Real-time booking notifications (Maps Booking API) --------------------
// Required when a Google booking changes on our side (the restaurant cancels,
// marks a no-show). Uses a Google service account; no-op when unconfigured.

let cachedToken = null;

function serviceAccount(config) {
  const raw = config.google.serviceAccount;
  if (!raw) return null;
  try {
    return JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8'));
  } catch {
    return null;
  }
}

async function accessToken(config, fetchImpl, now = Date.now()) {
  if (cachedToken && cachedToken.expiresAt - now > 60_000) return cachedToken.token;
  const sa = serviceAccount(config);
  if (!sa) return null;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/mapsbooking',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${data.error_description || data.error || res.status}`);
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return cachedToken.token;
}

export async function notifyGoogleBooking(app, reservation, fetchImpl = globalThis.fetch) {
  const { partnerId } = app.config.google;
  if (reservation.source !== 'google' || !partnerId) return false;
  const token = await accessToken(app.config, fetchImpl, app.now());
  if (!token) return false;
  const name = `partners/${partnerId}/bookings/${reservation.code}`;
  const res = await fetchImpl(`https://mapsbooking.googleapis.com/v1alpha/notification/${name}?updateMask=status`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, status: STATUS[reservation.status] }),
  });
  if (!res.ok) throw new Error(`Google booking notification failed: ${res.status}`);
  return true;
}
