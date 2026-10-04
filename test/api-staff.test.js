// Host stand, settings, team, guests, import/export over HTTP.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, outboxRows, signup, startTestApp } from './helpers.js';

let t;
before(async () => {
  t = await startTestApp();
});
after(() => t.close());
beforeEach(() => t.app.limiter.reset());

const DATE = '2026-10-10'; // Saturday

const tableId = (floor, name) => floor.tables.find((x) => x.name === name).id;

test('signup seeds a starter floor and dinner shift', async () => {
  const { c, rid, restaurant } = await signup(t);
  const floor = (await c.get(`/api/r/${rid}/floor`)).data;
  assert.equal(floor.tables.length, 9);
  assert.equal(floor.combos.length, 1);
  const shifts = (await c.get(`/api/r/${rid}/shifts`)).data;
  assert.equal(shifts[0].name, 'Dinner');
  assert.equal(restaurant.license.kind, 'trial');
  assert.equal(restaurant.license.daysLeft, 30);
  assert.match(restaurant.links.widget, /data-restaurant=/);
});

test('phone booking with a chosen table, conflicts, and forced overbook', async () => {
  const { c, rid } = await signup(t);
  const floor = (await c.get(`/api/r/${rid}/floor`)).data;
  const t5 = tableId(floor, '5');
  const first = await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1140, partySize: 4, name: 'Alan Turing', phone: '4155550600', tableIds: [t5] });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data.reservation.tableIds, [t5]);
  assert.equal(first.data.reservation.tableLocked, true);
  assert.equal(first.data.reservation.source, 'phone');

  const clash = await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1170, partySize: 2, name: 'Clash', tableIds: [t5] });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.error.code, 'table_conflict');
  const forced = await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1170, partySize: 2, name: 'Forced', tableIds: [t5], force: true });
  assert.equal(forced.status, 200);
  assert.deepEqual(forced.data.warnings, ['table_conflict']);

  // A walk-in at an off-grid minute is fine for staff.
  const walkIn = await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1087, partySize: 2, name: 'Walk In', source: 'walkin', status: 'seated' });
  assert.equal(walkIn.status, 200);
  assert.equal(walkIn.data.reservation.status, 'seated');
});

test('status lifecycle drives guest stats; bad transitions are refused', async () => {
  const { c, rid } = await signup(t);
  const made = await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1080, partySize: 2, name: 'Edsger Dijkstra', phone: '4155550700' });
  const id = made.data.reservation.id;
  for (const s of ['confirmed', 'arrived', 'seated', 'completed']) {
    const r = await c.post(`/api/r/${rid}/reservations/${id}/status`, { status: s });
    assert.equal(r.status, 200, `${s}: ${JSON.stringify(r.data)}`);
  }
  let guest = (await c.get(`/api/r/${rid}/guests/${made.data.reservation.guestId}`)).data.guest;
  assert.equal(guest.visit_count, 1);
  assert.equal(guest.last_visit_date, DATE);
  const bad = await c.post(`/api/r/${rid}/reservations/${id}/status`, { status: 'no_show' });
  assert.equal(bad.status, 409);
  // Undo completion: visit count follows.
  await c.post(`/api/r/${rid}/reservations/${id}/status`, { status: 'seated' });
  guest = (await c.get(`/api/r/${rid}/guests/${made.data.reservation.guestId}`)).data.guest;
  assert.equal(guest.visit_count, 0);
  const detail = await c.get(`/api/r/${rid}/reservations/${id}`);
  assert.ok(detail.data.history.some((h) => h.action === 'reservation.completed'));
});

test('restoring a cancellation re-checks the floor', async () => {
  const { c, rid } = await signup(t);
  const made = await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1080, partySize: 2, name: 'Restore Me' });
  const id = made.data.reservation.id;
  await c.post(`/api/r/${rid}/reservations/${id}/status`, { status: 'cancelled' });
  const back = await c.post(`/api/r/${rid}/reservations/${id}/status`, { status: 'booked' });
  assert.equal(back.status, 200);
  assert.equal(back.data.reservation.tableIds.length, 1);
});

