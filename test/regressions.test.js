// Regression tests for issues found in code review. Each test names the
// failure it guards against.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse, outboxRows, signup, startTestApp } from './helpers.js';
import { clientIp } from '../lib/security.js';
import { manageToken } from '../lib/reservations.js';
import { zonedToUtc } from '../lib/time.js';

let t;
before(async () => {
  t = await startTestApp({ env: { GOOGLE_BOOKING_USER: 'google', GOOGLE_BOOKING_PASSWORD: 'g-pass' } });
  t.routes.push(
    { match: (u) => u.startsWith('https://api.stripe.com/v1/customers'), reply: () => jsonResponse({ data: [], id: 'cus_1' }) },
    // Toast: the token depends on the secret, so token reuse across restaurants is visible.
    {
      match: (u) => u.endsWith('/authentication/v1/authentication/login'),
      reply: (u, i) => jsonResponse({ token: { accessToken: `token-for-${JSON.parse(i.body).clientSecret}`, expiresIn: 3600 } }),
    },
    { match: (u) => u.includes('/orders/v2/ordersBulk'), reply: () => jsonResponse([]) },
  );
});
after(() => t.close());
beforeEach(() => t.app.limiter.reset());

const NOON = Date.parse('2026-10-09T19:00:00Z');
const tokenOf = (row) => manageToken(t.app, row);

test('toast: one restaurant can never obtain or redirect another restaurant\'s token', async () => {
  const victim = await signup(t);
  const attacker = await signup(t);
  const evil = await attacker.c.post(`/api/r/${attacker.rid}/integrations/toast/connect`, { clientId: 'shared', clientSecret: 'x', restaurantGuid: 'g', host: 'https://evil.example' });
  assert.equal(evil.status, 400, 'non-Toast hosts are refused');
  assert.equal((await victim.c.post(`/api/r/${victim.rid}/integrations/toast/connect`, { clientId: 'shared', clientSecret: 'victim-secret', restaurantGuid: 'v' })).status, 200);
  assert.equal((await attacker.c.post(`/api/r/${attacker.rid}/integrations/toast/connect`, { clientId: 'shared', clientSecret: 'guess', restaurantGuid: 'a' })).status, 200);
  t.outbound.length = 0;
  await attacker.c.post(`/api/r/${attacker.rid}/integrations/toast/sync`, {});
  const sent = t.outbound.filter((o) => o.url.includes('ordersBulk')).map((o) => o.headers.Authorization);
  assert.ok(sent.length > 0);
  assert.ok(sent.every((h) => h === 'Bearer token-for-guess'), `attacker sync used ${sent}`);
});

test('the duplicate-booking rule cannot be used to look up someone else\'s booking time', async () => {
  const { slug } = await signup(t);
  const anon = t.client();
  const base = { date: '2026-10-09', partySize: 2, firstName: 'Vic', phone: '4155556000', email: 'vic@example.com' };
  assert.equal((await anon.post(`/api/public/r/${slug}/reservations`, { ...base, time: 1170 })).status, 200);
  // A junk probe gets the same answer whether or not the person has a booking.
  const probeKnown = await anon.post(`/api/public/r/${slug}/reservations`, { ...base, time: 1 });
  const probeUnknown = await anon.post(`/api/public/r/${slug}/reservations`, { ...base, time: 1, phone: '4155556999', email: 'nobody@example.com' });
  assert.equal(probeKnown.status, probeUnknown.status);
  assert.equal(probeKnown.data.error.code, probeUnknown.data.error.code);
  // A real second booking is refused without revealing when the first one is.
  const second = await anon.post(`/api/public/r/${slug}/reservations`, { ...base, time: 1260 });
  assert.equal(second.status, 409);
  assert.equal(second.data.error.code, 'duplicate');
  assert.ok(!/7:30|PM|AM/.test(second.data.error.message), second.data.error.message);
});

test('a guest growing the party never stays on a pinned table that is too small', async () => {
  const { c, rid, slug } = await signup(t);
  const floor = (await c.get(`/api/r/${rid}/floor`)).data;
  const twoTop = floor.tables.find((x) => x.name === '1');
  const made = await t.client().post(`/api/public/r/${slug}/reservations`, { date: '2026-10-16', time: 1140, partySize: 2, firstName: 'Pin', phone: '4155556100' });
  const row = t.app.db.one('SELECT * FROM reservations WHERE code = ?', made.data.code);
  await c.patch(`/api/r/${rid}/reservations/${row.id}`, { tableIds: [twoTop.id] });
  const grown = await t.client().post(`/api/public/m/${row.code}/modify?t=${tokenOf(row)}`, { partySize: 6 });
  assert.equal(grown.status, 200, JSON.stringify(grown.data));
  const after = t.app.db.one('SELECT table_ids, table_locked FROM reservations WHERE id = ?', row.id);
  assert.notDeepEqual(JSON.parse(after.table_ids), [twoTop.id]);
  assert.equal(after.table_locked, 0);
});

