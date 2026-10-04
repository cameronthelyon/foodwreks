// Data portability: import from whatever the last system exported, export
// everything we hold. Leaving must be as easy as arriving.

import { parseCsv, toCsv } from './csv.js';
import { cleanTags, findOrCreateGuest, guestRow, normalizeEmail, normalizePhone, refreshGuestStats } from './guests.js';
import { createReservation, reservationView } from './reservations.js';
import { HttpError } from './http.js';
import { parseJson } from './db.js';
import { daysBetween, isValidDate, localDate } from './time.js';

// Header names seen in common exports, normalized (lowercase, alphanumerics).
const SYNONYMS = {
  firstName: ['first name', 'first', 'firstname', 'given name', 'guest first name', 'customer first name'],
  lastName: ['last name', 'last', 'lastname', 'surname', 'family name', 'guest last name', 'customer last name'],
  name: ['name', 'full name', 'guest name', 'guest', 'customer', 'customer name', 'diner', 'diner name'],
  email: ['email', 'e mail', 'email address', 'guest email', 'customer email', 'emails'],
  phone: ['phone', 'phone number', 'mobile', 'mobile phone', 'mobile number', 'cell', 'cell phone', 'telephone', 'guest phone', 'phones'],
  notes: ['notes', 'guest notes', 'note', 'special requests', 'allergies', 'dietary restrictions', 'guest note', 'profile notes'],
  tags: ['tags', 'guest tags', 'tag', 'labels', 'guest tag'],
  visits: ['visits', 'visit count', 'total visits', 'number of visits', 'completed visits', 'past visits', 'visit history'],
  marketingOptIn: ['marketing opt in', 'email opt in', 'opt in', 'subscribed', 'marketing', 'email marketing', 'accepts marketing'],
  date: ['date', 'reservation date', 'visit date', 'booking date', 'res date'],
  time: ['time', 'reservation time', 'visit time', 'res time'],
  datetime: ['date time', 'datetime', 'reservation date time', 'start time', 'reservation datetime', 'start'],
  partySize: ['party size', 'party', 'covers', 'guests', 'size', 'people', 'pax', 'number of guests', 'cover count', 'guest count'],
  status: ['status', 'reservation status', 'state'],
  externalId: ['confirmation', 'confirmation number', 'reservation id', 'booking id', 'confirmation code', 'conf number'],
  occasion: ['occasion', 'special occasion'],
};

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function detectMapping(headers) {
  const mapping = {};
  const normalized = headers.map(norm);
  for (const [field, names] of Object.entries(SYNONYMS)) {
    const idx = normalized.findIndex((h) => names.includes(h));
    if (idx >= 0) mapping[field] = idx;
  }
  return mapping;
}

export function parseFlexibleDate(value) {
  const v = String(value ?? '').trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(v);
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return isValidDate(d) ? d : null;
  }
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(v);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    const d = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return isValidDate(d) ? d : null;
  }
  return null;
}

export function parseFlexibleTime(value) {
  const v = String(value ?? '').trim().toLowerCase();
  const m = /(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?\b/.exec(v);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3];
  if (!m[2] && !ampm) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm.startsWith('p') && h !== 12) h += 12;
    if (ampm.startsWith('a') && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function splitDateTime(value) {
  const v = String(value ?? '').trim();
  const date = parseFlexibleDate(v);
  const rest = v.replace(/^\S+[T\s]?/, '');
  const time = parseFlexibleTime(v.includes('T') ? v.split('T')[1] : rest);
  return { date, time };
}

const STATUS_MAP = {
  booked: 'booked',
  reserved: 'booked',
  pending: 'booked',
  confirmed: 'confirmed',
  seated: 'completed',
  completed: 'completed',
  done: 'completed',
  finished: 'completed',
  'no show': 'no_show',
  noshow: 'no_show',
  'no-show': 'no_show',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

function readRows(csv, limitRows = 20000) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new HttpError(400, 'invalid', 'The file needs a header row and at least one data row.');
  if (rows.length - 1 > limitRows) throw new HttpError(400, 'invalid', `Import at most ${limitRows} rows at a time.`);
  return { headers: rows[0].map((h) => h.trim()), data: rows.slice(1) };
}

function pick(row, mapping, field) {
  const i = mapping[field];
  return i === undefined || i === null || i < 0 ? '' : String(row[i] ?? '').trim();
}

function rowNames(row, mapping) {
  let first = pick(row, mapping, 'firstName');
  let last = pick(row, mapping, 'lastName');
  if (!first && !last) {
    const parts = pick(row, mapping, 'name').split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      last = parts.pop();
      first = parts.join(' ');
    } else first = parts[0] || '';
  }
  return { first, last };
}