test('roles and tenant isolation', async () => {
  const a = await signup(t);
  const b = await signup(t);
  assert.equal((await b.c.get(`/api/r/${a.rid}`)).status, 404);
  assert.equal((await b.c.get(`/api/r/${a.rid}/day/${DATE}`)).status, 404);
  assert.equal((await t.client().get(`/api/r/${a.rid}`)).status, 401);

  const invite = await a.c.post(`/api/r/${a.rid}/staff`, { email: 'host1@example.com', name: 'Hal Host', role: 'host' });
  assert.equal(invite.status, 200, JSON.stringify(invite.data));
  const mail = outboxRows(t, "kind = 'staff_invite' AND recipient = 'host1@example.com'");
  assert.equal(mail.length, 1);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail[0].body_text)[1];
  const host = makeClient(t.base);
  assert.equal((await host.post('/api/auth/reset', { token, password: 'host-password-123' })).status, 200);
  assert.equal((await host.post('/api/auth/login', { email: 'host1@example.com', password: 'host-password-123' })).status, 200);
  const me = await host.get('/api/auth/me');
  assert.equal(me.data.memberships[0].role, 'host');

  assert.equal((await host.post(`/api/r/${a.rid}/reservations`, { date: DATE, time: 1080, partySize: 2, name: 'Host Booked' })).status, 200);
  assert.equal((await host.patch(`/api/r/${a.rid}/settings`, { maxPartySize: 4 })).status, 403);
  assert.equal((await host.get(`/api/r/${a.rid}/reports`)).status, 403);
  assert.equal((await host.get(`/api/r/${a.rid}/export/guests.csv`)).status, 403);

  const ownerId = (await a.c.get('/api/auth/me')).data.user.id;
  const last = await a.c.del(`/api/r/${a.rid}/staff/${ownerId}`);
  assert.equal(last.status, 409);
});

test('floor editing: tables, combos, retire vs delete', async () => {
  const { c, rid } = await signup(t);
  const made = await c.post(`/api/r/${rid}/tables`, { name: 'Patio 1', section: 'Patio', min_covers: 2, max_covers: 4 });
  assert.equal(made.status, 200);
  assert.equal((await c.post(`/api/r/${rid}/tables`, { name: 'Patio 1', max_covers: 4 })).status, 409);
  assert.equal((await c.post(`/api/r/${rid}/tables`, { name: 'Bad', min_covers: 5, max_covers: 4 })).status, 400);
  const upd = await c.patch(`/api/r/${rid}/tables/${made.data.id}`, { online: false });
  assert.equal(upd.data.online, false);

  const floor = (await c.get(`/api/r/${rid}/floor`)).data;
  const combo = await c.post(`/api/r/${rid}/combos`, { table_ids: [tableId(floor, '5'), tableId(floor, '6')], min_covers: 5, max_covers: 8 });
  assert.equal(combo.status, 200);
  assert.equal(combo.data.name, `Combo ${[tableId(floor, '5'), tableId(floor, '6')].sort((x, y) => x - y).join('+')}`);

  // Unused table: deleted. Used table: retired, and its combos removed.
  assert.equal((await c.del(`/api/r/${rid}/tables/${made.data.id}`)).data.retired, false);
  await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1080, partySize: 4, name: 'On Five', tableIds: [tableId(floor, '5')] });
  const retired = await c.del(`/api/r/${rid}/tables/${tableId(floor, '5')}`);
  assert.equal(retired.data.retired, true);
  const after = (await c.get(`/api/r/${rid}/floor`)).data;
  assert.equal(after.tables.find((x) => x.name === '5').active, false);
  assert.equal(after.combos.some((x) => x.id === combo.data.id), false);
});