test('a waitlist party seated just after midnight lands on the right night', async () => {
  const { c, rid } = await signup(t);
  t.clock.t = zonedToUtc('2026-10-09', 23 * 60 + 50, 'America/Los_Angeles');
  try {
    const w = await c.post(`/api/r/${rid}/waitlist`, { name: 'Night Owl', partySize: 2 });
    t.clock.t = zonedToUtc('2026-10-10', 10, 'America/Los_Angeles'); // 12:10 AM Saturday
    const seated = await c.post(`/api/r/${rid}/waitlist/${w.data.id}/seat`, {});
    assert.equal(seated.status, 200, JSON.stringify(seated.data));
    const r = seated.data.reservation;
    assert.equal(r.date, '2026-10-09');
    assert.equal(r.time, 1450);
    assert.equal(r.startsAt, t.clock.t);
  } finally {
    t.clock.t = NOON;
  }
});

test('special hours are bounded, and a bad stored window cannot stall the server', async () => {
  const { c, rid, slug } = await signup(t);
  const huge = await c.post(`/api/r/${rid}/closures`, { date: '2026-10-20', closed: false, start_min: 0, last_seating_min: 3_000_000 });
  assert.equal(huge.status, 400);
  t.app.db.run("INSERT INTO closures (restaurant_id, date, closed, start_min, last_seating_min, note) VALUES (?, '2026-10-21', 0, 0, 3000000, 'bad')", rid);
  const started = Date.now();
  const res = await t.client().get(`/api/public/r/${slug}/availability?date=2026-10-21&party=2`);
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 1000, 'answered quickly');
  assert.ok(res.data.slots.length <= 30 * 4);
});

test('changing the time zone moves stored start times with it', async () => {
  const { c, rid } = await signup(t);
  const made = await c.post(`/api/r/${rid}/reservations`, { date: '2026-10-16', time: 1140, partySize: 2, name: 'Tz Guest' });
  await c.patch(`/api/r/${rid}`, { timezone: 'America/New_York' });
  const row = t.app.db.one('SELECT starts_at FROM reservations WHERE id = ?', made.data.reservation.id);
  assert.equal(row.starts_at, zonedToUtc('2026-10-16', 1140, 'America/New_York'));
});

test('growing a booking into the card-hold size requires a card', async () => {
  const { c, rid, slug } = await signup(t);
  await c.patch(`/api/r/${rid}/settings`, { cardRequiredMinParty: 6 });
  await c.post(`/api/r/${rid}/integrations/stripe/connect`, { secretKey: 'rk_test_abc' });
  const made = await t.client().post(`/api/public/r/${slug}/reservations`, { date: '2026-10-16', time: 1140, partySize: 2, firstName: 'Sneaky', phone: '4155556200' });
  assert.equal(made.data.status, 'booked');
  const row = t.app.db.one('SELECT * FROM reservations WHERE code = ?', made.data.code);
  const grow = await t.client().post(`/api/public/m/${row.code}/modify?t=${tokenOf(row)}`, { partySize: 6 });
  assert.equal(grow.status, 409);
  assert.equal(grow.data.error.code, 'card_required');
});

