// Integrations with every outbound call faked: Stripe card holds and fees,
// POS syncs and matching, webhook signatures, Google booking server.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { jsonResponse, signup, startTestApp } from './helpers.js';
import { expirePendingHolds } from '../lib/worker.js';
import { tableKey } from '../lib/integrations/matching.js';
import { encodeForm, verifyStripeSignature } from '../lib/integrations/stripe.js';
import { toastDate } from '../lib/integrations/toast.js';

let t;
const stripe = { sessions: new Map(), charges: [] };

before(async () => {
  t = await startTestApp({
    env: {
      SQUARE_CLIENT_ID: 'sq-id',
      SQUARE_CLIENT_SECRET: 'sq-secret',
      SQUARE_WEBHOOK_SIGNATURE_KEY: 'sq-sign',
      CLOVER_WEBHOOK_AUTH_CODE: 'clover-code',
      PLATFORM_STRIPE_SECRET_KEY: 'sk_test_platform',
      PLATFORM_STRIPE_WEBHOOK_SECRET: 'whsec_platform',
      GOOGLE_BOOKING_USER: 'google',
      GOOGLE_BOOKING_PASSWORD: 'g-pass',
    },
  });
  t.routes.push(
    { match: (u) => u.startsWith('https://api.stripe.com/v1/customers?') || u === 'https://api.stripe.com/v1/customers?limit=1', reply: () => jsonResponse({ data: [] }) },
    { match: (u, i) => u === 'https://api.stripe.com/v1/customers' && i.method === 'POST', reply: () => jsonResponse({ id: 'cus_123' }) },
    {
      match: (u, i) => u === 'https://api.stripe.com/v1/checkout/sessions' && i.method === 'POST',
      reply: (u, i) => {
        const p = new URLSearchParams(i.body);
        const id = `cs_${stripe.sessions.size + 1}`;
        stripe.sessions.set(id, { mode: p.get('mode'), code: p.get('client_reference_id') });
        return jsonResponse({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      },
    },
    {
      match: (u) => u.startsWith('https://api.stripe.com/v1/checkout/sessions/cs_'),
      reply: (u) => jsonResponse({ id: u.split('/').pop().split('?')[0], status: 'complete', customer: 'cus_123', setup_intent: { status: 'succeeded', payment_method: 'pm_card_visa' } }),
    },
    {
      match: (u) => u === 'https://api.stripe.com/v1/payment_intents',
      reply: (u, i) => {
        stripe.charges.push({ body: new URLSearchParams(i.body), key: i.headers['Idempotency-Key'] });
        return jsonResponse({ id: 'pi_1', status: 'succeeded' });
      },
    },
  );
});
after(() => t.close());
beforeEach(() => t.app.limiter.reset());

test('stripe form encoding and webhook signatures', () => {
  const f = encodeForm({ a: 1, line_items: [{ price_data: { unit_amount: 100 } }], m: { k: 'v' }, list: ['card'] });
  assert.equal(f.toString(), 'a=1&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=100&m%5Bk%5D=v&list%5B0%5D=card');
  const body = '{"x":1}';
  const ts = Math.floor(t.clock.t / 1000);
  const sig = createHmac('sha256', 'whsec_x').update(`${ts}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=${sig}`, 'whsec_x', 300, t.clock.t), true);
  assert.equal(verifyStripeSignature(body, `t=${ts},v1=${sig}`, 'whsec_y', 300, t.clock.t), false);
  assert.equal(verifyStripeSignature(body, `t=${ts - 1000},v1=${sig}`, 'whsec_x', 300, t.clock.t), false);
});

test('card hold: pending booking, hosted checkout, card on file, no-show fee', async () => {
  const { c, rid, slug } = await signup(t);
  await c.patch(`/api/r/${rid}/settings`, { cardRequiredMinParty: 6, noShowFeeCents: 2500 });
  const connect = await c.post(`/api/r/${rid}/integrations/stripe/connect`, { secretKey: 'rk_test_abc123' });
  assert.equal(connect.status, 200, JSON.stringify(connect.data));
  assert.equal(connect.data.mode, 'test');

  const anon = t.client();
  const profile = await anon.get(`/api/public/r/${slug}`);
  assert.equal(profile.data.cardHolds, true);
  const res = await anon.post(`/api/public/r/${slug}/reservations`, {
    date: '2026-10-10', time: 1140, partySize: 6, firstName: 'Big', lastName: 'Party', phone: '4155552000', email: 'big@example.com',
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'pending');
  assert.match(res.data.checkoutUrl, /^https:\/\/checkout\.stripe\.com/);
  const session = [...stripe.sessions.values()].pop();
  assert.equal(session.mode, 'setup');
  assert.equal(session.code, res.data.code);
  // No confirmation until the card is on file.
  assert.equal(t.app.db.all("SELECT * FROM outbox WHERE kind = 'confirmation' AND recipient = 'big@example.com'").length, 0);

  const row = t.app.db.one('SELECT * FROM reservations WHERE code = ?', res.data.code);
  const { manageToken } = await import('../lib/reservations.js');
  const back = await anon.get(`/r/${slug}/card-return?code=${row.code}&t=${manageToken(t.app, row)}`);
  assert.equal(back.status, 302);
  assert.match(back.headers.get('location'), /card=ok/);
  const updated = t.app.db.one('SELECT * FROM reservations WHERE id = ?', row.id);
  assert.equal(updated.status, 'booked');
  assert.equal(updated.card_status, 'on_file');
  assert.equal(updated.card_ref, 'pm_card_visa');
  assert.equal(updated.no_show_fee_cents, 15000);
  assert.equal(t.app.db.all("SELECT * FROM outbox WHERE kind = 'confirmation' AND recipient = 'big@example.com'").length, 1);

  const early = await c.post(`/api/r/${rid}/reservations/${row.id}/charge`, {});
  assert.equal(early.status, 409, 'must be a no-show first');
  await c.post(`/api/r/${rid}/reservations/${row.id}/status`, { status: 'no_show' });
  const charged = await c.post(`/api/r/${rid}/reservations/${row.id}/charge`, {});
  assert.equal(charged.status, 200, JSON.stringify(charged.data));
  assert.equal(charged.data.reservation.card.status, 'charged');
  assert.equal(charged.data.reservation.card.chargedCents, 15000);
  const pi = stripe.charges.pop();
  assert.equal(pi.body.get('amount'), '15000');
  assert.equal(pi.body.get('off_session'), 'true');
  assert.equal(pi.key, `fh-noshow-${row.code}`);
});

test('unfinished card holds release the table', async () => {
  const { c, rid, slug } = await signup(t);
  await c.patch(`/api/r/${rid}/settings`, { cardRequiredMinParty: 2 });
  await c.post(`/api/r/${rid}/integrations/stripe/connect`, { secretKey: 'rk_test_abc123' });
  const res = await t.client().post(`/api/public/r/${slug}/reservations`, {
    date: '2026-10-10', time: 1140, partySize: 2, firstName: 'Slow', phone: '4155552100',
  });
  assert.equal(res.data.status, 'pending');
  t.clock.t += 21 * 60_000;
  try {
    assert.equal(expirePendingHolds(t.app), 1);
    assert.equal(t.app.db.one('SELECT status, cancelled_by FROM reservations WHERE code = ?', res.data.code).status, 'cancelled');
  } finally {
    t.clock.t -= 21 * 60_000;
  }
});

test('lifetime license checkout and webhook activation', async () => {
  const { c, rid } = await signup(t);
  const checkout = await c.post(`/api/r/${rid}/license/checkout`, {});
  assert.equal(checkout.status, 200, JSON.stringify(checkout.data));
  const last = t.outbound.filter((o) => o.url === 'https://api.stripe.com/v1/checkout/sessions').pop();
  const p = new URLSearchParams(last.body);
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '100000');
  assert.equal(p.get('metadata[restaurant_id]'), String(rid));

  const event = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_paid', payment_status: 'paid', amount_total: 100000, metadata: { kind: 'lifetime_license', restaurant_id: String(rid) } } },
  });
  const ts = Math.floor(t.clock.t / 1000);
  const sig = createHmac('sha256', 'whsec_platform').update(`${ts}.${event}`).digest('hex');
  const bad = await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=00` }, body: event });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: event });
  assert.equal(ok.status, 200);
  const r = (await c.get(`/api/r/${rid}`)).data;
  assert.equal(r.license.kind, 'lifetime');
  assert.equal((await c.post(`/api/r/${rid}/license/checkout`, {})).status, 409);
});

test('toast: connect, sync, match a check to the seated party', async () => {
  const { c, rid } = await signup(t);
  const floor = (await c.get(`/api/r/${rid}/floor`)).data;
  const table5 = floor.tables.find((x) => x.name === '5');
  // A party seated at table 5 at 6 PM Friday; another booked for 9 PM.
  const seated = await c.post(`/api/r/${rid}/reservations`, { date: '2026-10-09', time: 1080, partySize: 4, name: 'Seated Party', tableIds: [table5.id], status: 'seated' });
  const byPhone = await c.post(`/api/r/${rid}/reservations`, { date: '2026-10-09', time: 1110, partySize: 2, name: 'Phone Match', phone: '4155553000', status: 'seated' });

  t.routes.push(
    { match: (u) => u.endsWith('/authentication/v1/authentication/login'), reply: () => jsonResponse({ token: { accessToken: 'toast-jwt', expiresIn: 3600 }, status: 'SUCCESS' }) },
    { match: (u) => u.includes('/config/v2/tables/'), reply: () => jsonResponse({ name: 'Table 5' }) },
    {
      match: (u) => u.includes('/orders/v2/ordersBulk'),
      reply: (u, i) => {
        assert.equal(i.headers['Toast-Restaurant-External-ID'], 'rest-guid');
        if (new URL(u).searchParams.get('page') !== '1') return jsonResponse([]);
        return jsonResponse([
          {
            guid: 'o1', table: { guid: 'tbl-5' }, numberOfGuests: 4, openedDate: '2026-10-10T01:00:00.000+0000',
            checks: [{ guid: 'c1', closedDate: '2026-10-10T02:40:00.000+0000', paymentStatus: 'PAID', totalAmount: 212.4 }],
          },
          {
            guid: 'o2', numberOfGuests: 2, openedDate: '2026-10-10T01:30:00.000+0000',
            checks: [{ guid: 'c2', closedDate: '2026-10-10T03:00:00.000+0000', paymentStatus: 'CLOSED', totalAmount: 88, customer: { firstName: 'P', phone: '(415) 555-3000' } }],
          },
          { guid: 'o3', voided: true, checks: [{ guid: 'c3', closedDate: '2026-10-10T03:00:00.000+0000', paymentStatus: 'PAID', totalAmount: 999 }] },
        ]);
      },
    },
  );
  const connect = await c.post(`/api/r/${rid}/integrations/toast/connect`, { clientId: 'cid', clientSecret: 'secret', restaurantGuid: 'rest-guid' });
  assert.equal(connect.status, 200, JSON.stringify(connect.data));
  t.clock.t = Date.parse('2026-10-10T03:30:00Z'); // 8:30 PM PDT
  try {
    const sync = await c.post(`/api/r/${rid}/integrations/toast/sync`, {});
    assert.equal(sync.status, 200, JSON.stringify(sync.data));
    assert.equal(sync.data.received, 2);
    assert.equal(sync.data.matched, 2);
    const a = (await c.get(`/api/r/${rid}/reservations/${seated.data.reservation.id}`)).data;
    assert.equal(a.reservation.status, 'completed');
    assert.equal(a.reservation.spendCents, 21240);
    assert.equal(a.checks[0].match_method, 'table');
    const b = (await c.get(`/api/r/${rid}/reservations/${byPhone.data.reservation.id}`)).data;
    assert.equal(b.checks[0].match_method, 'customer');
    const guest = (await c.get(`/api/r/${rid}/guests/${b.reservation.guestId}`)).data.guest;
    assert.equal(guest.total_spend_cents, 8800);
    // Re-running the sync is idempotent.
    const again = await c.post(`/api/r/${rid}/integrations/toast/sync`, {});
    assert.equal(again.data.matched, 2);
    assert.equal(t.app.db.one('SELECT count(*) AS n FROM pos_checks WHERE restaurant_id = ?', rid).n, 2);
    const list = (await c.get(`/api/r/${rid}/integrations`)).data;
    assert.equal(list.connected[0].provider, 'toast');
    assert.equal(list.connected[0].status, 'connected');
    assert.equal(JSON.stringify(list).includes('secret'), false, 'credentials never leave the server');
  } finally {
    t.clock.t = Date.parse('2026-10-09T19:00:00Z');
  }
});

test('square: oauth state is signed and webhooks are verified', async () => {
  const { c, rid } = await signup(t);
  const auth = await c.post(`/api/r/${rid}/integrations/square/authorize`, {});
  assert.equal(auth.status, 200);
  const url = new URL(auth.data.url);
  assert.equal(url.origin, 'https://connect.squareupsandbox.com');
  assert.equal(url.searchParams.get('scope'), 'ORDERS_READ CUSTOMERS_READ MERCHANT_PROFILE_READ PAYMENTS_READ');
  const state = url.searchParams.get('state');
  assert.ok(t.app.signer.verify(state));

  t.routes.push(
    { match: (u) => u.endsWith('/oauth2/token'), reply: () => jsonResponse({ access_token: 'sq-at', refresh_token: 'sq-rt', expires_at: '2026-11-08T00:00:00Z', merchant_id: 'M1' }) },
    { match: (u) => u.endsWith('/v2/locations'), reply: () => jsonResponse({ locations: [{ id: 'L1', name: 'Main', status: 'ACTIVE' }] }) },
    { match: (u) => u.endsWith('/v2/orders/search'), reply: () => jsonResponse({ orders: [] }) },
  );
  const cb = await c.get(`/oauth/square/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('location'), /connected=Square/);
  const forged = await c.get(`/oauth/square/callback?code=abc&state=forged`);
  assert.match(forged.headers.get('location'), /error=/);
  const integ = t.app.integrations.get(rid, 'square');
  assert.equal(integ.config.locationId, 'L1');
  assert.equal(integ.external_id, 'M1');

  const body = JSON.stringify({ merchant_id: 'M1', type: 'order.updated' });
  const sig = createHmac('sha256', 'sq-sign').update(`http://localhost/webhooks/square${body}`).digest('base64');
  const good = await fetch(`${t.base}/webhooks/square`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': sig }, body });
  assert.equal(good.status, 200);
  const bad = await fetch(`${t.base}/webhooks/square`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': 'nope' }, body });
  assert.equal(bad.status, 401);
});

