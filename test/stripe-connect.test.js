// Stripe Connect: a restaurant links its own Stripe account with one click,
// card holds run on that account through the platform key, and the link can
// be ended from either side.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { jsonResponse, signup, startTestApp } from './helpers.js';

const ENV = {
  PLATFORM_STRIPE_SECRET_KEY: 'sk_test_platform',
  PLATFORM_STRIPE_WEBHOOK_SECRET: 'whsec_platform',
  STRIPE_CONNECT_CLIENT_ID: 'ca_test123',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect',
};

let t;
before(async () => {
  t = await startTestApp({ env: ENV });
  t.routes.push(
    { match: (u) => u === 'https://connect.stripe.com/oauth/token', reply: () => jsonResponse({ stripe_user_id: 'acct_restaurant1', livemode: false, scope: 'read_write' }) },
    { match: (u) => u === 'https://connect.stripe.com/oauth/deauthorize', reply: () => jsonResponse({ stripe_user_id: 'acct_restaurant1' }) },
    { match: (u, i) => u === 'https://api.stripe.com/v1/customers' && i.method === 'POST', reply: () => jsonResponse({ id: 'cus_connected' }) },
    { match: (u, i) => u === 'https://api.stripe.com/v1/checkout/sessions' && i.method === 'POST', reply: () => jsonResponse({ id: 'cs_c1', url: 'https://checkout.stripe.com/c/pay/cs_c1' }) },
  );
});
after(() => t.close());
beforeEach(() => t.app.limiter.reset());

async function connect(c, rid) {
  const auth = await c.post(`/api/r/${rid}/integrations/stripe/authorize`);
  assert.equal(auth.status, 200);
  const url = new URL(auth.data.url);
  const back = await c.get(`/oauth/stripe/callback?code=ac_test&state=${encodeURIComponent(url.searchParams.get('state'))}`);
  return { url, back };
}

test('owners connect Stripe with one click; we keep only the account id', async () => {
  const { c, rid } = await signup(t, { restaurantName: 'Connect Cafe' });
  assert.equal((await c.get(`/api/r/${rid}/integrations`)).data.available.stripe.connect, true);
  const { url, back } = await connect(c, rid);
  assert.equal(url.origin + url.pathname, 'https://connect.stripe.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'ca_test123');
  assert.equal(url.searchParams.get('scope'), 'read_write');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost/oauth/stripe/callback');
  assert.equal(url.searchParams.get('stripe_user[business_name]'), 'Connect Cafe');
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/app#/settings/protection?connected=Stripe');

  const row = t.app.db.one("SELECT * FROM integrations WHERE restaurant_id = ? AND provider = 'stripe'", rid);
  assert.equal(row.external_id, 'acct_restaurant1');
  assert.deepEqual(t.app.vault.decrypt(row.credentials), { accountId: 'acct_restaurant1' }, 'no keys or tokens stored');
  const r = (await c.get(`/api/r/${rid}`)).data;
  assert.equal(r.stripeConnected, true);
  assert.deepEqual(r.stripe, { method: 'connect', mode: 'test', connectAvailable: true });
});

test('card holds run on the restaurant\'s account, not ours', async () => {
  const { c, rid, slug } = await signup(t);
  await connect(c, rid);
  await c.patch(`/api/r/${rid}/settings`, { cardRequiredMinParty: 2, noShowFeeCents: 2500 });
  t.outbound.length = 0;
  const res = await t.client().post(`/api/public/r/${slug}/reservations`, { date: '2026-10-16', time: 1140, partySize: 2, firstName: 'Card', phone: '4155550300', policyAccepted: true });
  assert.equal(res.data.status, 'pending');
  assert.match(res.data.checkoutUrl, /^https:\/\/checkout\.stripe\.com/);
  const calls = t.outbound.filter((o) => o.url.startsWith('https://api.stripe.com/'));
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.equal(call.headers.Authorization, 'Bearer sk_test_platform');
    assert.equal(call.headers['Stripe-Account'], 'acct_restaurant1', 'every call acts on the connected account');
  }
});

test('the link cannot be hijacked: wrong user, stale state, non-owners', async () => {
  const a = await signup(t);
  const b = await signup(t);
  const auth = await a.c.post(`/api/r/${a.rid}/integrations/stripe/authorize`);
  const state = new URL(auth.data.url).searchParams.get('state');
  const stolen = await b.c.get(`/oauth/stripe/callback?code=ac_x&state=${encodeURIComponent(state)}`);
  assert.match(stolen.headers.get('location'), /error=Log%20in%20as%20the%20owner/);
  const forged = await a.c.get('/oauth/stripe/callback?code=ac_x&state=forged');
  assert.match(forged.headers.get('location'), /error=/);
  assert.equal(t.app.db.one("SELECT count(*) AS n FROM integrations WHERE restaurant_id IN (?, ?) AND provider = 'stripe'", a.rid, b.rid).n, 0);
  const declined = await a.c.get(`/oauth/stripe/callback?error=access_denied&error_description=The%20user%20denied&state=${encodeURIComponent(state)}`);
  assert.match(declined.headers.get('location'), /error=The%20user%20denied/);
});

test('disconnecting ends access on Stripe\'s side too', async () => {
  const { c, rid } = await signup(t);
  await connect(c, rid);
  t.outbound.length = 0;
  assert.equal((await c.del(`/api/r/${rid}/integrations/stripe`)).status, 200);
  const call = t.outbound.find((o) => o.url === 'https://connect.stripe.com/oauth/deauthorize');
  const body = new URLSearchParams(call.body);
  assert.equal(body.get('client_id'), 'ca_test123');
  assert.equal(body.get('stripe_user_id'), 'acct_restaurant1');
  assert.equal((await c.get(`/api/r/${rid}`)).data.stripeConnected, false);
});

test('a restaurant revoking access from Stripe removes the link', async () => {
  const { c, rid } = await signup(t);
  await connect(c, rid);
  const event = JSON.stringify({ type: 'account.application.deauthorized', account: 'acct_restaurant1', data: { object: { id: 'ca_test123' } } });
  const ts = Math.floor(t.clock.t / 1000);
  const sign = (secret) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${event}`).digest('hex')}`;
  const post = (sig) => fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: event });
  assert.equal((await post(sign('whsec_wrong'))).status, 400);
  assert.equal((await post(sign('whsec_connect'))).status, 200);
  assert.equal((await c.get(`/api/r/${rid}`)).data.stripeConnected, false);
});

test('without Connect configured, owners still have the key fallback', async () => {
  const plain = await startTestApp();
  try {
    const { c, rid } = await signup(plain);
    assert.equal((await c.get(`/api/r/${rid}/integrations`)).data.available.stripe.connect, false);
    const res = await c.post(`/api/r/${rid}/integrations/stripe/authorize`);
    assert.equal(res.status, 409);
    assert.match(res.data.error.message, /restricted key/);
  } finally {
    await plain.close();
  }
});