test('shifts and closures validate and report affected bookings', async () => {
  const { c, rid } = await signup(t);
  const bad = await c.post(`/api/r/${rid}/shifts`, { name: 'Lunch', days: [], start_min: 690, last_seating_min: 840 });
  assert.equal(bad.status, 400);
  const lunch = await c.post(`/api/r/${rid}/shifts`, { name: 'Lunch', days: [6], start_min: 690, last_seating_min: 840, interval_min: 30, max_covers_per_slot: 10 });
  assert.equal(lunch.status, 200);
  const avail = await c.get(`/api/r/${rid}/availability?date=${DATE}&party=2`);
  assert.equal(avail.data.slots[0].label, '11:30 AM');

  await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1080, partySize: 2, name: 'Before Closure' });
  const closure = await c.post(`/api/r/${rid}/closures`, { date: DATE, closed: true, note: 'Plumbing' });
  assert.equal(closure.data.existingReservations, 1);
  const special = await c.post(`/api/r/${rid}/closures`, { date: '2026-10-11', closed: false, start_min: 600, last_seating_min: 720, note: 'Brunch only' });
  assert.equal(special.status, 200);
  const list = (await c.get(`/api/r/${rid}/closures`)).data;
  assert.equal(list.length, 2);
});

test('settings are sanitized', async () => {
  const { c, rid } = await signup(t);
  const s = await c.patch(`/api/r/${rid}/settings`, { maxPartySize: 500, slotInterval: 7, brandColor: 'red', turnTimes: [{ upTo: 2, minutes: 75 }, { upTo: 6, minutes: 110 }] });
  assert.equal(s.data.maxPartySize, 100);
  assert.equal(s.data.slotInterval, 15);
  assert.equal(s.data.brandColor, '#9C2F22');
  assert.deepEqual(s.data.turnTimes, [{ upTo: 2, minutes: 75 }, { upTo: 99, minutes: 110 }]);
});

test('waitlist: quote, seat as a walk-in, remove', async () => {
  const { c, rid } = await signup(t);
  t.clock.t = Date.parse('2026-10-10T02:00:00Z'); // Fri 7 PM PDT
  try {
    const est = await c.get(`/api/r/${rid}/waitlist/estimate?party=2`);
    assert.equal(est.data.quotedMin, 0);
    const add = await c.post(`/api/r/${rid}/waitlist`, { name: 'Barbara Liskov', partySize: 2, phone: '4155550800' });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    // No SMS provider configured in tests: notifying is refused clearly.
    const notify = await c.post(`/api/r/${rid}/waitlist/${add.data.id}/notify`, {});
    assert.equal(notify.status, 409);
    assert.equal(notify.data.error.code, 'sms_unavailable');
    const seat = await c.post(`/api/r/${rid}/waitlist/${add.data.id}/seat`, {});
    assert.equal(seat.status, 200, JSON.stringify(seat.data));
    assert.equal(seat.data.entry.status, 'seated');
    assert.equal(seat.data.reservation.status, 'seated');
    assert.equal(seat.data.reservation.source, 'walkin');
    assert.equal(seat.data.reservation.timeLabel, '7:00 PM');
    const second = await c.post(`/api/r/${rid}/waitlist`, { name: 'Ken Thompson', partySize: 2, quotedMin: 25 });
    assert.equal(second.data.quotedMin, 25);
    const gone = await c.post(`/api/r/${rid}/waitlist/${second.data.id}/remove`, { status: 'left' });
    assert.equal(gone.data.status, 'left');
    const list = (await c.get(`/api/r/${rid}/waitlist`)).data;
    assert.equal(list.length, 2);
  } finally {
    t.clock.t = Date.parse('2026-10-09T19:00:00Z');
  }
});

test('waitlist quotes grow as tables fill', async () => {
  const { c, rid } = await signup(t);
  t.clock.t = Date.parse('2026-10-10T02:00:00Z'); // Fri 7 PM PDT
  try {
    // Seat every 2-top-capable table for a party of 2 (tables 1-8 and the combo-free 6-top is 4+).
    for (let i = 0; i < 8; i++) {
      await c.post(`/api/r/${rid}/reservations`, { date: '2026-10-09', time: 1140, partySize: 2, name: `Seated ${i}`, status: 'seated' });
    }
    const est = await c.get(`/api/r/${rid}/waitlist/estimate?party=2`);
    assert.ok(est.data.quotedMin >= 60, `quote ${est.data.quotedMin}`);
  } finally {
    t.clock.t = Date.parse('2026-10-09T19:00:00Z');
  }
});

