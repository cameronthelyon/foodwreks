// Background jobs, in-process. Each job is idempotent and safe to run late
// or twice, so a restart never needs special handling.

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { refreshGuestStats } from './guests.js';
import { setStatus } from './reservations.js';

// Card-hold bookings the diner never finished release their table.
export function expirePendingHolds(app, maxAgeMs = 20 * 60_000) {
  const rows = app.db.all("SELECT id, restaurant_id FROM reservations WHERE status = 'pending' AND created_at < ?", app.now() - maxAgeMs);
  for (const r of rows) {
    const restaurant = app.db.one('SELECT * FROM restaurants WHERE id = ?', r.restaurant_id);
    try {
      setStatus(app, restaurant, r.id, 'cancelled', { by: 'system', reason: 'card hold not completed', notify: false });
    } catch (err) {
      app.log.warn?.(`expire hold ${r.id}: ${err.message}`);
    }
  }
  return rows.length;
}

// Parties marked arrived/seated that nobody closed out are completed a few
// hours after their planned end, so tables and guest stats stay true.
export function closeoutStale(app, graceMs = 4 * 3600_000) {
  const rows = app.db.all(
    `SELECT id, restaurant_id, guest_id, date, starts_at, duration_min FROM reservations
      WHERE status IN ('arrived', 'seated') AND starts_at + duration_min * 60000 + ? < ?`,
    graceMs,
    app.now(),
  );
  for (const r of rows) {
    app.db.run("UPDATE reservations SET status = 'completed', completed_at = ? WHERE id = ?", r.starts_at + r.duration_min * 60_000, r.id);
    refreshGuestStats(app.db, r.guest_id, app.now());
    app.events.publish(r.restaurant_id, { type: 'reservations', date: r.date });
  }
  return rows.length;
}

export function cleanup(app) {
  const now = app.now();
  app.db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  app.db.run('DELETE FROM password_resets WHERE expires_at < ?', now - 86400_000);
  app.db.run('DELETE FROM idempotency WHERE created_at < ?', now - 30 * 86400_000);
  app.db.run("DELETE FROM outbox WHERE status IN ('sent', 'skipped') AND created_at < ?", now - 90 * 86400_000);
}

export function backup(app) {
  const { dir, keep } = app.config.backup;
  if (app.db.path === ':memory:') return null;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(app.now()).toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const file = join(dir, `freehold-${stamp}.db`);
  app.db.backupTo(file);
  const old = readdirSync(dir)
    .filter((f) => /^freehold-\d{8}T\d{6}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) rmSync(join(dir, f));
  return file;
}

export function startWorker(app) {
  const timers = [];
  const every = (ms, name, fn) => {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (err) {
        app.log.error?.(`job ${name} failed:`, err);
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(run, ms));
    return run;
  };
  every(5_000, 'outbox', () => app.notify.processOutbox());
  every(60_000, 'reminders', () => app.notify.queueReminders());
  every(60_000, 'holds', () => expirePendingHolds(app));
  every(15 * 60_000, 'closeout', () => closeoutStale(app));
  every(5 * 60_000, 'pos-sync', () => app.integrations.syncAll());
  every(3600_000, 'cleanup', () => cleanup(app));
  if (app.config.backup.intervalHours > 0) {
    const runBackup = every(app.config.backup.intervalHours * 3600_000, 'backup', () => {
      const file = backup(app);
      if (file) app.log.info?.(`backup written: ${file}`);
    });
    setTimeout(runBackup, 60_000).unref();
  }
  for (const t of timers) t.unref();
  return {
    stop() {
      for (const t of timers) clearInterval(t);
    },
  };
}