const truthy = (v) => /^(1|y|yes|true|subscribed|opted in|opt in)$/i.test(String(v).trim());

export function previewImport(csv, kind) {
  const { headers, data } = readRows(csv);
  const mapping = detectMapping(headers);
  const required = kind === 'reservations' ? [['date', 'datetime'], ['partySize']] : [['name', 'firstName', 'lastName', 'email', 'phone']];
  const missing = required.filter((alts) => !alts.some((f) => mapping[f] !== undefined)).map((alts) => alts.join(' or '));
  return { kind, headers, mapping, missing, rows: data.length, sample: data.slice(0, 5) };
}

export function importGuests(app, restaurant, csv, mappingOverride) {
  const { db } = app;
  const { headers, data } = readRows(csv);
  const mapping = mappingOverride || detectMapping(headers);
  const now = app.now();
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  db.tx(() => {
    data.forEach((row, i) => {
      const { first, last } = rowNames(row, mapping);
      const phone = normalizePhone(pick(row, mapping, 'phone'), restaurant.country);
      const email = normalizeEmail(pick(row, mapping, 'email'));
      if (!phone && !email && !first && !last) {
        result.skipped++;
        result.errors.push({ row: i + 2, error: 'No name, phone or email' });
        return;
      }
      const tags = pick(row, mapping, 'tags')
        .split(/[;,|]/)
        .map((t) => t.trim())
        .filter(Boolean);
      const visits = Number.parseInt(pick(row, mapping, 'visits'), 10) || 0;
      const notes = pick(row, mapping, 'notes');
      const optIn = truthy(pick(row, mapping, 'marketingOptIn'));
      const before = phone || email
        ? db.one('SELECT id FROM guests WHERE restaurant_id = ? AND (phone = ? OR email = ?)', restaurant.id, phone, email)
        : null;
      const guest = findOrCreateGuest(
        db,
        restaurant.id,
        { firstName: first, lastName: last, phone, email, tags, notes, importedVisits: visits, marketingOptIn: optIn, country: restaurant.country },
        now,
      );
      if (before) {
        const merged = cleanTags([...parseJson(guest.tags, []), ...tags]);
        const fullNotes = guest.notes && notes && !guest.notes.includes(notes) ? `${guest.notes}\n${notes}` : guest.notes || notes;
        db.run(
          'UPDATE guests SET tags = ?, notes = ?, imported_visits = max(imported_visits, ?), updated_at = ? WHERE id = ?',
          JSON.stringify(merged),
          fullNotes.slice(0, 4000),
          visits,
          now,
          guest.id,
        );
        result.updated++;
      } else {
        result.created++;
      }
      refreshGuestStats(db, guest.id, now);
    });
  });
  return result;
}