test('after-midnight seatings show the real calendar day to guests', async () => {
  const { c, rid, slug } = await signup(t);
  const shifts = (await c.get(`/api/r/${rid}/shifts`)).data;
  await c.patch(`/api/r/${rid}/shifts/${shifts[0].id}`, { last_seating_min: 25 * 60, end_min: 26 * 60 });
  const made = await t.client().post(`/api/public/r/${slug}/reservations`, { date: '2026-10-09', time: 1470, partySize: 2, firstName: 'Late', phone: '4155556300', email: 'late@example.com' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.reservation.displayDate, '2026-10-10');
  const mail = outboxRows(t, "kind = 'confirmation' AND recipient = 'late@example.com'")[0];
  assert.match(mail.subject, /Sat Oct 10, 12:30 AM/);
  assert.match(mail.body_text, /Saturday, October 10, 2026 at 12:30 AM/);
});

test('diners cannot set the source or external reference of a booking', async () => {
  const { slug } = await signup(t);
  const anon = t.client();
  const noPhone = await anon.post(`/api/public/r/${slug}/reservations`, { date: '2026-10-16', time: 1140, partySize: 2, firstName: 'Spoof', email: 'spoof@example.com', source: 'google' });
  assert.equal(noPhone.status, 400, 'claiming Google does not skip the phone requirement');
  const ref = await anon.post(`/api/public/r/${slug}/reservations`, { date: '2026-10-16', time: 1170, partySize: 2, firstName: 'Ref', phone: '4155556400', externalRef: 'import:R-1', status: 'seated', staffNotes: 'x' });
  assert.equal(ref.status, 200);
  const row = t.app.db.one('SELECT external_ref, status, staff_notes FROM reservations WHERE code = ?', ref.data.code);
  assert.equal(row.external_ref, null);
  assert.equal(row.status, 'booked');
  assert.equal(row.staff_notes, '');
});

test('imported reservations never get automatic reminders', async () => {
  const { c, rid } = await signup(t);
  const csv = 'Date,Time,Party Size,Name,Email\n10/12/2026,7:00 PM,2,Imported Ivy,ivy@example.com\n';
  assert.equal((await c.post(`/api/r/${rid}/import/commit`, { kind: 'reservations', csv })).data.created, 1);
  t.clock.t = Date.parse('2026-10-12T03:00:00Z'); // 23h before
  try {
    t.app.notify.queueReminders();
    assert.equal(outboxRows(t, "kind = 'reminder' AND recipient = 'ivy@example.com'").length, 0);
  } finally {
    t.clock.t = NOON;
  }
});

test('google can move a booking to an after-midnight slot', async () => {
  const { c, rid, slug } = await signup(t);
  const shifts = (await c.get(`/api/r/${rid}/shifts`)).data;
  await c.patch(`/api/r/${rid}/shifts/${shifts[0].id}`, { last_seating_min: 25 * 60, end_min: 26 * 60 });
  await c.patch(`/api/r/${rid}/settings`, { googleEndToEnd: true });
  const auth = `Basic ${Buffer.from('google:g-pass').toString('base64')}`;
  const call = (method, body) => fetch(`${t.base}/google/v3/${method}/`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const at = (date, min) => String(zonedToUtc(date, min, 'America/Los_Angeles') / 1000);
  const created = await call('CreateBooking', {
    slot: { merchant_id: slug, service_id: 'dining', start_sec: at('2026-10-16', 1200), duration_sec: '5400', resources: { party_size: 2 } },
    user_information: { user_id: 'u-midnight', given_name: 'G', telephone: '+14155556500' },
    idempotency_token: 'mid-1',
  });
  const moved = await call('UpdateBooking', {
    booking: { booking_id: created.booking.booking_id, slot: { start_sec: at('2026-10-17', 30), resources: { party_size: 2 } } },
    update_mask: 'start_sec',
  });
  assert.ok(moved.booking, JSON.stringify(moved));
  const row = t.app.db.one('SELECT date, start_min FROM reservations WHERE code = ?', created.booking.booking_id);
  assert.deepEqual({ ...row }, { date: '2026-10-16', start_min: 1470 });
});

test('undoing a visit clears the last-visit date; imported visit counts stay consistent', async () => {
  const { c, rid } = await signup(t);
  const made = await c.post(`/api/r/${rid}/reservations`, { date: '2026-10-08', time: 1140, partySize: 2, name: 'Undo Me', phone: '4155556600' });
  const id = made.data.reservation.id;
  for (const s of ['seated', 'arrived', 'booked', 'cancelled']) await c.post(`/api/r/${rid}/reservations/${id}/status`, { status: s });
  let g = (await c.get(`/api/r/${rid}/guests/${made.data.reservation.guestId}`)).data.guest;
  assert.equal(g.visit_count, 0);
  assert.equal(g.last_visit_date, null);

  const twice = await c.post(`/api/r/${rid}/reservations`, { date: '2026-10-07', time: 1140, partySize: 2, name: 'Count Me', phone: '4155556700' });
  for (const s of ['seated', 'completed']) await c.post(`/api/r/${rid}/reservations/${twice.data.reservation.id}/status`, { status: s });
  await c.post(`/api/r/${rid}/import/commit`, { kind: 'guests', csv: 'Name,Phone,Visits\nCount Me,4155556700,3\n' });
  g = (await c.get(`/api/r/${rid}/guests/${twice.data.reservation.guestId}`)).data.guest;
  assert.equal(g.visit_count, 4, '3 imported + 1 here, immediately');
});

test('behind a proxy, the client is the address the proxy appended', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req, true), '203.0.113.9');
  assert.equal(clientIp(req, false), '127.0.0.1');
});

test('malformed table lists are a 400, not a crash', async () => {
  const { c, rid } = await signup(t);
  const made = await c.post(`/api/r/${rid}/reservations`, { date: '2026-10-16', time: 1140, partySize: 2, name: 'Bad Input' });
  const res = await c.patch(`/api/r/${rid}/reservations/${made.data.reservation.id}`, { tableIds: '3' });
  assert.equal(res.status, 400);
});