test('guests: search, tags, edit, merge', async () => {
  const { c, rid } = await signup(t);
  const a = await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1080, partySize: 2, name: 'Margaret Hamilton', phone: '4155550900' });
  const b = await c.post(`/api/r/${rid}/reservations`, { date: DATE, time: 1200, partySize: 2, name: 'Maggie Hamilton', email: 'mh@example.com' });
  const ga = a.data.reservation.guestId;
  const gb = b.data.reservation.guestId;
  assert.notEqual(ga, gb);
  const edited = await c.patch(`/api/r/${rid}/guests/${ga}`, { tags: ['VIP', 'VIP', 'Allergy: nuts'], notes: 'Corner table' });
  assert.deepEqual(edited.data.tags, ['VIP', 'Allergy: nuts']);
  const byTag = await c.get(`/api/r/${rid}/guests?tag=VIP`);
  assert.equal(byTag.data.total, 1);
  assert.ok(byTag.data.tags.includes('VIP'));
  const byPhone = await c.get(`/api/r/${rid}/guests?q=5550900`);
  assert.equal(byPhone.data.guests[0].id, ga);
  const merged = await c.post(`/api/r/${rid}/guests/${ga}/merge`, { otherId: gb });
  assert.equal(merged.data.email, 'mh@example.com');
  const profile = await c.get(`/api/r/${rid}/guests/${ga}`);
  assert.equal(profile.data.reservations.length, 2);
  assert.equal((await c.get(`/api/r/${rid}/guests/${gb}`)).status, 404);
  const search = await c.get(`/api/r/${rid}/search?q=hamilton`);
  assert.equal(search.data.reservations.length, 2);
});

test('import guests and reservations from another system, then export', async () => {
  const { c, rid } = await signup(t);
  const guestsCsv = [
    'First Name,Last Name,Email,Phone,Tags,Guest Notes,Visits',
    'Katherine,Johnson,kj@example.com,(415) 555-1001,"VIP; Regular",Prefers booth,12',
    'Dorothy,Vaughan,,415-555-1002,,,"3"',
    ',,,,,,',
    'Mary,Jackson,mj@example.com,,Industry,"Allergic to ""shellfish""",0',
  ].join('\n');
  const preview = await c.post(`/api/r/${rid}/import/preview`, { kind: 'guests', csv: guestsCsv });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.rows, 3);
  assert.deepEqual(preview.data.missing, []);
  assert.equal(preview.data.mapping.phone, 3);
  const imported = await c.post(`/api/r/${rid}/import/commit`, { kind: 'guests', csv: guestsCsv });
  assert.equal(imported.data.created, 3);
  const kj = (await c.get(`/api/r/${rid}/guests?q=kj@example.com`)).data.guests[0];
  assert.equal(kj.visit_count, 12);
  assert.deepEqual(kj.tags, ['VIP', 'Regular']);

  const resCsv = [
    'Confirmation #,Date,Time,Party Size,Guest Name,Phone,Email,Status,Notes',
    'OT-1,10/12/2026,7:30 PM,4,Katherine Johnson,4155551001,kj@example.com,Confirmed,Anniversary',
    'OT-2,2026-10-13,18:00,2,Grace Kelly,4155551003,,Booked,',
    'OT-3,10/01/2026,7:00 PM,2,Old Visit,,,Seated,',
    'OT-4,bad date,7:00 PM,2,Broken Row,,,,',
  ].join('\n');
  const res = await c.post(`/api/r/${rid}/import/commit`, { kind: 'reservations', csv: resCsv });
  assert.equal(res.data.created, 2);
  assert.equal(res.data.skipped, 2); // the past visit and the broken row
  assert.equal(outboxRows(t, "kind = 'confirmation' AND recipient = 'kj@example.com'").length, 0, 'imports never message guests');
  const again = await c.post(`/api/r/${rid}/import/commit`, { kind: 'reservations', csv: resCsv });
  assert.equal(again.data.duplicates, 2);

  const day = await c.get(`/api/r/${rid}/day/2026-10-12`);
  assert.equal(day.data.reservations[0].source, 'import');
  assert.equal(day.data.reservations[0].timeLabel, '7:30 PM');
  assert.equal(day.data.reservations[0].guestNotes, 'Anniversary');

  const cookie = [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csv = await (await fetch(`${t.base}/api/r/${rid}/export/guests.csv`, { headers: { cookie } })).text();
  assert.match(csv, /Katherine,Johnson,\+14155551001,kj@example.com,VIP; Regular/);
  assert.match(csv, /"Allergic to ""shellfish"""/);
  const all = await (await fetch(`${t.base}/api/r/${rid}/export/all.json`, { headers: { cookie } })).json();
  assert.equal(all.format, 'freeheld-export-v1');
  assert.equal(all.guests.length, 4);
  assert.ok(all.reservations.every((r) => !('manage_salt' in r)));
});

