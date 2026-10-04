// SQLite via Node's built-in node:sqlite. One file, one process, no server.
// A single box comfortably serves thousands of restaurants: reservations are
// a low-write workload (a busy room books a few hundred times a day).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE restaurants (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'US',
    latitude REAL,
    longitude REAL,
    cuisine TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    online_booking INTEGER NOT NULL DEFAULT 1,
    license_status TEXT NOT NULL DEFAULT 'trial'
      CHECK (license_status IN ('trial', 'lifetime', 'comped', 'suspended')),
    trial_ends_at INTEGER,
    license_paid_at INTEGER,
    license_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_platform_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE memberships (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'host')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, restaurant_id)
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE tables (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    min_covers INTEGER NOT NULL DEFAULT 1,
    max_covers INTEGER NOT NULL,
    online INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    pos_ref TEXT NOT NULL DEFAULT '',
    UNIQUE (restaurant_id, name)
  );

  CREATE TABLE table_combos (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    table_ids TEXT NOT NULL,
    min_covers INTEGER NOT NULL,
    max_covers INTEGER NOT NULL,
    online INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE shifts (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    days TEXT NOT NULL,
    start_min INTEGER NOT NULL,
    last_seating_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    interval_min INTEGER NOT NULL DEFAULT 15,
    max_covers_per_slot INTEGER,
    max_parties_per_slot INTEGER,
    online INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    starts_on TEXT,
    ends_on TEXT
  );

  CREATE TABLE closures (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    closed INTEGER NOT NULL DEFAULT 1,
    start_min INTEGER,
    last_seating_min INTEGER,
    end_min INTEGER,
    note TEXT NOT NULL DEFAULT '',
    UNIQUE (restaurant_id, date)
  );

  CREATE TABLE guests (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    phone TEXT,
    email TEXT COLLATE NOCASE,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    marketing_opt_in INTEGER NOT NULL DEFAULT 0,
    visit_count INTEGER NOT NULL DEFAULT 0,
    no_show_count INTEGER NOT NULL DEFAULT 0,
    cancel_count INTEGER NOT NULL DEFAULT 0,
    total_spend_cents INTEGER NOT NULL DEFAULT 0,
    imported_visits INTEGER NOT NULL DEFAULT 0,
    last_visit_date TEXT,
    pos_customer_ref TEXT,
    stripe_customer_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX guests_phone ON guests(restaurant_id, phone);
  CREATE INDEX guests_email ON guests(restaurant_id, email);
  CREATE INDEX guests_name ON guests(restaurant_id, last_name, first_name);

  CREATE TABLE reservations (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    code TEXT NOT NULL UNIQUE,
    date TEXT NOT NULL,
    start_min INTEGER NOT NULL,
    duration_min INTEGER NOT NULL,
    starts_at INTEGER NOT NULL,
    party_size INTEGER NOT NULL CHECK (party_size > 0),
    status TEXT NOT NULL CHECK (status IN
      ('pending', 'booked', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show')),
    source TEXT NOT NULL DEFAULT 'online',
    table_ids TEXT NOT NULL DEFAULT '[]',
    table_locked INTEGER NOT NULL DEFAULT 0,
    guest_name TEXT NOT NULL,
    guest_phone TEXT,
    guest_email TEXT,
    guest_notes TEXT NOT NULL DEFAULT '',
    occasion TEXT NOT NULL DEFAULT '',
    staff_notes TEXT NOT NULL DEFAULT '',
    manage_salt TEXT NOT NULL DEFAULT '',
    card_status TEXT,
    card_ref TEXT,
    card_session_ref TEXT,
    no_show_fee_cents INTEGER,
    charged_cents INTEGER,
    spend_cents INTEGER,
    pos_check_ref TEXT,
    external_ref TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    arrived_at INTEGER,
    seated_at INTEGER,
    completed_at INTEGER,
    cancelled_at INTEGER,
    cancelled_by TEXT,
    reminder_sent_at INTEGER
  );
  CREATE INDEX reservations_day ON reservations(restaurant_id, date);
  CREATE INDEX reservations_guest ON reservations(guest_id);
  CREATE INDEX reservations_starts ON reservations(status, starts_at);
  CREATE INDEX reservations_external ON reservations(restaurant_id, external_ref);

  CREATE TABLE waitlist (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    party_size INTEGER NOT NULL CHECK (party_size > 0),
    quoted_min INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'waiting'
      CHECK (status IN ('waiting', 'notified', 'seated', 'left', 'cancelled')),
    source TEXT NOT NULL DEFAULT 'staff',
    notes TEXT NOT NULL DEFAULT '',
    status_token_hash TEXT,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    notified_at INTEGER,
    seated_at INTEGER,
    removed_at INTEGER
  );
  CREATE INDEX waitlist_day ON waitlist(restaurant_id, date, status);

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL,
    body_html TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    send_after INTEGER NOT NULL,
    sent_at INTEGER,
    provider_ref TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX outbox_pending ON outbox(status, send_after);

  CREATE TABLE integrations (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
    credentials TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    external_id TEXT,
    cursor TEXT,
    last_sync_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (restaurant_id, provider)
  );
  CREATE INDEX integrations_external ON integrations(provider, external_id);

  CREATE TABLE pos_checks (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    opened_at INTEGER,
    closed_at INTEGER,
    total_cents INTEGER NOT NULL DEFAULT 0,
    table_ref TEXT,
    guest_count INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
    match_method TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (restaurant_id, provider, external_id)
  );
  CREATE INDEX pos_checks_reservation ON pos_checks(reservation_id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_restaurant ON audit_log(restaurant_id, created_at);

  CREATE TABLE idempotency (
    key TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

// node:sqlite rejects booleans and undefined; normalize at the boundary.
function bindable(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function bindArgs(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const out = {};
    for (const [k, v] of Object.entries(params[0])) out[k] = bindable(v);
    return [out];
  }
  return params.map(bindable);
}

export class Db {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
    this.statements = new Map();
    this.depth = 0;
    this.migrate();
  }

  migrate() {
    const { user_version: current } = this.raw.prepare('PRAGMA user_version').get();
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  stmt(sql) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  one(sql, ...params) {
    return this.stmt(sql).get(...bindArgs(params)) ?? null;
  }

  all(sql, ...params) {
    return this.stmt(sql).all(...bindArgs(params));
  }

  run(sql, ...params) {
    const r = this.stmt(sql).run(...bindArgs(params));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  // Synchronous transaction. Nested calls join the outer transaction. The
  // callback must not await: node:sqlite is synchronous, so a check-then-write
  // inside one tx() is atomic for the whole process.
  tx(fn) {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      if (out && typeof out.then === 'function') throw new Error('db.tx callback must be synchronous');
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  // Consistent online snapshot for backups.
  backupTo(file) {
    this.raw.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  }

  close() {
    this.raw.close();
  }
}

export function openDb(path) {
  return new Db(path);
}

export function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
