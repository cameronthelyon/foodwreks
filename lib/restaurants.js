// Restaurant configuration: settings, tables, combos, shifts, closures, and
// the "day context" the availability engine consumes.

import { DEFAULT_TURN_TIMES } from './availability.js';
import { parseJson } from './db.js';
import { addDays, isValidDate, isValidTimeZone } from './time.js';
import { HttpError } from './http.js';

export const DEFAULT_SETTINGS = Object.freeze({
  minPartySize: 1,
  maxPartySize: 8,
  bookingWindowDays: 60,
  minNoticeMinutes: 60,
  cancelCutoffMinutes: 120,
  slotInterval: 15,
  bufferMinutes: 0,
  autoOptimize: true,
  turnTimes: DEFAULT_TURN_TIMES,
  remindHoursBefore: 24,
  emailEnabled: true,
  smsEnabled: false,
  staffAlertEmail: '',
  requirePhone: true,
  requireEmail: false,
  collectOccasion: true,
  cardRequiredMinParty: 0,
  noShowFeeCents: 0,
  policyText: '',
  confirmationMessage: '',
  largePartyMessage: 'For parties larger than {max}, please call us.',
  waitlistOnline: false,
  autoCompleteOnCheckClose: true,
  feeComparisonCents: 100,
  googleEndToEnd: false,
  brandColor: '#9C2F22',
});

const clampInt = (v, min, max, d) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const text = (v, max = 2000) => String(v ?? '').slice(0, max);

// Accepts partial input, returns a complete, safe settings object.
export function sanitizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...base, ...input };
  const out = {
    minPartySize: clampInt(s.minPartySize, 1, 50, 1),
    maxPartySize: clampInt(s.maxPartySize, 1, 100, 8),
    bookingWindowDays: clampInt(s.bookingWindowDays, 0, 365, 60),
    minNoticeMinutes: clampInt(s.minNoticeMinutes, 0, 7 * 24 * 60, 60),
    cancelCutoffMinutes: clampInt(s.cancelCutoffMinutes, 0, 7 * 24 * 60, 120),
    slotInterval: [5, 10, 15, 20, 30, 60].includes(Number(s.slotInterval)) ? Number(s.slotInterval) : 15,
    bufferMinutes: clampInt(s.bufferMinutes, 0, 120, 0),
    autoOptimize: Boolean(s.autoOptimize),
    turnTimes: sanitizeTurnTimes(s.turnTimes),
    remindHoursBefore: clampInt(s.remindHoursBefore, 0, 168, 24),
    emailEnabled: Boolean(s.emailEnabled),
    smsEnabled: Boolean(s.smsEnabled),
    staffAlertEmail: text(s.staffAlertEmail, 200).trim(),
    requirePhone: Boolean(s.requirePhone),
    requireEmail: Boolean(s.requireEmail),
    collectOccasion: Boolean(s.collectOccasion),
    cardRequiredMinParty: clampInt(s.cardRequiredMinParty, 0, 100, 0),
    noShowFeeCents: clampInt(s.noShowFeeCents, 0, 100000, 0),
    policyText: text(s.policyText),
    confirmationMessage: text(s.confirmationMessage),
    largePartyMessage: text(s.largePartyMessage, 300),
    waitlistOnline: Boolean(s.waitlistOnline),
    autoCompleteOnCheckClose: Boolean(s.autoCompleteOnCheckClose),
    feeComparisonCents: clampInt(s.feeComparisonCents, 0, 10000, 100),
    googleEndToEnd: Boolean(s.googleEndToEnd),
    brandColor: /^#[0-9a-fA-F]{6}$/.test(s.brandColor) ? s.brandColor : DEFAULT_SETTINGS.brandColor,
  };
  if (out.maxPartySize < out.minPartySize) out.maxPartySize = out.minPartySize;
  return out;
}

function sanitizeTurnTimes(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_TURN_TIMES;
  const clean = list
    .map((t) => ({ upTo: clampInt(t?.upTo, 1, 100, 0), minutes: clampInt(t?.minutes, 15, 600, 0) }))
    .filter((t) => t.upTo && t.minutes)
    .sort((a, b) => a.upTo - b.upTo);
  const unique = clean.filter((t, i) => i === 0 || t.upTo !== clean[i - 1].upTo);
  if (!unique.length) return DEFAULT_TURN_TIMES;
  // The last bucket always catches every larger party.
  unique[unique.length - 1].upTo = Math.max(unique[unique.length - 1].upTo, 99);
  return unique;
}

export function restaurantSettings(row) {
  return sanitizeSettings(parseJson(row.settings, {}));
}

export function slugify(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'restaurant';
}

export function uniqueSlug(db, name) {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; db.one('SELECT 1 FROM restaurants WHERE slug = ?', slug); i++) slug = `${base}-${i}`;
  return slug;
}

export const PROFILE_FIELDS = [
  'name',
  'phone',
  'email',
  'website',
  'address',
  'city',
  'region',
  'postal_code',
  'country',
  'cuisine',
];

