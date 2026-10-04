// Connecting POS systems and Stripe, OAuth callbacks, and webhooks.

import { POS } from '../integrations/index.js';
import { verifyRestaurantKey, verifyStripeSignature, StripeError } from '../integrations/stripe.js';
import { activateLifetime } from '../license.js';
import { requireMember, sessionUser } from '../auth.js';
import { HttpError, redirect } from '../http.js';
import { parseJson } from '../db.js';
import { staff } from './helpers.js';

export function registerIntegrations(router, app) {
  const { db, config } = app;
  const providerCfg = (id) => config[id] || {};

  router.get('/api/r/:rid/integrations', staff('manager'), (ctx) => ({
    connected: app.integrations.list(ctx.restaurant.id),
    available: {
      square: { configured: POS.square.isConfigured(config.square), environment: config.square.environment },
      clover: { configured: POS.clover.isConfigured(config.clover), environment: config.clover.environment },
      toast: { configured: true, environment: config.toast.environment },
      stripe: { configured: true },
    },
  }));

  router.post('/api/r/:rid/integrations/:provider/authorize', staff('owner'), (ctx) => {
    const adapter = POS[ctx.params.provider];
    if (!adapter || adapter.auth !== 'oauth') throw new HttpError(400, 'invalid', 'That integration does not use sign-in.');
    if (!adapter.isConfigured(providerCfg(adapter.id))) {
      throw new HttpError(409, 'not_configured', `${adapter.name} is not set up on this server yet. Ask your administrator to add the app credentials.`);
    }
    const state = app.signer.sign({ rid: ctx.restaurant.id, provider: adapter.id, uid: ctx.user.id });
    return { url: adapter.authorizeUrl(providerCfg(adapter.id), { state, redirectUri: `${config.baseUrl}/oauth/${adapter.id}/callback` }) };
  });

  router.get('/oauth/:provider/callback', async (ctx) => {
    const adapter = POS[ctx.params.provider];
    const back = (msg, ok = false) =>
      redirect(ctx.res, `/app#/settings/integrations?${ok ? 'connected' : 'error'}=${encodeURIComponent(msg)}`);
    if (!adapter || adapter.auth !== 'oauth') return back('Unknown integration');
    const state = app.signer.verify(ctx.query.state);
    if (!state || state.provider !== adapter.id) return back('That sign-in link expired. Try again.');
    const user = sessionUser(app, ctx.req, ctx.res);
    if (!user || user.id !== state.uid) return back('Log in as the owner who started the connection.');
    const { restaurant } = requireMember(db, user, state.rid, 'owner');
    if (ctx.query.error) return back(String(ctx.query.error_description || ctx.query.error));
    try {
      const out = await adapter.exchangeCode(
        providerCfg(adapter.id),
        { code: ctx.query.code, merchantId: ctx.query.merchant_id, redirectUri: `${config.baseUrl}/oauth/${adapter.id}/callback` },
        app.fetch,
      );
      app.integrations.save(restaurant.id, adapter.id, out);
      app.integrations.sync(restaurant.id, adapter.id).catch((err) => app.log.warn?.(`first ${adapter.id} sync: ${err.message}`));
      return back(adapter.name, true);
    } catch (err) {
      app.log.warn?.(`${adapter.id} oauth failed: ${err.message}`);
      return back(`${adapter.name} did not accept the connection: ${err.message}`);
    }
  });

  router.post('/api/r/:rid/integrations/toast/connect', staff('owner'), async (ctx) => {
    try {
      const out = await POS.toast.connect(providerCfg('toast'), ctx.body, app.fetch);
      app.integrations.save(ctx.restaurant.id, 'toast', out);
    } catch (err) {
      throw new HttpError(400, 'toast_rejected', `Toast did not accept those credentials: ${err.message}`);
    }
    app.integrations.sync(ctx.restaurant.id, 'toast').catch((err) => app.log.warn?.(`first toast sync: ${err.message}`));
    return { ok: true };
  });

  router.post('/api/r/:rid/integrations/stripe/connect', staff('owner'), async (ctx) => {
    const key = String(ctx.body.secretKey ?? '').trim();
    try {
      const { mode } = await verifyRestaurantKey(key, app.fetch);
      app.integrations.save(ctx.restaurant.id, 'stripe', { credentials: { secretKey: key }, config: { mode } });
      return { ok: true, mode };
    } catch (err) {
      if (err instanceof StripeError) throw new HttpError(400, 'stripe_rejected', `Stripe did not accept that key: ${err.message}`);
      throw err;
    }
  });

  router.patch('/api/r/:rid/integrations/:provider', staff('owner'), (ctx) => {
    const patch = {};
    if (ctx.params.provider === 'square' && ctx.body.locationId !== undefined) {
      const current = app.integrations.get(ctx.restaurant.id, 'square');
      if (!current?.config.locations?.some((l) => l.id === ctx.body.locationId)) throw new HttpError(400, 'invalid', 'Unknown location.');
      patch.locationId = ctx.body.locationId;
    }
    return app.integrations.updateConfig(ctx.restaurant.id, ctx.params.provider, patch);
  });

  router.post('/api/r/:rid/integrations/:provider/sync', staff('manager'), async (ctx) => {
    if (!POS[ctx.params.provider]) throw new HttpError(400, 'invalid', 'Only POS integrations sync.');
    try {
      return await app.integrations.sync(ctx.restaurant.id, ctx.params.provider);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'sync_failed', err.message);
    }
  });

  router.delete('/api/r/:rid/integrations/:provider', staff('owner'), (ctx) => {
    app.integrations.remove(ctx.restaurant.id, ctx.params.provider);
    return { ok: true };
  });

  // ---- Webhooks --------------------------------------------------------------------

  router.post('/webhooks/square', (ctx) => {
    const raw = ctx.rawBody.toString('utf8');
    if (!POS.square.verifyWebhook(config.square, { headers: ctx.req.headers, rawBody: raw, url: `${config.baseUrl}/webhooks/square` })) {
      throw new HttpError(401, 'bad_signature', 'Invalid signature.');
    }
    app.integrations.syncSoon('square', POS.square.webhookMerchants(parseJson(raw, {})));
    return { ok: true };
  });

  router.post('/webhooks/clover', (ctx) => {
    const body = parseJson(ctx.rawBody.toString('utf8'), {});
    // One-time URL verification: Clover posts a code to paste into its dashboard.
    if (body.verificationCode) {
      app.log.info?.(`Clover webhook verification code: ${body.verificationCode}`);
      return { ok: true };
    }
    if (!POS.clover.verifyWebhook(config.clover, { headers: ctx.req.headers })) throw new HttpError(401, 'bad_signature', 'Invalid auth code.');
    app.integrations.syncSoon('clover', POS.clover.webhookMerchants(body));
    return { ok: true };
  });

  // Platform license payments.
  router.post('/webhooks/stripe', (ctx) => {
    const raw = ctx.rawBody.toString('utf8');
    if (!verifyStripeSignature(raw, ctx.req.headers['stripe-signature'], config.platformStripe.webhookSecret, 300, app.now())) {
      throw new HttpError(400, 'bad_signature', 'Invalid signature.');
    }
    const event = parseJson(raw, {});
    const session = event.data?.object;
    if (event.type === 'checkout.session.completed' && session?.metadata?.kind === 'lifetime_license' && session.payment_status === 'paid') {
      const rid = Number(session.metadata.restaurant_id);
      if (db.one('SELECT 1 FROM restaurants WHERE id = ?', rid)) {
        activateLifetime(db, rid, session.id, app.now());
        db.run(
          'INSERT INTO audit_log (restaurant_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          rid,
          'license.activated',
          'restaurant',
          rid,
          JSON.stringify({ session: session.id, amount: session.amount_total }),
          app.now(),
        );
        app.events.publish(rid, { type: 'config' });
      }
    }
    return { received: true };
  });
}
