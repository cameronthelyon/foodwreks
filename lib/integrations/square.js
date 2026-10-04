// Square (read-only): OAuth, completed orders, customers, webhooks.
// Docs: developer.squareup.com/reference/square/orders-api/search-orders
// Square orders carry no table or guest-count field; ticket_name is the only
// table hint (Square for Restaurants often puts "Table 12" there).

import { hmac, safeEqual } from '../crypto.js';

export const SQUARE_VERSION = '2026-09-16';
const SCOPES = ['ORDERS_READ', 'CUSTOMERS_READ', 'MERCHANT_PROFILE_READ', 'PAYMENTS_READ'];
const host = (cfg) => (cfg.environment === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com');

async function call(cfg, path, { method = 'GET', token, body, fetchImpl }) {
  const res = await fetchImpl(`${host(cfg)}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.errors?.map((e) => e.detail || e.code).join('; ') || data.message || res.status;
    const err = new Error(`Square ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const toCreds = (d) => ({
  accessToken: d.access_token,
  refreshToken: d.refresh_token,
  expiresAt: d.expires_at ? Date.parse(d.expires_at) : null,
  merchantId: d.merchant_id,
});

export const square = {
  id: 'square',
  name: 'Square',
  auth: 'oauth',

  isConfigured: (cfg) => Boolean(cfg.clientId && cfg.clientSecret),

  authorizeUrl(cfg, { state, redirectUri }) {
    const u = new URL(`${host(cfg)}/oauth2/authorize`);
    u.searchParams.set('client_id', cfg.clientId);
    u.searchParams.set('scope', SCOPES.join(' '));
    u.searchParams.set('state', state);
    if (redirectUri) u.searchParams.set('redirect_uri', redirectUri);
    if (cfg.environment === 'production') u.searchParams.set('session', 'false');
    return u.toString();
  },

  async exchangeCode(cfg, { code, redirectUri }, fetchImpl) {
    const data = await call(cfg, '/oauth2/token', {
      method: 'POST',
      fetchImpl,
      body: { client_id: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri },
    });
    const credentials = toCreds(data);
    const locations = await this.listLocations(cfg, credentials, fetchImpl);
    return { credentials, externalId: credentials.merchantId, config: { locationId: locations[0]?.id || null, locations } };
  },

  // Code-flow refresh tokens do not expire; access tokens last 30 days.
  async ensureFresh(cfg, creds, fetchImpl, now = Date.now()) {
    if (creds.expiresAt && creds.expiresAt - now > 7 * 86400_000) return null;
    const data = await call(cfg, '/oauth2/token', {
      method: 'POST',
      fetchImpl,
      body: { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token', refresh_token: creds.refreshToken },
    });
    return { ...toCreds(data), refreshToken: data.refresh_token || creds.refreshToken };
  },

  async listLocations(cfg, creds, fetchImpl) {
    const data = await call(cfg, '/v2/locations', { token: creds.accessToken, fetchImpl });
    return (data.locations || []).filter((l) => l.status !== 'INACTIVE').map((l) => ({ id: l.id, name: l.name }));
  },

  async fetchChecks(cfg, creds, integrationConfig, { since, until }, fetchImpl) {
    if (!integrationConfig.locationId) throw new Error('Pick a Square location first.');
    const checks = [];
    const customers = new Map();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const data = await call(cfg, '/v2/orders/search', {
        method: 'POST',
        token: creds.accessToken,
        fetchImpl,
        body: {
          location_ids: [integrationConfig.locationId],
          limit: 500,
          cursor,
          query: {
            filter: {
              state_filter: { states: ['COMPLETED'] },
              date_time_filter: { closed_at: { start_at: new Date(since).toISOString(), end_at: new Date(until).toISOString() } },
            },
            sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' },
          },
        },
      });
      for (const o of data.orders || []) {
        let customer = null;
        if (o.customer_id) {
          if (!customers.has(o.customer_id) && customers.size < 200) {
            try {
              const c = (await call(cfg, `/v2/customers/${encodeURIComponent(o.customer_id)}`, { token: creds.accessToken, fetchImpl })).customer;
              customers.set(o.customer_id, c);
            } catch {
              customers.set(o.customer_id, null);
            }
          }
          const c = customers.get(o.customer_id);
          if (c) customer = { name: [c.given_name, c.family_name].filter(Boolean).join(' '), phone: c.phone_number || null, email: c.email_address || null };
        }
        checks.push({
          externalId: o.id,
          openedAt: o.created_at ? Date.parse(o.created_at) : null,
          closedAt: o.closed_at ? Date.parse(o.closed_at) : null,
          totalCents: o.total_money?.amount ?? 0,
          tableRef: o.ticket_name || null,
          guestCount: null,
          customer,
        });
      }
      cursor = data.cursor;
      if (!cursor) break;
    }
    return checks;
  },

  // x-square-hmacsha256-signature = base64(HMAC-SHA256(signature key, notification URL + raw body))
  verifyWebhook(cfg, { headers, rawBody, url }) {
    const sig = headers['x-square-hmacsha256-signature'];
    if (!sig || !cfg.webhookSignatureKey) return false;
    return safeEqual(sig, hmac(cfg.webhookSignatureKey, url + rawBody, 'base64'));
  },

  webhookMerchants(body) {
    return body?.merchant_id ? [body.merchant_id] : [];
  },
};