export function publicProfile(row) {
  const settings = restaurantSettings(row);
  return {
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    phone: row.phone,
    website: row.website,
    address: row.address,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    cuisine: row.cuisine,
    brandColor: settings.brandColor,
    minPartySize: settings.minPartySize,
    maxPartySize: settings.maxPartySize,
    bookingWindowDays: settings.bookingWindowDays,
    largePartyMessage: settings.largePartyMessage.replace('{max}', String(settings.maxPartySize)),
    policyText: settings.policyText,
    requirePhone: settings.requirePhone,
    requireEmail: settings.requireEmail,
    collectOccasion: settings.collectOccasion,
    cardRequiredMinParty: settings.cardRequiredMinParty,
    noShowFeeCents: settings.noShowFeeCents,
    waitlistOnline: settings.waitlistOnline,
  };
}

export function createRestaurant(db, { name, timezone, ownerId, trialDays, now = Date.now(), ...profile }) {
  if (!name || !String(name).trim()) throw new HttpError(400, 'invalid', 'Restaurant name is required.');
  const tz = timezone && isValidTimeZone(timezone) ? timezone : 'America/Los_Angeles';
  return db.tx(() => {
    const slug = uniqueSlug(db, name);
    const { id } = db.run(
      `INSERT INTO restaurants (slug, name, timezone, phone, email, website, address, city, region, postal_code,
         settings, trial_ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      slug,
      String(name).trim().slice(0, 120),
      tz,
      text(profile.phone, 40),
      text(profile.email, 200),
      text(profile.website, 300),
      text(profile.address, 300),
      text(profile.city, 100),
      text(profile.region, 100),
      text(profile.postal_code, 20),
      JSON.stringify(sanitizeSettings({})),
      now + trialDays * 86400000,
      now,
      now,
    );
    if (ownerId) {
      db.run('INSERT INTO memberships (user_id, restaurant_id, role, created_at) VALUES (?, ?, ?, ?)', ownerId, id, 'owner', now);
    }
    return db.one('SELECT * FROM restaurants WHERE id = ?', id);
  });
}

// Row converters: JSON columns parsed, flags as booleans.
export const tableRow = (t) => t && { ...t, online: Boolean(t.online), active: Boolean(t.active) };
export const comboRow = (c) => c && { ...c, table_ids: parseJson(c.table_ids, []), online: Boolean(c.online), active: Boolean(c.active) };
export const shiftRow = (s) => s && { ...s, days: parseJson(s.days, []), online: Boolean(s.online), active: Boolean(s.active) };
export const closureRow = (c) => c && { ...c, closed: Boolean(c.closed) };

export function loadFloor(db, restaurantId) {
  return {
    tables: db.all('SELECT * FROM tables WHERE restaurant_id = ? ORDER BY sort, id', restaurantId).map(tableRow),
    combos: db.all('SELECT * FROM table_combos WHERE restaurant_id = ? ORDER BY id', restaurantId).map(comboRow),
  };
}

export function loadShifts(db, restaurantId) {
  return db.all('SELECT * FROM shifts WHERE restaurant_id = ? ORDER BY start_min, id', restaurantId).map(shiftRow);
}

// Everything computeAvailability needs for one service date.
export function dayContext(db, restaurant, date, { nowMs = Date.now(), channel = 'online', floor, shifts } = {}) {
  floor ??= loadFloor(db, restaurant.id);
  shifts ??= loadShifts(db, restaurant.id);
  const closure = closureRow(db.one('SELECT * FROM closures WHERE restaurant_id = ? AND date = ?', restaurant.id, date));
  const reservations = db
    .all(
      `SELECT id, date, start_min, duration_min, party_size, status, source, table_ids, table_locked
         FROM reservations
        WHERE restaurant_id = ? AND date IN (?, ?)
          AND status IN ('pending', 'booked', 'confirmed', 'arrived', 'seated', 'completed')`,
      restaurant.id,
      date,
      addDays(date, -1),
    )
    .map((r) => ({ ...r, table_ids: parseJson(r.table_ids, []) }));
  return {
    date,
    settings: restaurantSettings(restaurant),
    timezone: restaurant.timezone,
    nowMs,
    channel,
    shifts,
    closure,
    tables: floor.tables,
    combos: floor.combos,
    reservations,
  };
}

// ---- Floor and schedule editing (validated) --------------------------------

const int = (v, d = null) => (v === null || v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function validateTable(input) {
  const name = text(input.name, 40).trim();
  const min = int(input.min_covers, 1);
  const max = int(input.max_covers);
  if (!name) throw new HttpError(400, 'invalid', 'Table name is required.');
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new HttpError(400, 'invalid', 'Max covers must be 1-100.');
  if (!Number.isInteger(min) || min < 1 || min > max) throw new HttpError(400, 'invalid', 'Min covers must be between 1 and max.');
  return {
    name,
    section: text(input.section, 40).trim(),
    min_covers: min,
    max_covers: max,
    online: input.online === undefined ? 1 : input.online ? 1 : 0,
    active: input.active === undefined ? 1 : input.active ? 1 : 0,
    sort: int(input.sort, 0),
    pos_ref: text(input.pos_ref, 100).trim(),
  };
}

export function validateCombo(db, restaurantId, input) {
  const ids = Array.isArray(input.table_ids) ? [...new Set(input.table_ids.map(Number))] : [];
  if (ids.length < 2) throw new HttpError(400, 'invalid', 'A combination needs at least two tables.');
  const found = db.all(
    `SELECT id, max_covers FROM tables WHERE restaurant_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    restaurantId,
    ...ids,
  );
  if (found.length !== ids.length) throw new HttpError(400, 'invalid', 'Unknown table in combination.');
  const max = int(input.max_covers, found.reduce((a, t) => a + t.max_covers, 0));
  const min = int(input.min_covers, 1);
  if (!(min >= 1 && max >= min && max <= 200)) throw new HttpError(400, 'invalid', 'Check the cover range.');
  return {
    name: text(input.name, 60).trim() || `Combo ${ids.join('+')}`,
    table_ids: JSON.stringify(ids.sort((a, b) => a - b)),
    min_covers: min,
    max_covers: max,
    online: input.online === undefined ? 1 : input.online ? 1 : 0,
    active: input.active === undefined ? 1 : input.active ? 1 : 0,
  };
}

export function validateShift(input) {
  const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number))].filter((d) => d >= 0 && d <= 6) : [];
  const start = int(input.start_min);
  const last = int(input.last_seating_min);
  const end = int(input.end_min, last);
  const interval = int(input.interval_min, 15);
  if (!text(input.name, 40).trim()) throw new HttpError(400, 'invalid', 'Shift name is required.');
  if (!days.length) throw new HttpError(400, 'invalid', 'Pick at least one day.');
  if (!(Number.isInteger(start) && start >= 0 && start < 30 * 60)) throw new HttpError(400, 'invalid', 'Invalid first seating.');
  if (!(Number.isInteger(last) && last >= start && last < 30 * 60)) throw new HttpError(400, 'invalid', 'Last seating must be after first seating.');
  if (![5, 10, 15, 20, 30, 60].includes(interval)) throw new HttpError(400, 'invalid', 'Interval must be 5, 10, 15, 20, 30 or 60.');
  for (const d of [input.starts_on, input.ends_on]) {
    if (d && !isValidDate(d)) throw new HttpError(400, 'invalid', 'Seasonal dates must be YYYY-MM-DD.');
  }
  const cap = (v) => {
    const n = int(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  return {
    name: text(input.name, 40).trim(),
    days: JSON.stringify(days.sort()),
    start_min: start,
    last_seating_min: last,
    end_min: Math.max(end ?? last, last),
    interval_min: interval,
    max_covers_per_slot: cap(input.max_covers_per_slot),
    max_parties_per_slot: cap(input.max_parties_per_slot),
    online: input.online === undefined ? 1 : input.online ? 1 : 0,
    active: input.active === undefined ? 1 : input.active ? 1 : 0,
    starts_on: input.starts_on || null,
    ends_on: input.ends_on || null,
  };
}

export function validateClosure(input) {
  if (!isValidDate(input.date)) throw new HttpError(400, 'invalid', 'Date must be YYYY-MM-DD.');
  const closed = input.closed === undefined ? 1 : input.closed ? 1 : 0;
  const start = int(input.start_min);
  const last = int(input.last_seating_min, start);
  if (!closed && !(Number.isInteger(start) && Number.isInteger(last) && last >= start)) {
    throw new HttpError(400, 'invalid', 'Special hours need a first and last seating.');
  }
  return {
    date: input.date,
    closed,
    start_min: closed ? null : start,
    last_seating_min: closed ? null : last,
    end_min: closed ? null : int(input.end_min, last),
    note: text(input.note, 200).trim(),
  };
}

// A sensible starting floor and dinner shift so a new account can take a
// test booking in its first minute. Everything is editable.
export function seedStarterSetup(db, restaurantId) {
  const insertTable = (name, min, max, sort) =>
    db.run(
      'INSERT INTO tables (restaurant_id, name, section, min_covers, max_covers, sort) VALUES (?, ?, ?, ?, ?, ?)',
      restaurantId,
      name,
      'Dining room',
      min,
      max,
      sort,
    ).id;
  const ids = [];
  for (let i = 1; i <= 4; i++) ids.push(insertTable(String(i), 1, 2, i));
  for (let i = 5; i <= 8; i++) ids.push(insertTable(String(i), 2, 4, i));
  insertTable('9', 4, 6, 9);
  db.run(
    'INSERT INTO table_combos (restaurant_id, name, table_ids, min_covers, max_covers) VALUES (?, ?, ?, ?, ?)',
    restaurantId,
    '7+8',
    JSON.stringify([ids[6], ids[7]]),
    6,
    8,
  );
  db.run(
    `INSERT INTO shifts (restaurant_id, name, days, start_min, last_seating_min, end_min, interval_min)
     VALUES (?, 'Dinner', '[0,2,3,4,5,6]', ?, ?, ?, 15)`,
    restaurantId,
    17 * 60,
    21 * 60 + 30,
    22 * 60 + 30,
  );
}