// Imports reservations. Future bookings are seated on the floor plan when
// possible and kept unassigned otherwise (reported, never dropped). Guests
// are NOT messaged. Past rows are skipped unless includePast is set, in which
// case they become history with their recorded status.
export function importReservations(app, restaurant, csv, { mapping: mappingOverride, includePast = false, defaultDuration } = {}) {
  const { db } = app;
  const { headers, data } = readRows(csv, 10000);
  const mapping = mappingOverride || detectMapping(headers);
  const today = localDate(app.now(), restaurant.timezone);
  const result = { created: 0, skipped: 0, unassigned: 0, duplicates: 0, errors: [] };

  data.forEach((row, i) => {
    const line = i + 2;
    try {
      let date = parseFlexibleDate(pick(row, mapping, 'date'));
      let time = parseFlexibleTime(pick(row, mapping, 'time'));
      if ((!date || time == null) && mapping.datetime !== undefined) {
        const dt = splitDateTime(pick(row, mapping, 'datetime'));
        date ||= dt.date;
        if (time == null) time = dt.time;
      }
      const partySize = Number.parseInt(pick(row, mapping, 'partySize'), 10);
      if (!date || time == null || !Number.isInteger(partySize) || partySize < 1) {
        result.skipped++;
        result.errors.push({ row: line, error: 'Missing or unreadable date, time or party size' });
        return;
      }
      const isPast = daysBetween(today, date) < 0;
      if (isPast && !includePast) {
        result.skipped++;
        return;
      }
      const externalId = pick(row, mapping, 'externalId');
      if (externalId && db.one('SELECT 1 FROM reservations WHERE restaurant_id = ? AND external_ref = ?', restaurant.id, `import:${externalId}`)) {
        result.duplicates++;
        return;
      }
      const statusRaw = norm(pick(row, mapping, 'status'));
      const mapped = STATUS_MAP[statusRaw] || (isPast ? 'completed' : 'booked');
      if (!isPast && mapped === 'cancelled') {
        result.skipped++;
        return;
      }
      const { first, last } = rowNames(row, mapping);
      const { reservation, warnings } = createReservation(
        app,
        restaurant,
        {
          date,
          time,
          partySize,
          firstName: first || 'Guest',
          lastName: last,
          phone: normalizePhone(pick(row, mapping, 'phone'), restaurant.country) || undefined,
          email: normalizeEmail(pick(row, mapping, 'email')) || undefined,
          notes: pick(row, mapping, 'notes'),
          occasion: pick(row, mapping, 'occasion'),
          source: 'import',
          allowUnassigned: true,
          duration: defaultDuration,
          externalRef: externalId ? `import:${externalId}` : null,
          notify: false,
        },
        { channel: 'staff' },
      );
      if (isPast && mapped !== 'booked') {
        db.run(
          `UPDATE reservations SET status = ?, table_ids = '[]', completed_at = CASE WHEN ? = 'completed' THEN starts_at END,
             cancelled_at = CASE WHEN ? = 'cancelled' THEN starts_at END WHERE id = ?`,
          mapped,
          mapped,
          mapped,
          reservation.id,
        );
      }
      // Imported guests booked through the old system; we never message them
      // on our own initiative (a staff edit later can still notify).
      db.run('UPDATE reservations SET reminder_sent_at = 0 WHERE id = ? AND reminder_sent_at IS NULL', reservation.id);
      if (warnings.includes('no_table')) result.unassigned++;
      result.created++;
    } catch (err) {
      result.skipped++;
      result.errors.push({ row: line, error: err.message });
    }
  });
  for (const g of db.all(
    "SELECT DISTINCT guest_id FROM reservations WHERE restaurant_id = ? AND source = 'import' AND guest_id IS NOT NULL",
    restaurant.id,
  )) {
    refreshGuestStats(db, g.guest_id, app.now());
  }
  if (result.created) app.events.publish(restaurant.id, { type: 'reservations', date: today });
  result.errors = result.errors.slice(0, 200);
  return result;
}

