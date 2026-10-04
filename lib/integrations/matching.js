// Ties POS checks to reservations so guest profiles show real spend and a
// paid check can free the table. Matching is conservative: a customer
// phone/email match first, then the table the party was seated at. When in
// doubt, no match (an unmatched check costs nothing; a wrong one pollutes a
// guest's history).

import { normalizeEmail, normalizePhone, refreshGuestStats } from '../guests.js';
import { restaurantSettings } from '../restaurants.js';
import { parseJson } from '../db.js';

const CANDIDATE_STATUSES = "('arrived', 'seated', 'completed')";

export function tableKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\b(table|tbl|tab)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function byCustomer(db, restaurant, check) {
  const phone = normalizePhone(check.customer?.phone, restaurant.country);
  const email = normalizeEmail(check.customer?.email);
  if (!phone && !email) return null;
  return db.one(
    `SELECT r.* FROM reservations r LEFT JOIN guests g ON g.id = r.guest_id
      WHERE r.restaurant_id = ? AND r.status IN ${CANDIDATE_STATUSES}
        AND r.starts_at <= ? AND r.starts_at >= ?
        AND ((? IS NOT NULL AND (r.guest_phone = ? OR g.phone = ?)) OR (? IS NOT NULL AND (r.guest_email = ? OR g.email = ?)))
      ORDER BY r.starts_at DESC LIMIT 1`,
    restaurant.id,
    check.closedAt + 30 * 60_000,
    check.closedAt - 6 * 3600_000,
    phone,
    phone,
    phone,
    email,
    email,
    email,
  );
}

function byTable(db, restaurant, check, tablesByKey) {
  const key = tableKey(check.tableRef);
  const table = key ? tablesByKey.get(key) : null;
  if (!table) return null;
  const candidates = db.all(
    `SELECT * FROM reservations WHERE restaurant_id = ? AND status IN ${CANDIDATE_STATUSES}
       AND starts_at <= ? AND starts_at >= ? ORDER BY starts_at DESC`,
    restaurant.id,
    check.closedAt + 30 * 60_000,
    check.closedAt - 6 * 3600_000,
  );
  return (
    candidates.find((r) => {
      if (!parseJson(r.table_ids, []).includes(table.id)) return false;
      const end = r.starts_at + (r.duration_min + 180) * 60_000;
      return check.closedAt <= end;
    }) || null
  );
}

export function matchChecks(app, restaurant, provider, checks) {
  const { db } = app;
  const settings = restaurantSettings(restaurant);
  const tablesByKey = new Map();
  for (const t of db.all('SELECT id, name, pos_ref FROM tables WHERE restaurant_id = ?', restaurant.id)) {
    tablesByKey.set(tableKey(t.name), t);
    if (t.pos_ref) tablesByKey.set(tableKey(t.pos_ref), t);
  }
  const touched = new Set();
  const dates = new Set();
  let matched = 0;

  db.tx(() => {
    for (const c of checks) {
      if (!c.externalId) continue;
      const now = app.now();
      db.run(
        `INSERT INTO pos_checks (restaurant_id, provider, external_id, opened_at, closed_at, total_cents, table_ref,
           guest_count, customer_name, customer_phone, customer_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (restaurant_id, provider, external_id) DO UPDATE SET
           closed_at = excluded.closed_at, total_cents = excluded.total_cents, table_ref = excluded.table_ref,
           guest_count = excluded.guest_count, customer_name = excluded.customer_name,
           customer_phone = excluded.customer_phone, customer_email = excluded.customer_email`,
        restaurant.id,
        provider,
        c.externalId,
        c.openedAt,
        c.closedAt,
        c.totalCents,
        c.tableRef,
        c.guestCount,
        c.customer?.name || null,
        c.customer?.phone || null,
        c.customer?.email || null,
        now,
      );
      const stored = db.one('SELECT * FROM pos_checks WHERE restaurant_id = ? AND provider = ? AND external_id = ?', restaurant.id, provider, c.externalId);
      if (!c.closedAt) continue;
      let reservation = null;
      let method = null;
      if (stored.reservation_id) {
        reservation = db.one('SELECT * FROM reservations WHERE id = ?', stored.reservation_id);
        method = stored.match_method;
      } else {
        reservation = byCustomer(db, restaurant, c);
        method = reservation ? 'customer' : null;
        if (!reservation) {
          reservation = byTable(db, restaurant, c, tablesByKey);
          method = reservation ? 'table' : null;
        }
      }
      if (!reservation) continue;
      db.run('UPDATE pos_checks SET reservation_id = ?, match_method = ? WHERE id = ?', reservation.id, method, stored.id);
      const spend = db.one('SELECT coalesce(sum(total_cents), 0) AS s FROM pos_checks WHERE reservation_id = ?', reservation.id).s;
      db.run('UPDATE reservations SET spend_cents = ?, pos_check_ref = ?, updated_at = ? WHERE id = ?', spend, c.externalId, now, reservation.id);
      if (settings.autoCompleteOnCheckClose && ['arrived', 'seated'].includes(reservation.status)) {
        db.run("UPDATE reservations SET status = 'completed', completed_at = ? WHERE id = ?", Math.min(c.closedAt, now), reservation.id);
        dates.add(reservation.date);
      }
      if (reservation.guest_id) touched.add(reservation.guest_id);
      matched++;
    }
    for (const g of touched) refreshGuestStats(db, g, app.now());
  });
  for (const d of dates) app.events.publish(restaurant.id, { type: 'reservations', date: d });
  return { received: checks.length, matched };
}
