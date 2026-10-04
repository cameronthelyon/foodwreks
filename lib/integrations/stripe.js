// Stripe over plain fetch. Two uses:
//   1. Card holds and no-show fees on the RESTAURANT'S OWN Stripe account
//      (restricted key). Money goes straight to the restaurant; we never
//      touch it and take no cut.
//   2. The one-time license payment on the platform's account.

import { hmac, safeEqual } from '../crypto.js';

const API = 'https://api.stripe.com/v1';
const VERSION = '2024-06-20';

export class StripeError extends Error {
  constructor(message, { status, code, declineCode, type } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.declineCode = declineCode;
    this.type = type;
  }
}

// Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0]=v.
export function encodeForm(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? encodeForm(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripeRequest(key, method, path, params, { idempotencyKey, fetchImpl = globalThis.fetch } = {}) {
  const query = method === 'GET' && params ? `?${encodeForm(params)}` : '';
  const res = await fetchImpl(`${API}${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': VERSION,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: method === 'GET' ? undefined : encodeForm(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    throw new StripeError(e.message || `Stripe error ${res.status}`, {
      status: res.status,
      code: e.code,
      declineCode: e.decline_code,
      type: e.type,
    });
  }
  return data;
}

export async function verifyRestaurantKey(key, fetchImpl) {
  if (!/^(rk|sk)_(test|live)_[A-Za-z0-9]+$/.test(String(key))) {
    throw new StripeError('That does not look like a Stripe secret or restricted key.', { status: 400 });
  }
  await stripeRequest(key, 'GET', '/customers', { limit: 1 }, { fetchImpl });
  return { mode: key.includes('_live_') ? 'live' : 'test' };
}

// Starts a hosted Stripe Checkout page in setup mode: the diner saves a card,
// nothing is charged.
export async function createCardHoldSession(key, { customerId, guest, reservation, restaurant, successUrl, cancelUrl, fetchImpl }) {
  let customer = customerId;
  if (!customer) {
    const created = await stripeRequest(
      key,
      'POST',
      '/customers',
      {
        name: guest.name || undefined,
        email: guest.email || undefined,
        phone: guest.phone || undefined,
        metadata: { source: 'freehold', guest_id: guest.id },
      },
      { fetchImpl, idempotencyKey: `fh-cus-${restaurant.id}-${guest.id}` },
    );
    customer = created.id;
  }
  const session = await stripeRequest(
    key,
    'POST',
    '/checkout/sessions',
    {
      mode: 'setup',
      customer,
      payment_method_types: ['card'],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: reservation.code,
      metadata: { reservation_code: reservation.code, restaurant: restaurant.slug },
      setup_intent_data: { metadata: { reservation_code: reservation.code }, description: `Card hold for ${restaurant.name}` },
    },
    { fetchImpl, idempotencyKey: `fh-setup-${reservation.code}` },
  );
  return { customerId: customer, sessionId: session.id, url: session.url };
}

// Returns the saved payment method once the diner finished Checkout.
export async function completedCardHold(key, sessionId, fetchImpl) {
  const s = await stripeRequest(key, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: ['setup_intent'] }, { fetchImpl });
  const intent = s.setup_intent;
  if (s.status !== 'complete' || !intent || intent.status !== 'succeeded') return null;
  return { paymentMethod: typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id, customerId: s.customer };
}

export async function chargeNoShowFee(key, { customerId, paymentMethod, amountCents, reservation, restaurant, fetchImpl }) {
  return stripeRequest(
    key,
    'POST',
    '/payment_intents',
    {
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethod,
      off_session: true,
      confirm: true,
      description: `No-show fee, ${restaurant.name}, reservation ${reservation.code}`,
      metadata: { reservation_code: reservation.code, kind: 'no_show_fee' },
    },
    { fetchImpl, idempotencyKey: `fh-noshow-${reservation.code}` },
  );
}

// Platform: the one-time lifetime license.
export async function createLicenseCheckout(key, { restaurant, priceCents, brand, email, successUrl, cancelUrl, fetchImpl }) {
  const session = await stripeRequest(
    key,
    'POST',
    '/checkout/sessions',
    {
      mode: 'payment',
      client_reference_id: String(restaurant.id),
      customer_email: email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: priceCents,
            product_data: { name: `${brand} lifetime license`, description: `One location: ${restaurant.name}. Pay once, no cover fees, no monthly rent.` },
          },
        },
      ],
      metadata: { restaurant_id: String(restaurant.id), kind: 'lifetime_license' },
    },
    { fetchImpl },
  );
  return { url: session.url, id: session.id };
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.payload">[,v1=...]
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowMs = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.groupBy
    ? Object.groupBy(String(header).split(','), (p) => p.split('=')[0])
    : String(header)
        .split(',')
        .reduce((a, p) => ((a[p.split('=')[0]] ||= []).push(p), a), {});
  const t = parts.t?.[0]?.slice(2);
  const sigs = (parts.v1 || []).map((p) => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
  const expected = hmac(secret, `${t}.${rawBody}`);
  return sigs.some((s) => safeEqual(s, expected));
}