const GUEST_COLUMNS = [
  { label: 'First name', key: 'first_name' },
  { label: 'Last name', key: 'last_name' },
  { label: 'Phone', key: 'phone' },
  { label: 'Email', key: 'email' },
  { label: 'Tags', get: (g) => g.tags.join('; ') },
  { label: 'Notes', key: 'notes' },
  { label: 'Marketing opt-in', get: (g) => (g.marketing_opt_in ? 'yes' : 'no') },
  { label: 'Visits', key: 'visit_count' },
  { label: 'No-shows', key: 'no_show_count' },
  { label: 'Cancellations', key: 'cancel_count' },
  { label: 'Total spend', get: (g) => (g.total_spend_cents / 100).toFixed(2) },
  { label: 'Last visit', key: 'last_visit_date' },
  { label: 'Created', get: (g) => new Date(g.created_at).toISOString() },
];

const RESERVATION_COLUMNS = [
  { label: 'Confirmation', key: 'code' },
  { label: 'Date', key: 'date' },
  { label: 'Time', key: 'timeLabel' },
  { label: 'Party size', key: 'partySize' },
  { label: 'Status', key: 'status' },
  { label: 'Source', key: 'source' },
  { label: 'Name', key: 'name' },
  { label: 'Phone', key: 'phone' },
  { label: 'Email', key: 'email' },
  { label: 'Tables', get: (r) => r.tableNames },
  { label: 'Guest notes', key: 'guestNotes' },
  { label: 'Occasion', key: 'occasion' },
  { label: 'Staff notes', key: 'staffNotes' },
  { label: 'Spend', get: (r) => (r.spendCents != null ? (r.spendCents / 100).toFixed(2) : '') },
  { label: 'Created', get: (r) => new Date(r.createdAt).toISOString() },
];

export function exportGuestsCsv(db, restaurant) {
  const guests = db.all('SELECT * FROM guests WHERE restaurant_id = ? ORDER BY last_name, first_name, id', restaurant.id).map(guestRow);
  return toCsv(guests, GUEST_COLUMNS);
}

export function exportReservationsCsv(db, restaurant) {
  const names = new Map(db.all('SELECT id, name FROM tables WHERE restaurant_id = ?', restaurant.id).map((t) => [t.id, t.name]));
  const rows = db
    .all('SELECT * FROM reservations WHERE restaurant_id = ? ORDER BY date, start_min, id', restaurant.id)
    .map((r) => {
      const v = reservationView(r);
      v.tableNames = v.tableIds.map((id) => names.get(id) || id).join('+');
      return v;
    });
  return toCsv(rows, RESERVATION_COLUMNS);
}

// Everything, as JSON. Credentials are excluded (they are the restaurant's
// own keys and can be re-entered); everything else is included.
export function exportAll(db, restaurant) {
  const rid = restaurant.id;
  const strip = ({ restaurant_id, ...rest }) => rest;
  return {
    format: 'freehold-export-v1',
    exportedAt: new Date().toISOString(),
    restaurant: { ...restaurant, settings: parseJson(restaurant.settings, {}) },
    tables: db.all('SELECT * FROM tables WHERE restaurant_id = ?', rid).map(strip),
    combos: db.all('SELECT * FROM table_combos WHERE restaurant_id = ?', rid).map(strip),
    shifts: db.all('SELECT * FROM shifts WHERE restaurant_id = ?', rid).map(strip),
    closures: db.all('SELECT * FROM closures WHERE restaurant_id = ?', rid).map(strip),
    guests: db.all('SELECT * FROM guests WHERE restaurant_id = ?', rid).map(strip),
    reservations: db
      .all('SELECT * FROM reservations WHERE restaurant_id = ?', rid)
      .map(({ manage_salt, card_ref, card_session_ref, ...r }) => strip(r)),
    waitlist: db.all('SELECT * FROM waitlist WHERE restaurant_id = ?', rid).map(({ status_token_hash, ...w }) => strip(w)),
    posChecks: db.all('SELECT * FROM pos_checks WHERE restaurant_id = ?', rid).map(strip),
    staff: db.all(
      'SELECT u.email, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.restaurant_id = ?',
      rid,
    ),
  };
}
