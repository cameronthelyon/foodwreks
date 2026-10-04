// Diner-facing flows end to end over HTTP.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { outboxRows, signup, startTestApp } from './helpers.js';

let t;
before(async () => {
  t = await startTestApp();
});
after(() => t.close());
beforeEach(() => t.app.limiter.reset());

const TONIGHT = '2026-10-09'; // Friday, starter dinner shift runs 17:00-21:30

function bookingBody(over = {}) {
  return {
    date: TONIGHT,
    time: 19 * 60,
    partySize: 2,
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '(415) 555-0100',
    email: 'ada@example.com',
    notes: 'Window if possible',
    ...over,
  };
}

test('config and public profile', async () => {
  const { slug } = await signup(t);
  const anon = t.client();
  const cfg = await anon.get('/api/config');
  assert.equal(cfg.data.licensePriceCents, 100000);
  const profile = await anon.get(`/api/public/r/${slug}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.data.onlineBooking, true);
  assert.equal(profile.data.today, TONIGHT);
  assert.equal(profile.data.restaurant.slug, slug);
  assert.equal((await anon.get('/api/public/r/nope')).status, 404);
});

test('availability, booking, confirmation outbox, duplicate guard', async () => {
  const { slug } = await signup(t);
  const anon = t.client();
  const avail = await anon.get(`/api/public/r/${slug}/availability?date=${TONIGHT}&party=2`);
  assert.equal(avail.status, 200);
  assert.equal(avail.data.slots[0].label, '5:00 PM');
  assert.ok(avail.data.slots.every((s) => s.available));

  const res = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody());
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'booked');
  assert.match(res.data.code, /^[2-9A-Z]{8}$/);
  assert.match(res.data.manageUrl, new RegExp(`/m/${res.data.code}\\?t=`));
  assert.equal(res.data.reservation.phone, '+14155550100');

  const mail = outboxRows(t, "kind = 'confirmation' AND recipient = ?", 'ada@example.com');
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /You're booked/);
  assert.match(mail[0].body_text, /Fri Oct 9|Friday, October 9/);
  assert.ok(mail[0].body_html.includes(res.data.code) || mail[0].body_text.includes('/m/'));

  const dupe = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody({ time: 20 * 60 }));
  assert.equal(dupe.status, 409);
  assert.match(dupe.data.error.message, /already have a reservation/);
});

test('validation: off-grid time, bad phone, missing name, honeypot, large party', async () => {
  const { slug } = await signup(t);
  const anon = t.client();
  const offGrid = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody({ time: 19 * 60 + 7, phone: '4155550101', email: 'a1@example.com' }));
  assert.equal(offGrid.status, 409);
  const badPhone = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody({ phone: '123', email: 'a2@example.com' }));
  assert.equal(badPhone.status, 400);
  const noName = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody({ firstName: '', phone: '4155550102', email: 'a3@example.com' }));
  assert.equal(noName.status, 400);
  const bot = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody({ website: 'http://spam', phone: '4155550103', email: 'a4@example.com' }));
  assert.equal(bot.status, 400);
  const big = await anon.get(`/api/public/r/${slug}/availability?date=${TONIGHT}&party=12`);
  assert.equal(big.data.largeParty, true);
  assert.equal(big.data.slots.length, 0);
});

test('a full slot never double-books a table', async () => {
  const { slug, c, rid } = await signup(t);
  const anon = t.client();
  let booked = 0;
  for (let i = 0; i < 20; i++) {
    t.app.limiter.reset();
    const r = await anon.post(
      `/api/public/r/${slug}/reservations`,
      bookingBody({ partySize: 4, phone: `41555502${String(i).padStart(2, '0')}`, email: `four${i}@example.com` }),
    );
    if (r.status === 200) booked++;
    else assert.equal(r.status, 409);
  }
  // Starter floor seats a party of 4 at tables 5-8 and the 6-top (9).
  assert.equal(booked, 5);
  const day = await c.get(`/api/r/${rid}/day/${TONIGHT}`);
  const tables = day.data.reservations.flatMap((r) => r.tableIds);
  assert.equal(new Set(tables).size, tables.length, 'every table used once');
  const avail = await anon.get(`/api/public/r/${slug}/availability?date=${TONIGHT}&party=4`);
  assert.equal(avail.data.slots.find((s) => s.time === 19 * 60).available, false);
});

test('fully booked dates suggest the next available ones', async () => {
  const { slug, c, rid } = await signup(t);
  await c.post(`/api/r/${rid}/closures`, { date: TONIGHT, closed: true, note: 'Private party' });
  const res = await t.client().get(`/api/public/r/${slug}/availability?date=${TONIGHT}&party=2`);
  assert.equal(res.data.closed, true);
  assert.equal(res.data.message, 'Private party');
  assert.equal(res.data.next[0].date, '2026-10-10');
  assert.equal(res.data.next[0].times[0].label, '5:00 PM');
});

test('manage link: view, modify, calendar file, cancel', async () => {
  const { slug } = await signup(t);
  const anon = t.client();
  const made = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody({ date: '2026-10-16' }));
  const { code } = made.data;
  const token = new URL(made.data.manageUrl).searchParams.get('t');

  assert.equal((await anon.get(`/api/public/m/${code}?t=wrong`)).status, 404);
  const view = await anon.get(`/api/public/m/${code}?t=${token}`);
  assert.equal(view.data.canCancel, true);
  assert.equal(view.data.canChange, true);
  assert.equal(view.data.reservation.notes, 'Window if possible');

  const moved = await anon.post(`/api/public/m/${code}/modify?t=${token}`, { time: 20 * 60 + 30, partySize: 3 });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.reservation.timeLabel, '8:30 PM');
  assert.equal(moved.data.reservation.partySize, 3);
  assert.equal(outboxRows(t, "kind = 'modified' AND recipient = 'ada@example.com'").length >= 1, true);

  const ics = await fetch(`${t.base}/m/${code}/calendar.ics?t=${token}`);
  assert.equal(ics.headers.get('content-type'), 'text/calendar; charset=utf-8');
  const body = await ics.text();
  assert.match(body, /DTSTART:20261017T033000Z/); // 8:30 PM PDT
  assert.match(body, /\r\nEND:VCALENDAR\r\n$/);

  const cancelled = await anon.post(`/api/public/m/${code}/cancel?t=${token}`, {});
  assert.equal(cancelled.data.reservation.status, 'cancelled');
  assert.equal(outboxRows(t, "kind = 'cancelled_by_guest'").length >= 1, true);
  assert.equal((await anon.post(`/api/public/m/${code}/cancel?t=${token}`, {})).status, 409);
});

test('guests cannot cancel inside the cutoff', async () => {
  const { slug } = await signup(t);
  const anon = t.client();
  const made = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody({ time: 17 * 60, phone: '4155550300', email: 'late@example.com' }));
  const token = new URL(made.data.manageUrl).searchParams.get('t');
  t.clock.t += 4 * 3600_000; // 4 PM, an hour before
  try {
    const res = await anon.post(`/api/public/m/${made.data.code}/cancel?t=${token}`, {});
    assert.equal(res.status, 409);
    assert.match(res.data.error.message, /call the restaurant/);
  } finally {
    t.clock.t -= 4 * 3600_000;
  }
});

test('expired trial closes online booking but never locks staff out', async () => {
  const { slug, c, rid, email } = await signup(t);
  t.clock.t += 31 * 86400_000;
  try {
    // Sessions last 30 days; a host coming back logs in again.
    assert.equal((await c.get(`/api/r/${rid}`)).status, 401);
    assert.equal((await c.post('/api/auth/login', { email, password: 'correct-horse-battery' })).status, 200);
    const anon = t.client();
    const avail = await anon.get(`/api/public/r/${slug}/availability?date=2026-11-10&party=2`);
    assert.equal(avail.data.closed, true);
    const book = await anon.post(`/api/public/r/${slug}/reservations`, bookingBody({ date: '2026-11-10', phone: '4155550400', email: 'x@example.com' }));
    assert.equal(book.status, 403);
    // Staff still work and can export everything.
    assert.equal((await c.get(`/api/r/${rid}/day/2026-11-10`)).status, 200);
    const exp = await fetch(`${t.base}/api/r/${rid}/export/guests.csv`, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(exp.status, 200);
  } finally {
    t.clock.t -= 31 * 86400_000;
  }
});

test('security: JSON-only mutations and same-origin checks', async () => {
  const { slug } = await signup(t);
  const form = await fetch(`${t.base}/api/public/r/${slug}/reservations`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'date=2026-10-09',
  });
  assert.equal(form.status, 415);
  const foreign = await t.client().post(`/api/public/r/${slug}/reservations`, bookingBody(), { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const page = await fetch(`${t.base}/api/config`);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('online waitlist join and status page', async () => {
  const { slug, c, rid } = await signup(t);
  await c.patch(`/api/r/${rid}/settings`, { waitlistOnline: true });
  const anon = t.client();
  const join = await anon.post(`/api/public/r/${slug}/waitlist`, { name: 'Grace Hopper', partySize: 2, phone: '4155550500' });
  assert.equal(join.status, 200, JSON.stringify(join.data));
  const status = await anon.get(`/api/public${join.data.statusUrl.replace('/w/', '/w/')}`);
  assert.equal(status.data.position, 1);
  assert.equal(status.data.status, 'waiting');
  const url = new URL(join.data.statusUrl, t.base);
  const left = await anon.post(`/api/public/w/${url.pathname.split('/').pop()}/leave?t=${url.searchParams.get('t')}`, {});
  assert.equal(left.data.status, 'cancelled');
  assert.equal(left.data.position, null);
});
