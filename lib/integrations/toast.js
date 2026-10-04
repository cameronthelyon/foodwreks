// Toast (read-only) via Standard API access: credentials the restaurant
// creates itself in Toast Web (Integrations > Toast API access), needing the
// "Manage Integrations" permission and RMS Essentials or higher. Scopes:
// orders:read, config:read, and guest.pi:read (for check customer details).
// Docs: doc.toasttab.com/doc/devguide/devApiAccessScopes.html
// Toast issues the API hostname with the credentials; it is configurable.

import { sha256 } from '../crypto.js';

const DEFAULT_HOSTS = {
  production: 'https://ws-api.toasttab.com',
  sandbox: 'https://ws-sandbox-api.eng.toasttab.com',
};

// Access tokens, keyed by host + client id + a hash of the secret, so one
// restaurant's credentials can never yield a token another restaurant's sync
// would send anywhere.
const tokens = new Map();
const tokenKey = (host, creds) => `${host}|${creds.clientId}|${sha256(String(creds.clientSecret))}`;

// Toast issues hostnames under toasttab.com. Anything else is refused, so a
// credential form can never point our server at an arbitrary host.
export function validToastHost(host) {
  try {
    const u = new URL(host);
    return u.protocol === 'https:' && !u.port && u.pathname.replace(/\/+$/, '') === '' && /(^|\.)toasttab\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

async function call(url, { method = 'GET', token, body, restaurantGuid, fetchImpl }) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(restaurantGuid ? { 'Toast-Restaurant-External-ID': restaurantGuid } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Toast ${res.status}: ${data.message || data.status || 'error'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Toast wants ISO-8601 with milliseconds and a numeric offset.
export const toastDate = (ms) => new Date(ms).toISOString().replace('Z', '+0000');

const cents = (amount) => Math.round(Number(amount || 0) * 100);

export const toast = {
  id: 'toast',
  name: 'Toast',
  auth: 'client_credentials',

  isConfigured: () => true,

  hostFor(cfg, creds) {
    return (creds.host || DEFAULT_HOSTS[cfg.environment === 'production' ? 'production' : 'sandbox']).replace(/\/+$/, '');
  },

  async login(cfg, creds, fetchImpl, now = Date.now()) {
    const host = this.hostFor(cfg, creds);
    if (!validToastHost(host)) throw new Error('Toast API host must be an https toasttab.com address.');
    const key = tokenKey(host, creds);
    const cached = tokens.get(key);
    if (cached && cached.expiresAt - now > 60_000) return cached.token;
    const data = await call(`${host}/authentication/v1/authentication/login`, {
      method: 'POST',
      fetchImpl,
      body: { clientId: creds.clientId, clientSecret: creds.clientSecret, userAccessType: 'TOAST_MACHINE_CLIENT' },
    });
    const token = data.token?.accessToken;
    if (!token) throw new Error('Toast did not return an access token.');
    tokens.set(key, { token, expiresAt: now + (data.token.expiresIn || 3600) * 1000 });
    return token;
  },

  // Called when a restaurant pastes its credentials: proves they work.
  async connect(cfg, input, fetchImpl) {
    const creds = {
      clientId: String(input.clientId || '').trim(),
      clientSecret: String(input.clientSecret || '').trim(),
      restaurantGuid: String(input.restaurantGuid || '').trim(),
      host: input.host ? String(input.host).trim() : '',
    };
    if (!creds.clientId || !creds.clientSecret || !creds.restaurantGuid) {
      throw new Error('Client ID, client secret and restaurant GUID are all required.');
    }
    if (creds.host && !validToastHost(creds.host)) throw new Error('API host must be an https toasttab.com address, as shown with your Toast credentials.');
    tokens.delete(tokenKey(this.hostFor(cfg, creds), creds));
    await this.login(cfg, creds, fetchImpl);
    return { credentials: creds, externalId: creds.restaurantGuid, config: { tableNames: {} } };
  },

  async ensureFresh() {
    return null; // tokens are fetched per run and cached in memory
  },

  async tableName(cfg, creds, token, guid, cache, fetchImpl) {
    if (!guid) return null;
    if (cache[guid]) return cache[guid];
    try {
      const t = await call(`${this.hostFor(cfg, creds)}/config/v2/tables/${encodeURIComponent(guid)}`, {
        token,
        restaurantGuid: creds.restaurantGuid,
        fetchImpl,
      });
      cache[guid] = t.name || guid;
    } catch {
      cache[guid] = guid;
    }
    return cache[guid];
  },

  // ordersBulk filters on MODIFIED time; we take paid/closed checks only.
  async fetchChecks(cfg, creds, integrationConfig, { since, until }, fetchImpl) {
    const token = await this.login(cfg, creds, fetchImpl);
    const names = { ...(integrationConfig.tableNames || {}) };
    const checks = [];
    for (let page = 1; page <= 50; page++) {
      const u = new URL(`${this.hostFor(cfg, creds)}/orders/v2/ordersBulk`);
      u.searchParams.set('startDate', toastDate(since));
      u.searchParams.set('endDate', toastDate(until));
      u.searchParams.set('pageSize', '100');
      u.searchParams.set('page', String(page));
      const orders = await call(u.toString(), { token, restaurantGuid: creds.restaurantGuid, fetchImpl });
      if (!Array.isArray(orders) || !orders.length) break;
      for (const o of orders) {
        if (o.voided || o.deleted) continue;
        const table = await this.tableName(cfg, creds, token, o.table?.guid, names, fetchImpl);
        for (const c of o.checks || []) {
          if (c.voided || c.deleted || !c.closedDate) continue;
          if (!['PAID', 'CLOSED'].includes(c.paymentStatus)) continue;
          const cust = c.customer;
          checks.push({
            externalId: c.guid || `${o.guid}:${c.displayNumber}`,
            openedAt: o.openedDate ? Date.parse(o.openedDate) : null,
            closedAt: Date.parse(c.closedDate),
            totalCents: cents(c.totalAmount),
            tableRef: table,
            guestCount: o.numberOfGuests ?? null,
            customer: cust
              ? { name: [cust.firstName, cust.lastName].filter(Boolean).join(' '), phone: cust.phone || null, email: cust.email || null }
              : null,
          });
        }
      }
      if (orders.length < 100) break;
    }
    return { checks, configPatch: { tableNames: names } };
  },
};