test('reports count what happened and refuse to guess the rest', async () => {
  const { c, rid } = await signup(t);
  const mk = async (time, party, source) =>
    (await c.post(`/api/r/${rid}/reservations`, { date: '2026-10-07', time, partySize: party, name: `R${time}`, source })).data.reservation.id;
  const a = await mk(1080, 2, 'google');
  const b = await mk(1110, 4, 'online');
  const d = await mk(1140, 3, 'phone');
  await mk(1170, 2, 'phone'); // left unresolved: still "booked" for a past date
  for (const s of ['seated', 'completed']) await c.post(`/api/r/${rid}/reservations/${a}/status`, { status: s });
  await c.post(`/api/r/${rid}/reservations/${b}/status`, { status: 'no_show' });
  await c.post(`/api/r/${rid}/reservations/${d}/status`, { status: 'cancelled' });
  const r = (await c.get(`/api/r/${rid}/reports?from=2026-10-01&to=2026-10-09`)).data;
  assert.equal(r.totals.reservations, 4);
  assert.equal(r.totals.seatedCovers, 2);
  assert.equal(r.totals.noShows, 1);
  assert.equal(r.totals.cancelled, 1);
  assert.equal(r.totals.unresolved, 1);
  assert.equal(r.rates.noShowRate, 0.5);
  assert.equal(r.feesAvoided.networkRateCovers, 2);
  assert.equal(r.feesAvoided.estimatedCents, 200);
});

test('password reset never reveals whether an account exists', async () => {
  const { email } = await signup(t);
  const anon = t.client();
  const unknown = await anon.post('/api/auth/forgot', { email: 'nobody@example.com' });
  const known = await anon.post('/api/auth/forgot', { email });
  assert.deepEqual(unknown.data, known.data);
  const mail = outboxRows(t, "kind = 'password_reset' AND recipient = ?", email);
  assert.equal(mail.length, 1);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail[0].body_text)[1];
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'a-much-better-password' })).status, 200);
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'a-much-better-password' })).status, 400, 'single use');
  assert.equal((await anon.post('/api/auth/login', { email, password: 'correct-horse-battery' })).status, 401);
  assert.equal((await anon.post('/api/auth/login', { email, password: 'a-much-better-password' })).status, 200);
});

test('platform admin manages licenses; others cannot see admin routes', async () => {
  const { c, rid } = await signup(t);
  assert.equal((await c.get('/api/admin/restaurants')).status, 404);
  t.app.db.run('UPDATE users SET is_platform_admin = 1 WHERE id = (SELECT user_id FROM memberships WHERE restaurant_id = ?)', rid);
  const list = await c.get('/api/admin/restaurants');
  assert.equal(list.status, 200);
  const set = await c.post(`/api/admin/restaurants/${rid}/license`, { status: 'lifetime', ref: 'check #1042' });
  assert.equal(set.status, 200);
  const r = (await c.get(`/api/r/${rid}`)).data;
  assert.equal(r.license.kind, 'lifetime');
  assert.equal(r.license.active, true);
});
