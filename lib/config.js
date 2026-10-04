// All configuration comes from environment variables (see .env.example).
// loadConfig takes the env as an argument so tests can build isolated configs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v) => v === '1' || v === 'true' || v === 'yes';

// Reads KEY=value lines from .env without overriding real environment vars.
export function loadDotEnv(path = '.env', env = process.env) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
}

// In development a random secret is generated once and kept next to the
// database, so encrypted credentials survive restarts. Production must set
// APP_SECRET explicitly.
function resolveSecret(env, dataDir, production) {
  if (env.APP_SECRET) return env.APP_SECRET;
  if (production) throw new Error('APP_SECRET is required when NODE_ENV=production');
  const file = join(dataDir, '.app-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = int(env.PORT, 3000);
  const databasePath = env.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(env.DATABASE_PATH || 'data/freeheld.db');
  const dataDir = databasePath === ':memory:' ? resolve('data') : dirname(databasePath);
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');

  return {
    production,
    port,
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    trustProxy: bool(env.TRUST_PROXY),
    secret: resolveSecret(env, dataDir, production),
    databasePath,
    dataDir,
    brand: {
      name: env.BRAND_NAME || 'Freeheld',
      supportEmail: env.SUPPORT_EMAIL || 'info@freeheld.io',
      // AGPL section 13: everyone using the service gets a link to the exact
      // source it runs, including local changes.
      sourceUrl: env.SOURCE_URL || 'https://github.com/cameronthelyon/foodwreks',
    },
    demo: bool(env.FREEHELD_DEMO),
    workerEnabled: !bool(env.WORKER_DISABLED),
    signupsOpen: env.SIGNUPS_OPEN === undefined ? true : bool(env.SIGNUPS_OPEN),
    license: {
      trialDays: int(env.TRIAL_DAYS, 30),
      priceCents: int(env.LICENSE_PRICE_CENTS, 100000),
    },
    email: {
      provider: env.EMAIL_PROVIDER || 'console',
      from: env.EMAIL_FROM || 'Freeheld <reservations@freeheld.io>',
      postmarkToken: env.POSTMARK_TOKEN || '',
      resendKey: env.RESEND_API_KEY || '',
    },
    sms: {
      provider: env.SMS_PROVIDER || 'none',
      twilioSid: env.TWILIO_ACCOUNT_SID || '',
      twilioToken: env.TWILIO_AUTH_TOKEN || '',
      twilioFrom: env.TWILIO_FROM || '',
      twilioMessagingService: env.TWILIO_MESSAGING_SERVICE_SID || '',
    },
    square: {
      clientId: env.SQUARE_CLIENT_ID || '',
      clientSecret: env.SQUARE_CLIENT_SECRET || '',
      environment: env.SQUARE_ENV || 'sandbox',
      webhookSignatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY || '',
    },
    clover: {
      appId: env.CLOVER_APP_ID || '',
      appSecret: env.CLOVER_APP_SECRET || '',
      environment: env.CLOVER_ENV || 'sandbox',
      region: env.CLOVER_REGION || 'us',
      webhookAuthCode: env.CLOVER_WEBHOOK_AUTH_CODE || '',
    },
    toast: {
      environment: env.TOAST_ENV || 'sandbox',
    },
    platformStripe: {
      secretKey: env.PLATFORM_STRIPE_SECRET_KEY || '',
      webhookSecret: env.PLATFORM_STRIPE_WEBHOOK_SECRET || '',
      // Stripe Connect (restaurants link their own accounts with one click).
      connectClientId: env.STRIPE_CONNECT_CLIENT_ID || '',
      connectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET || '',
    },
    google: {
      bookingUser: env.GOOGLE_BOOKING_USER || '',
      bookingPassword: env.GOOGLE_BOOKING_PASSWORD || '',
      partnerId: env.GOOGLE_PARTNER_ID || '',
      serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    },
    backup: {
      dir: env.BACKUP_DIR ? resolve(env.BACKUP_DIR) : join(dataDir, 'backups'),
      intervalHours: int(env.BACKUP_INTERVAL_HOURS, 24),
      keep: int(env.BACKUP_KEEP, 14),
    },
  };
}
