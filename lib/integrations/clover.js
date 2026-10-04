// Clover (read-only): OAuth v2 with expiring tokens, paid orders, webhooks.
// Docs: docs.clover.com/dev/docs/generate-expiring-tokens-using-v2-oauth-flow
// Production use requires an approved Clover App Market app. Clover orders
// have no closed time or guest count: modifiedTime approximates the close and
// the order title is the usual table hint in Clover Dining.

import { safeEqual } from '../crypto.js';

const API = {
  sandbox: 'https://apisandbox.dev.clover.com',
  us: 'https://api.clover.com',
  ca: 'https://api.clover.com',
  eu: 'https://api.eu.clover.com',
  la: 'https://api.la.clover.com',
};
const apiHost = (cfg) => (cfg.environment === 'production' ? API[cfg.region] || API.us : API.sandbox);
const authHost = (cfg) => (cfg.environment === 'production' ? 'https://www.clover.com' : 'https://sandbox.dev.clover.com');

async function call(url, { method = 'GET', token, body, fetchImpl }) {
  const res = await fetchImpl(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Clover ${res.status}: ${data.message || data.error || 'error'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Token responses carry Unix-second expirations.
const toCreds = (d, merchantId) => ({
  accessToken: d.access_token,
  refreshToken: d.refresh_token,
  expiresAt: d.access_token_expiration ? d.access_token_expiration * 1000 : null,
  refreshExpiresAt: d.refresh_token_expiration ? d.refresh_token_expiration * 1000 : null,
  merchantId,
});

const first = (list, key) => list?.elements?.[0]?.[key] ?? null;

export const clover = {
  id: 'clover',
  name: 'Clover',
  auth: 'oauth',

  isConfigured: (cfg) => Boolean(cfg.appId && cfg.appSecret),

  authorizeUrl(cfg, { state, redirectUri }) {
    const u = new URL(`${authHost(cfg)}/oauth/v2/authorize`);
    u.searchParams.set('client_id', cfg.appId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    return u.toString();
  },

  async exchangeCode(cfg, { code, merchantId }, fetchImpl) {
    if (!merchantId) throw new Error('Clover did not return a merchant id.');
    const data = await call(`${apiHost(cfg)}/oauth/v2/token`, {
      method: 'POST',
      fetchImpl,
      body: { client_id: cfg.appId, client_secret: cfg.appSecret, code },
    });
    return { credentials: toCreds(data, merchantId), externalId: merchantId, config: {} };
  },

  // Refresh tokens are single-use: always persist the new pair.
  async ensureFresh(cfg, creds, fetchImpl, now = Date.now()) {
    if (creds.expiresAt && creds.expiresAt - now > 5 * 60_000) return null;
    const data = await call(`${apiHost(cfg)}/oauth/v2/refresh`, {
      method: 'POST',
      fetchImpl,
      body: { client_id: cfg.appId, refresh_token: creds.refreshToken },
    });
    return toCreds(data, creds.merchantId);
  },

  async fetchChecks(cfg, creds, integrationConfig, { since, until }, fetchImpl) {
    const checks = [];
    const base = `${apiHost(cfg)}/v3/merchants/${encodeURIComponent(creds.merchantId)}/orders`;
    for (let offset = 0, page = 0; page < 20; page++, offset += 100) {
      const u = new URL(base);
      u.searchParams.append('filter', `modifiedTime>=${since}`);
      u.searchParams.append('filter', `modifiedTime<${until}`);
      u.searchParams.set('expand', 'customers');
      u.searchParams.set('limit', '100');
      u.searchParams.set('offset', String(offset));
      const data = await call(u.toString(), { token: creds.accessToken, fetchImpl });
      const orders = data.elements || [];
      for (const o of orders) {
        if (o.paymentState !== 'PAID') continue;
        const c = o.customers?.elements?.[0];
        checks.push({
          externalId: o.id,
          openedAt: o.clientCreatedTime || o.createdTime || null,
          closedAt: o.modifiedTime || null,
          totalCents: o.total ?? 0,
          tableRef: o.title || null,
          guestCount: null,
          customer: c
            ? {
                name: [c.firstName, c.lastName].filter(Boolean).join(' '),
                phone: first(c.phoneNumbers, 'phoneNumber'),
                email: first(c.emailAddresses, 'emailAddress'),
              }
            : null,
        });
      }
      if (orders.length < 100) break;
    }
    return checks;
  },

  // After the one-time URL verification, Clover sends a fixed auth code in
  // X-Clover-Auth with every delivery.
  verifyWebhook(cfg, { headers }) {
    const code = headers['x-clover-auth'];
    return Boolean(code && cfg.webhookAuthCode && safeEqual(code, cfg.webhookAuthCode));
  },

  webhookMerchants(body) {
    return Object.keys(body?.merchants || {});
  },
};
