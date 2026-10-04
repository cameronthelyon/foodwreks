// Integration registry: stores encrypted credentials, refreshes tokens,
// syncs POS checks on a schedule or on webhook, and exposes the restaurant's
// own Stripe key for card holds.

import { square } from './square.js';
import { clover } from './clover.js';
import { toast } from './toast.js';
import { matchChecks } from './matching.js';
import { parseJson } from '../db.js';
import { HttpError } from '../http.js';

export const POS = { square, clover, toast };
const OVERLAP_MS = 15 * 60_000;
const FIRST_SYNC_MS = 2 * 86400_000;

export function createIntegrations(app, fetchImpl = globalThis.fetch) {
  const { db, vault } = app;
  const inFlight = new Map();
  const providerConfig = (id) => app.config[id] || {};

  function load(row) {
    if (!row) return null;
    return { ...row, credentials: vault.decrypt(row.credentials), config: parseJson(row.config, {}) };
  }

  const api = {
    POS,

    get(restaurantId, provider) {
      return load(db.one('SELECT * FROM integrations WHERE restaurant_id = ? AND provider = ?', restaurantId, provider));
    },

    list(restaurantId) {
      return db
        .all('SELECT provider, status, config, external_id, last_sync_at, last_error, created_at FROM integrations WHERE restaurant_id = ?', restaurantId)
        .map((r) => {
          const config = parseJson(r.config, {});
          delete config.tableNames;
          return { provider: r.provider, status: r.status, config, externalId: r.external_id, lastSyncAt: r.last_sync_at, lastError: r.last_error, connectedAt: r.created_at };
        });
    },

    save(restaurantId, provider, { credentials, config = {}, externalId = null }) {
      const now = app.now();
      db.run(
        `INSERT INTO integrations (restaurant_id, provider, status, credentials, config, external_id, created_at, updated_at)
         VALUES (?, ?, 'connected', ?, ?, ?, ?, ?)
         ON CONFLICT (restaurant_id, provider) DO UPDATE SET status = 'connected', credentials = excluded.credentials,
           config = excluded.config, external_id = excluded.external_id, last_error = NULL, cursor = NULL,
           updated_at = excluded.updated_at`,
        restaurantId,
        provider,
        vault.encrypt(credentials),
        JSON.stringify(config),
        externalId,
        now,
        now,
      );
      return api.get(restaurantId, provider);
    },

    updateConfig(restaurantId, provider, patch) {
      const row = api.get(restaurantId, provider);
      if (!row) throw new HttpError(404, 'not_found', 'Not connected.');
      const config = { ...row.config, ...patch };
      db.run('UPDATE integrations SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify(config), app.now(), row.id);
      return config;
    },

    remove(restaurantId, provider) {
      db.run('DELETE FROM integrations WHERE restaurant_id = ? AND provider = ?', restaurantId, provider);
    },

    // What card holds authenticate with: the restaurant's own key, or our
    // platform key acting on their connected account. Null if neither works.
    stripeKey(restaurantId) {
      const row = db.one("SELECT credentials FROM integrations WHERE restaurant_id = ? AND provider = 'stripe' AND status = 'connected'", restaurantId);
      if (!row) return null;
      const creds = vault.decrypt(row.credentials);
      if (creds.accountId) {
        const key = app.config.platformStripe.secretKey;
        return key ? { key, account: creds.accountId } : null;
      }
      return creds.secretKey || null;
    },

    // One POS sync: refresh credentials, pull checks since the cursor (with
    // overlap so late-closing checks are not missed), match, advance cursor.
    async sync(restaurantId, provider) {
      const key = `${restaurantId}:${provider}`;
      if (inFlight.has(key)) return inFlight.get(key);
      const run = (async () => {
        const row = api.get(restaurantId, provider);
        const adapter = POS[provider];
        if (!row || !adapter) throw new HttpError(404, 'not_found', 'Not connected.');
        const cfg = providerConfig(provider);
        const restaurant = db.one('SELECT * FROM restaurants WHERE id = ?', restaurantId);
        const now = app.now();
        try {
          let creds = row.credentials;
          const fresh = await adapter.ensureFresh(cfg, creds, fetchImpl, now);
          if (fresh) {
            creds = { ...creds, ...fresh };
            db.run('UPDATE integrations SET credentials = ? WHERE id = ?', vault.encrypt(creds), row.id);
          }
          const since = Math.max(Number(row.cursor || 0) - OVERLAP_MS, now - FIRST_SYNC_MS);
          const out = await adapter.fetchChecks(cfg, creds, row.config, { since, until: now }, fetchImpl);
          const checks = Array.isArray(out) ? out : out.checks;
          if (!Array.isArray(out) && out.configPatch) api.updateConfig(restaurantId, provider, out.configPatch);
          const result = matchChecks(app, restaurant, provider, checks);
          db.run(
            "UPDATE integrations SET cursor = ?, last_sync_at = ?, last_error = NULL, status = 'connected' WHERE id = ?",
            String(now),
            now,
            row.id,
          );
          return result;
        } catch (err) {
          db.run("UPDATE integrations SET last_error = ?, last_sync_at = ?, status = 'error' WHERE id = ?", String(err.message).slice(0, 500), now, row.id);
          throw err;
        }
      })();
      inFlight.set(key, run);
      try {
        return await run;
      } finally {
        inFlight.delete(key);
      }
    },

    async syncAll() {
      const rows = db.all(`SELECT restaurant_id, provider FROM integrations WHERE provider IN ('square', 'clover', 'toast') AND status != 'disconnected'`);
      const results = [];
      for (const r of rows) {
        try {
          results.push({ ...r, ...(await api.sync(r.restaurant_id, r.provider)) });
        } catch (err) {
          app.log.warn?.(`sync ${r.provider} for restaurant ${r.restaurant_id} failed: ${err.message}`);
          results.push({ ...r, error: err.message });
        }
      }
      return results;
    },

    // Webhooks just trigger a debounced sync for every restaurant tied to the
    // merchant ids in the payload.
    syncSoon(provider, externalIds) {
      for (const ext of externalIds) {
        for (const r of db.all('SELECT restaurant_id FROM integrations WHERE provider = ? AND external_id = ?', provider, ext)) {
          const key = `debounce:${r.restaurant_id}:${provider}`;
          if (inFlight.has(key)) continue;
          const t = setTimeout(() => {
            inFlight.delete(key);
            api.sync(r.restaurant_id, provider).catch((err) => app.log.warn?.(`webhook sync failed: ${err.message}`));
          }, 20_000);
          t.unref?.();
          inFlight.set(key, t);
        }
      }
    },

    stop() {
      for (const [k, v] of inFlight) if (k.startsWith('debounce:')) clearTimeout(v);
    },
  };
  return api;
}
