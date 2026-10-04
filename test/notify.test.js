// Outbox delivery, providers, reminders, and the housekeeping jobs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonResponse, signup, startTestApp } from './helpers.js';
import { makeEmailProvider, makeSmsProvider } from '../lib/notify/providers.js';
import { reservationTemplate, shortWhen } from '../lib/notify/templates.js';
import { sanitizeSettings } from '../lib/restaurants.js';
import { backup, closeoutStale } from '../lib/worker.js';

const book = (c, rid, over = {}) =>
  c.post(`/api/r/${rid}/reservations`, { date: '2026-10-12', time: 1140, partySize: 2, name: 'Ada Lovelace', email: 'ada@example.com', phone: '4155550100', ...over });

test('postmark, resend and twilio payloads', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('postmark')) return jsonResponse({ MessageID: 'pm-1', ErrorCode: 0 });
    if (url.includes('resend')) return jsonResponse({ id: 're-1' });
    return jsonResponse({ sid: 'SM1' }, 201);
  };
  const pm = makeEmailProvider({ provider: 'postmark', postmarkToken: 'tok', from: 'A <a@x.org>' }, fetchImpl);
  assert.deepEqual(await pm.send({ to: 'b@x.org', subject: 'S', text: 'T', html: '<p>T</p>' }), { id: 'pm-1' });
  assert.equal(calls[0].init.headers['X-Postmark-Server-Token'], 'tok');
  assert.equal(JSON.parse(calls[0].init.body).MessageStream, 'outbound');

  const re = makeEmailProvider({ provider: 'resend', resendKey: 'rk', from: 'A <a@x.org>' }, fetchImpl);
  await re.send({ to: 'b@x.org', subject: 'S', text: 'T' });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer rk');
  assert.deepEqual(JSON.parse(calls[1].init.body).to, ['b@x.org']);

  const tw = makeSmsProvider({ provider: 'twilio', twilioSid: 'AC1', twilioToken: 'secret', twilioMessagingService: 'MG1' }, fetchImpl);
  await tw.send({ to: '+14155550100', body: 'Hi' });
  assert.equal(calls[2].url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  const form = new URLSearchParams(calls[2].init.body);
  assert.equal(form.get('MessagingServiceSid'), 'MG1');
  assert.equal(form.get('To'), '+14155550100');
  assert.equal(calls[2].init.headers.Authorization, `Basic ${Buffer.from('AC1:secret').toString('base64')}`);

  assert.throws(() => makeEmailProvider({ provider: 'postmark' }), /POSTMARK_TOKEN/);
  assert.equal(makeSmsProvider({ provider: 'none' }), null);
});

test('templates escape restaurant and guest input', () => {
  const restaurant = { name: 'Bob <script>', address: '1 A St', phone: '555' };
  const row = { guest_name: 'Eve "x"', party_size: 2, date: '2026-10-12', start_min: 1140, occasion: '<b>', guest_notes: '', code: 'ABC' };
  const msg = reservationTemplate('confirmation', { restaurant, row, settings: sanitizeSettings({}), links: { manage: 'https://h/m/ABC?t=1' }, brand: 'Freeheld' });
  assert.ok(!msg.html.includes('<script>'));
  assert.ok(msg.html.includes('Bob &lt;script&gt;'));
  assert.ok(msg.sms.includes('Reply STOP'));
  assert.equal(shortWhen('2026-10-12', 1140), 'Mon Oct 12, 7:00 PM');
});

test('outbox: sends, retries with backoff, gives up on permanent errors', async () => {
  let mode = 'fail';
  const t = await startTestApp({
    env: { EMAIL_PROVIDER: 'postmark', POSTMARK_TOKEN: 'tok', SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'x', TWILIO_FROM: '+15005550006' },
  });
  t.routes.push(
    {
      match: (u) => u.includes('postmarkapp'),
      reply: () => (mode === 'fail' ? jsonResponse({ ErrorCode: 500, Message: 'down' }, 503) : jsonResponse({ MessageID: 'ok', ErrorCode: 0 })),
    },
    { match: (u) => u.includes('twilio'), reply: () => jsonResponse({ code: 21610, message: 'unsubscribed' }, 400) },
  );
  try {
    const { c, rid } = await signup(t);
    await c.patch(`/api/r/${rid}/settings`, { smsEnabled: true });
    t.app.db.run('DELETE FROM outbox');
    await book(c, rid);
    const rows = () => t.app.db.all("SELECT channel, status, attempts, send_after, error FROM outbox WHERE kind = 'confirmation' ORDER BY channel");
    assert.equal(rows().length, 2);

    await t.app.notify.processOutbox();
    let [email, sms] = rows();
    assert.equal(email.status, 'pending');
    assert.equal(email.attempts, 1);
    assert.equal(email.send_after, t.clock.t + 60_000);
    assert.equal(sms.status, 'failed', 'STOP replies are permanent');

    await t.app.notify.processOutbox();
    assert.equal(rows()[0].attempts, 1, 'not due yet');
    mode = 'ok';
    t.clock.t += 61_000;
    await t.app.notify.processOutbox();
    [email] = rows();
    assert.equal(email.status, 'sent');
  } finally {
    await t.close();
  }
});

