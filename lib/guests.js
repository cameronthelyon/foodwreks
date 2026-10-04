// Guest profiles. A guest belongs to one restaurant (no cross-restaurant
// network, by design: each restaurant owns its own list). Matching is by
// phone first, then email.

import { HttpError } from './http.js';
import { parseJson } from './db.js';

export function normalizePhone(input, defaultCountry = 'US') {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (defaultCountry === 'US' || defaultCountry === 'CA') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null;
  }
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export function normalizeEmail(input) {
  if (input == null) return null;
  const e = String(input).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

export function splitName(full) {
  const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

export const displayName = (g) => [g.first_name, g.last_name].filter(Boolean).join(' ') || 'Guest';

export function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

export function guestRow(g) {
  if (!g) return g;
  return { ...g, tags: parseJson(g.tags, []), marketing_opt_in: Boolean(g.marketing_opt_in), name: displayName(g) };
}

// Finds a guest by phone/email or creates one. Fills blanks on an existing
// profile but never overwrites what staff already know.
export function findOrCreateGuest(db, restaurantId, input, now = Date.now()) {
  const phone = normalizePhone(input.phone, input.country);
  const email = normalizeEmail(input.email);
  const firstName = String(input.firstName ?? '').trim().slice(0, 80);
  const lastName = String(input.lastName ?? '').trim().slice(0, 80);

  let guest = null;
  if (phone) guest = db.one('SELECT * FROM guests WHERE restaurant_id = ? AND phone = ? ORDER BY id LIMIT 1', restaurantId, phone);
  if (!guest && email) guest = db.one('SELECT * FROM guests WHERE restaurant_id = ? AND email = ? ORDER BY id LIMIT 1', restaurantId, email);

  if (guest) {
    const updates = {
      phone: guest.phone || phone,
      email: guest.email || email,
      first_name: guest.first_name || firstName,
      last_name: guest.last_name || lastName,
      marketing_opt_in: input.marketingOptIn ? 1 : guest.marketing_opt_in,
    };
    db.run(
      `UPDATE guests SET phone = ?, email = ?, first_name = ?, last_name = ?, marketing_opt_in = ?, updated_at = ?
        WHERE id = ?`,
      updates.phone,
      updates.email,
      updates.first_name,
      updates.last_name,
      updates.marketing_opt_in,
      now,
      guest.id,
    );
    return { ...guest, ...updates };
  }
  if (!phone && !email && !firstName && !lastName) return null;
  const { id } = db.run(
    `INSERT INTO guests (restaurant_id, first_name, last_name, phone, email, marketing_opt_in, tags, notes,
       imported_visits, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    restaurantId,
    firstName,
    lastName,
    phone,
    email,
    input.marketingOptIn ? 1 : 0,
    JSON.stringify(cleanTags(input.tags)),
    String(input.notes ?? '').slice(0, 4000),
    Math.max(0, Number.parseInt(input.importedVisits, 10) || 0),
    now,
    now,
  );
  return db.one('SELECT * FROM guests WHERE id = ?', id);
}

// Derived counters are recomputed from reservations rather than incremented,
// so they can never drift (undoing a no-show just works).
export function refreshGuestStats(db, guestId, now = Date.now()) {
  if (!guestId) return;
  db.run(
    `UPDATE guests SET
       visit_count = imported_visits +
         (SELECT count(*) FROM reservations WHERE guest_id = ?1 AND status = 'completed'),
       no_show_count = (SELECT count(*) FROM reservations WHERE guest_id = ?1 AND status = 'no_show'),
       cancel_count = (SELECT count(*) FROM reservations WHERE guest_id = ?1 AND status = 'cancelled'
                         AND cancelled_by = 'guest'),
       total_spend_cents = (SELECT coalesce(sum(spend_cents), 0) FROM reservations WHERE guest_id = ?1),
       last_visit_date = coalesce(
         (SELECT max(date) FROM reservations WHERE guest_id = ?1 AND status IN ('completed', 'seated')),
         last_visit_date),
       updated_at = ?2
     WHERE id = ?1`,
    guestId,
    now,
  );
}

export function updateGuest(db, restaurantId, guestId, patch, now = Date.now()) {
  const g = db.one('SELECT * FROM guests WHERE id = ? AND restaurant_id = ?', guestId, restaurantId);
  if (!g) throw new HttpError(404, 'not_found', 'Guest not found.');
  const next = { ...g };
  if (patch.firstName !== undefined) next.first_name = String(patch.firstName).trim().slice(0, 80);
  if (patch.lastName !== undefined) next.last_name = String(patch.lastName).trim().slice(0, 80);
  if (patch.phone !== undefined) {
    next.phone = patch.phone ? normalizePhone(patch.phone) : null;
    if (patch.phone && !next.phone) throw new HttpError(400, 'invalid', 'That phone number does not look right.');
  }
  if (patch.email !== undefined) {
    next.email = patch.email ? normalizeEmail(patch.email) : null;
    if (patch.email && !next.email) throw new HttpError(400, 'invalid', 'That email does not look right.');
  }
  if (patch.notes !== undefined) next.notes = String(patch.notes).slice(0, 4000);
  if (patch.tags !== undefined) next.tags = JSON.stringify(cleanTags(patch.tags));
  if (patch.marketingOptIn !== undefined) next.marketing_opt_in = patch.marketingOptIn ? 1 : 0;
  db.run(
    `UPDATE guests SET first_name = ?, last_name = ?, phone = ?, email = ?, notes = ?, tags = ?, marketing_opt_in = ?,
       updated_at = ? WHERE id = ?`,
    next.first_name,
    next.last_name,
    next.phone,
    next.email,
    next.notes,
    next.tags,
    next.marketing_opt_in,
    now,
    g.id,
  );
  return guestRow(db.one('SELECT * FROM guests WHERE id = ?', g.id));
}

// Folds `dropId` into `keepId`: history, tags and notes move over.
export function mergeGuests(db, restaurantId, keepId, dropId, now = Date.now()) {
  if (keepId === dropId) throw new HttpError(400, 'invalid', 'Pick two different guests.');
  return db.tx(() => {
    const keep = db.one('SELECT * FROM guests WHERE id = ? AND restaurant_id = ?', keepId, restaurantId);
    const drop = db.one('SELECT * FROM guests WHERE id = ? AND restaurant_id = ?', dropId, restaurantId);
    if (!keep || !drop) throw new HttpError(404, 'not_found', 'Guest not found.');
    const tags = cleanTags([...parseJson(keep.tags, []), ...parseJson(drop.tags, [])]);
    const notes = [keep.notes, drop.notes].filter(Boolean).join('\n');
    db.run('UPDATE reservations SET guest_id = ? WHERE guest_id = ?', keep.id, drop.id);
    db.run('UPDATE waitlist SET guest_id = ? WHERE guest_id = ?', keep.id, drop.id);
    db.run(
      `UPDATE guests SET phone = coalesce(phone, ?), email = coalesce(email, ?), tags = ?, notes = ?,
         marketing_opt_in = max(marketing_opt_in, ?), imported_visits = imported_visits + ?,
         pos_customer_ref = coalesce(pos_customer_ref, ?), stripe_customer_id = coalesce(stripe_customer_id, ?),
         updated_at = ? WHERE id = ?`,
      drop.phone,
      drop.email,
      JSON.stringify(tags),
      notes.slice(0, 4000),
      drop.marketing_opt_in,
      drop.imported_visits,
      drop.pos_customer_ref,
      drop.stripe_customer_id,
      now,
      keep.id,
    );
    db.run('DELETE FROM guests WHERE id = ?', drop.id);
    refreshGuestStats(db, keep.id, now);
    return guestRow(db.one('SELECT * FROM guests WHERE id = ?', keep.id));
  });
}
