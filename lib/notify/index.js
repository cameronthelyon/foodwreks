// Outbox: messages are written to the database inside the same transaction
// as the change that caused them, then delivered by the worker with retries.
// A crash can delay a confirmation; it can never lose one.

import { restaurantSettings } from '../restaurants.js';
import { manageToken, manageUrl } from '../reservations.js';
import { accountTemplate, reservationTemplate, staffAlertTemplate, waitlistTemplate } from './templates.js';

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
const MAX_ATTEMPTS = 5;

export function createNotifier(app, { email, sms }) {
  const { db } = app;

  function insert({ restaurantId = null, reservationId = null, kind, channel, recipient, subject = '', text, html = null, sendAfter }) {
    const now = app.now();
    db.run(
      `INSERT INTO outbox (restaurant_id, reservation_id, kind, channel, recipient, subject, body_text, body_html,
         send_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      restaurantId,
      reservationId,
      kind,
      channel,
      recipient,
      subject,
      text,
      html,
      sendAfter ?? now,
      now,
    );
  }

  function links(restaurant, row) {
    const base = app.config.baseUrl;
    return {
      manage: manageUrl(app, row),
      calendar: `${base}/m/${row.code}/calendar.ics?t=${manageToken(app, row)}`,
      book: `${base}/r/${restaurant.slug}`,
      app: `${base}/app#/book/${row.date}`,
    };
  }

  return {
    email,
    sms,

    queueReservation(restaurant, row, kind, extra = {}) {
      const settings = restaurantSettings(restaurant);
      const msg = reservationTemplate(kind, { restaurant, row, settings, links: links(restaurant, row), brand: app.config.brand.name, extra });
      if (email && settings.emailEnabled && row.guest_email) {
        insert({ restaurantId: restaurant.id, reservationId: row.id, kind, channel: 'email', recipient: row.guest_email, subject: msg.subject, text: msg.text, html: msg.html });
      }
      if (sms && settings.smsEnabled && row.guest_phone) {
        insert({ restaurantId: restaurant.id, reservationId: row.id, kind, channel: 'sms', recipient: row.guest_phone, text: msg.sms });
      }
    },

    queueStaffAlert(restaurant, row) {
      const settings = restaurantSettings(restaurant);
      if (!email || !settings.staffAlertEmail) return;
      const msg = staffAlertTemplate({ restaurant, row, links: links(restaurant, row), brand: app.config.brand.name });
      insert({ restaurantId: restaurant.id, reservationId: row.id, kind: 'staff_alert', channel: 'email', recipient: settings.staffAlertEmail, subject: msg.subject, text: msg.text, html: msg.html });
    },

    // Waitlist texts go out even when the restaurant has reservation SMS off:
    // "your table is ready" is the whole point of a waitlist.
    queueWaitlist(restaurant, entry, kind, extra = {}) {
      if (!sms || !entry.phone) return false;
      const msg = waitlistTemplate(kind, { restaurant, entry, links: extra.links || {} });
      insert({ restaurantId: restaurant.id, kind, channel: 'sms', recipient: entry.phone, text: msg.sms });
      return true;
    },

    queueAccountEmail(to, kind, data) {
      if (!email) return;
      const msg = accountTemplate(kind, { brand: app.config.brand.name, ...data });
      insert({ kind, channel: 'email', recipient: to, subject: msg.subject, text: msg.text, html: msg.html });
    },

    // Sends due messages. Each row is claimed by bumping attempts and pushing
    // send_after forward, so overlapping runs cannot double-send.
    async processOutbox(limit = 25) {
      const now = app.now();
      const due = db.all(
        "SELECT * FROM outbox WHERE status = 'pending' AND send_after <= ? ORDER BY send_after, id LIMIT ?",
        now,
        limit,
      );
      let sent = 0;
      for (const m of due) {
        const claim = db.run(
          "UPDATE outbox SET attempts = attempts + 1, send_after = ? WHERE id = ? AND status = 'pending' AND attempts = ?",
          now + 10 * 60_000,
          m.id,
          m.attempts,
        );
        if (!claim.changes) continue;
        const provider = m.channel === 'email' ? email : sms;
        if (!provider) {
          db.run("UPDATE outbox SET status = 'skipped', error = 'no provider configured' WHERE id = ?", m.id);
          continue;
        }
        try {
          const result =
            m.channel === 'email'
              ? await provider.send({ to: m.recipient, subject: m.subject, text: m.body_text, html: m.body_html, tag: m.kind })
              : await provider.send({ to: m.recipient, body: m.body_text });
          db.run("UPDATE outbox SET status = 'sent', sent_at = ?, provider_ref = ?, error = NULL WHERE id = ?", app.now(), result?.id ?? null, m.id);
          sent++;
        } catch (err) {
          const attempts = m.attempts + 1;
          if (err.permanent || attempts >= MAX_ATTEMPTS) {
            db.run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", String(err.message).slice(0, 500), m.id);
          } else {
            db.run(
              'UPDATE outbox SET send_after = ?, error = ? WHERE id = ?',
              app.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)],
              String(err.message).slice(0, 500),
              m.id,
            );
          }
          app.log.warn?.(`outbox ${m.id} (${m.channel} ${m.kind}) failed: ${err.message}`);
        }
      }
      return sent;
    },

    // Queues reminders that are due. A booking made inside the reminder window
    // (Tuesday 3 PM for Tuesday 7 PM) gets no reminder: the confirmation was it.
    queueReminders() {
      const now = app.now();
      const rows = db.all(
        `SELECT r.*, x.settings AS r_settings FROM reservations r JOIN restaurants x ON x.id = r.restaurant_id
          WHERE r.status IN ('booked', 'confirmed') AND r.reminder_sent_at IS NULL
            AND r.starts_at > ? AND r.starts_at <= ?`,
        now,
        now + 7 * 86400_000,
      );
      let queued = 0;
      for (const r of rows) {
        const restaurant = db.one('SELECT * FROM restaurants WHERE id = ?', r.restaurant_id);
        const hours = restaurantSettings(restaurant).remindHoursBefore;
        const window = hours * 3600_000;
        if (!hours) continue;
        if (r.starts_at - now > window) continue;
        db.tx(() => {
          const fresh = db.one('SELECT * FROM reservations WHERE id = ? AND reminder_sent_at IS NULL', r.id);
          if (!fresh) return;
          if (fresh.starts_at - fresh.created_at <= window + 3600_000) {
            db.run('UPDATE reservations SET reminder_sent_at = 0 WHERE id = ?', fresh.id);
            return;
          }
          this.queueReservation(restaurant, fresh, 'reminder');
          db.run('UPDATE reservations SET reminder_sent_at = ? WHERE id = ?', now, fresh.id);
          queued++;
        });
      }
      return queued;
    },
  };
}