test('clover webhooks: verification handshake and auth code', async () => {
  const hello = await fetch(`${t.base}/webhooks/clover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"verificationCode":"abc"}' });
  assert.equal(hello.status, 200);
  const body = JSON.stringify({ appId: 'A', merchants: { M9: [{ objectId: 'O:1', type: 'UPDATE', ts: 1 }] } });
  const ok = await fetch(`${t.base}/webhooks/clover`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-clover-auth': 'clover-code' }, body });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${t.base}/webhooks/clover`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-clover-auth': 'wrong' }, body });
  assert.equal(bad.status, 401);
});

test('helpers: table keys and Toast date format', () => {
  assert.equal(tableKey('Table 12'), '12');
  assert.equal(tableKey('TBL #12'), '12');
  assert.equal(tableKey('Patio 3'), 'patio3');
  assert.equal(toastDate(Date.parse('2026-10-10T02:40:00Z')), '2026-10-10T02:40:00.000+0000');
});

test('google booking server: auth, lookup, idempotent create, status, cancel, list', async () => {
  const { c, rid, slug } = await signup(t);
  const auth = `Basic ${Buffer.from('google:g-pass').toString('base64')}`;
  const call = (method, body) =>
    fetch(`${t.base}/google/v3/${method}/`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, data: await r.json() }));

  assert.equal((await fetch(`${t.base}/google/v3/HealthCheck/`)).status, 401);
  assert.equal((await call('HealthCheck')).status, 200);
  // Not opted in yet: unknown merchant.
  const start = String(Date.parse('2026-10-11T02:00:00Z') / 1000); // Sat 7 PM PDT
  const slot = { merchant_id: slug, service_id: 'dining', start_sec: start, duration_sec: '5400', resources: { party_size: 2 } };
  assert.equal((await call('BatchAvailabilityLookup', { merchant_id: slug, slot_time: [] })).status, 400);
  await c.patch(`/api/r/${rid}/settings`, { googleEndToEnd: true });

  const lookup = await call('BatchAvailabilityLookup', {
    merchant_id: slug,
    slot_time: [
      { service_id: 'dining', start_sec: start, duration_sec: '5400', resource_ids: { party_size: 2 } },
      { service_id: 'dining', start_sec: String(Number(start) + 420), duration_sec: '5400', resource_ids: { party_size: 2 } },
    ],
  });
  assert.equal(lookup.status, 200);
  assert.deepEqual(lookup.data.slot_time_availability.map((s) => s.available), [true, false]);

  const create = { slot, user_information: { user_id: 'g-user-1', given_name: 'Larry', family_name: 'Page', telephone: '+14155554000', email: 'lp@example.com' }, idempotency_token: 'tok-1' };
  const first = await call('CreateBooking', create);
  assert.equal(first.status, 200);
  assert.equal(first.data.booking.status, 'CONFIRMED');
  assert.equal(first.data.booking.slot.start_sec, start);
  const replay = await call('CreateBooking', create);
  assert.deepEqual(replay.data, first.data, 'same token, same answer, one booking');
  assert.equal(t.app.db.one("SELECT count(*) AS n FROM reservations WHERE source = 'google'").n, 1);

  const id = first.data.booking.booking_id;
  assert.equal((await call('GetBookingStatus', { booking_id: id })).data.booking_status, 'CONFIRMED');
  assert.equal((await call('ListBookings', { user_id: 'g-user-1' })).data.bookings.length, 1);
  const cancel = await call('UpdateBooking', { booking: { booking_id: id, status: 'CANCELED' }, update_mask: 'status' });
  assert.equal(cancel.data.booking.status, 'CANCELED');
  const twice = await call('UpdateBooking', { booking: { booking_id: id, status: 'CANCELED' }, update_mask: 'status' });
  assert.equal(twice.data.booking_failure.cause, 'BOOKING_ALREADY_CANCELLED');
  assert.equal((await call('GetBookingStatus', { booking_id: 'NOPE' })).status, 400);

  const feed = await fetch(`${t.base}/google/feeds/availability.json`, { headers: { authorization: auth } }).then((r) => r.json());
  const entries = feed.service_availability[0].availability.filter((a) => a.merchant_id === slug);
  assert.ok(entries.length > 100);
  assert.equal(feed.metadata.processing_instruction, 'PROCESS_AS_COMPLETE');
  const merchants = await fetch(`${t.base}/google/feeds/merchants.json`, { headers: { authorization: auth } }).then((r) => r.json());
  assert.ok(merchants.merchant.some((m) => m.merchant_id === slug));
});