test('reminders: due ones are queued once; same-day bookings are skipped', async () => {
  const t = await startTestApp();
  try {
    const { c, rid } = await signup(t);
    await book(c, rid); // Mon 7 PM, booked Fri noon
    await book(c, rid, { date: '2026-10-09', time: 1140, email: 'tonight@example.com', phone: '4155550101' });
    t.app.db.run('DELETE FROM outbox');

    assert.equal(t.app.notify.queueReminders(), 0, 'Monday is more than 24h away');
    // The same-day booking was made inside the window: marked done, not sent.
    assert.equal(t.app.db.one("SELECT reminder_sent_at FROM reservations WHERE guest_email = 'tonight@example.com'").reminder_sent_at, 0);

    t.clock.t = Date.parse('2026-10-12T03:00:00Z'); // Sun 8 PM PDT, 23h before
    assert.equal(t.app.notify.queueReminders(), 1);
    assert.equal(t.app.notify.queueReminders(), 0, 'only once');
    const mail = t.app.db.one("SELECT * FROM outbox WHERE kind = 'reminder'");
    assert.equal(mail.recipient, 'ada@example.com');
    assert.match(mail.body_text, /\/m\/[2-9A-Z]{8}\?t=/, 'manage link rebuilt days later');
  } finally {
    await t.close();
  }
});

test('stale seated parties are closed out; backups rotate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fh-'));
  const t = await startTestApp({ env: { DATABASE_PATH: join(dir, 'db.sqlite'), BACKUP_DIR: join(dir, 'b'), BACKUP_KEEP: '2' } });
  try {
    const { c, rid } = await signup(t);
    const r = await book(c, rid, { date: '2026-10-09', time: 1080, status: 'seated' });
    assert.equal(closeoutStale(t.app), 0);
    t.clock.t = Date.parse('2026-10-10T08:00:00Z'); // 1 AM Saturday
    assert.equal(closeoutStale(t.app), 1);
    const row = t.app.db.one('SELECT status, completed_at, starts_at, duration_min FROM reservations WHERE id = ?', r.data.reservation.id);
    assert.equal(row.status, 'completed');
    assert.equal(row.completed_at, row.starts_at + row.duration_min * 60_000);

    for (let i = 0; i < 3; i++) {
      t.clock.t += 3600_000;
      assert.ok(existsSync(backup(t.app)));
    }
    assert.equal(readdirSync(join(dir, 'b')).length, 2);
  } finally {
    await t.close();
  }
});

test('guests see the restaurant as the sender, and their replies reach the restaurant', async () => {
  const t = await startTestApp({ env: { EMAIL_PROVIDER: 'postmark', POSTMARK_TOKEN: 'tok', EMAIL_FROM: 'Freeheld <reservations@freeheld.io>', SUPPORT_EMAIL: 'info@freeheld.io' } });
  t.routes.push({ match: (u) => u.includes('postmarkapp'), reply: () => jsonResponse({ MessageID: 'ok', ErrorCode: 0 }) });
  try {
    const { c, rid, email } = await signup(t, { restaurantName: 'Juniper & Rye' });
    await c.patch(`/api/r/${rid}/settings`, { staffAlertEmail: 'manager@juniper.test' });
    t.app.db.run('DELETE FROM outbox');
    t.outbound.length = 0;
    await c.post(`/api/public/r/${(await c.get(`/api/r/${rid}`)).data.slug}/reservations`, {
      date: '2026-10-16', time: 1140, partySize: 2, firstName: 'Ada', phone: '4155550111', email: 'ada@guest.test', policyAccepted: true,
    });
    await c.post('/api/auth/forgot', { email });
    await t.app.notify.processOutbox();
    const sent = t.outbound.filter((o) => o.url.includes('postmarkapp')).map((o) => JSON.parse(o.body));
    const guest = sent.find((m) => m.To === 'ada@guest.test');
    assert.equal(guest.From, '"Juniper & Rye via Freeheld" <reservations@freeheld.io>');
    assert.equal(guest.ReplyTo, email, 'replies go to the restaurant (its email defaults to the owner\'s)');
    const alert = sent.find((m) => m.To === 'manager@juniper.test');
    assert.equal(alert.ReplyTo, 'ada@guest.test', 'staff can answer the guest directly');
    const reset = sent.find((m) => m.To === email);
    assert.equal(reset.From, 'Freeheld <reservations@freeheld.io>');
    assert.equal(reset.ReplyTo, 'info@freeheld.io');
  } finally {
    await t.close();
  }
});
