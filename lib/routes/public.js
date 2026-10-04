// Diner-facing routes: booking page data, availability, booking, manage
// links, calendar files, card holds, and the online waitlist. The booking
// rules themselves live in lib/public-booking.js.

import { publicProfile, restaurantSettings } from '../restaurants.js';
import { cancelByGuest, manageToken, manageUrl, modifyByGuest, setStatus } from '../reservations.js';
import { addToWaitlist, publicWaitlistStatus, removeFromWaitlist, verifyWaitlistToken, waitlistToken } from '../waitlist.js';
import { canTakeOnlineBookings } from '../license.js';
import { completedCardHold } from '../integrations/stripe.js';
import { localDate, zonedToUtc } from '../time.js';
import { HttpError, redirect, sendText } from '../http.js';
import { bookOnline, byCode, bySlug, manageInfo, publicAvailability, startCardHold } from '../public-booking.js';
import { int, rateLimit } from './helpers.js';

// RFC 5545 text escaping and 75-octet line folding.
function icsText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}
const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function registerPublic(router, app) {
  router.get('/api/config', () => ({
    brand: app.config.brand.name,
    supportEmail: app.config.brand.supportEmail,
    licensePriceCents: app.config.license.priceCents,
    trialDays: app.config.license.trialDays,
    signupsOpen: app.config.signupsOpen,
    smsAvailable: Boolean(app.notify.sms),
  }));

  router.get('/api/public/r/:slug', (ctx) => {
    const r = bySlug(app, ctx.params.slug);
    const settings = restaurantSettings(r);
    return {
      restaurant: publicProfile(r),
      onlineBooking: canTakeOnlineBookings(r, app.now()),
      today: localDate(app.now(), r.timezone),
      cardHolds: settings.cardRequiredMinParty > 0 && Boolean(app.integrations.stripeKey(r.id)),
    };
  });

  router.get('/api/public/r/:slug/availability', rateLimit('availability', 240, 60_000), (ctx) => {
    const r = bySlug(app, ctx.params.slug);
    const excludeId = ctx.query.code && ctx.query.t ? byCode(app, ctx.query.code, ctx.query.t).row.id : null;
    return publicAvailability(app, r, { date: ctx.query.date, partySize: int(ctx.query.party), excludeId });
  });

  router.post('/api/public/r/:slug/reservations', rateLimit('book', 12, 10 * 60_000), (ctx) => {
    const r = bySlug(app, ctx.params.slug);
    if (ctx.body.website) throw new HttpError(400, 'invalid', 'Something went wrong. Please try again.'); // honeypot
    return bookOnline(app, r, ctx.body);
  });

  router.get('/r/:slug/card-return', async (ctx) => {
    const { row, restaurant } = byCode(app, ctx.query.code, ctx.query.t);
    const token = manageToken(app, row);
    if (row.status === 'pending' && row.card_session_ref) {
      const key = app.integrations.stripeKey(restaurant.id);
      const done = key ? await completedCardHold(key, row.card_session_ref, app.fetch).catch(() => null) : null;
      if (done) {
        app.db.run("UPDATE reservations SET card_status = 'on_file', card_ref = ?, updated_at = ? WHERE id = ?", done.paymentMethod, app.now(), row.id);
        if (row.guest_id && done.customerId) app.db.run('UPDATE guests SET stripe_customer_id = ? WHERE id = ?', done.customerId, row.guest_id);
        setStatus(app, restaurant, row.id, 'booked', { by: 'system' });
        return redirect(ctx.res, `/m/${row.code}?t=${token}&card=ok`);
      }
    }
    redirect(ctx.res, `/m/${row.code}?t=${token}`);
  });

  router.get('/api/public/m/:code', (ctx) => {
    const { row, restaurant } = byCode(app, ctx.params.code, ctx.query.t);
    return manageInfo(app, restaurant, row);
  });

  router.post('/api/public/m/:code/cancel', rateLimit('manage', 30, 10 * 60_000), (ctx) => {
    const { row, restaurant } = byCode(app, ctx.params.code, ctx.query.t || ctx.body.t);
    const updated = cancelByGuest(app, restaurant, row);
    return manageInfo(app, restaurant, updated);
  });

  router.post('/api/public/m/:code/modify', rateLimit('manage', 30, 10 * 60_000), (ctx) => {
    const { row, restaurant } = byCode(app, ctx.params.code, ctx.query.t || ctx.body.t);
    const patch = {};
    if (ctx.body.date !== undefined) patch.date = ctx.body.date;
    if (ctx.body.time !== undefined) patch.time = int(ctx.body.time);
    if (ctx.body.partySize !== undefined) patch.partySize = int(ctx.body.partySize);
    if (ctx.body.notes !== undefined) patch.notes = ctx.body.notes;
    const updated = modifyByGuest(app, restaurant, row, patch);
    return manageInfo(app, restaurant, updated);
  });

  router.post('/api/public/m/:code/card', rateLimit('manage', 30, 10 * 60_000), async (ctx) => {
    const { row, restaurant } = byCode(app, ctx.params.code, ctx.query.t || ctx.body.t);
    if (row.status !== 'pending') throw new HttpError(409, 'not_pending', 'No card is needed for this reservation.');
    return { checkoutUrl: await startCardHold(app, restaurant, row) };
  });

  router.get('/m/:code/calendar.ics', (ctx) => {
    const { row, restaurant } = byCode(app, ctx.params.code, ctx.query.t);
    const start = zonedToUtc(row.date, row.start_min, restaurant.timezone);
    const location = [restaurant.address, restaurant.city, restaurant.region].filter(Boolean).join(', ');
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:-//${icsText(app.config.brand.name)}//Reservations//EN`,
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${row.code}@${new URL(app.config.baseUrl).host}`,
      `DTSTAMP:${icsDate(app.now())}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(start + row.duration_min * 60000)}`,
      `SUMMARY:${icsText(`${restaurant.name}: table for ${row.party_size}`)}`,
      location && `LOCATION:${icsText(location)}`,
      `DESCRIPTION:${icsText(`Confirmation ${row.code}. Change or cancel: ${manageUrl(app, row)}`)}`,
      row.status === 'cancelled' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean);
    sendText(ctx.res, 200, `${lines.map(fold).join('\r\n')}\r\n`, 'text/calendar; charset=utf-8', {
      'Content-Disposition': `attachment; filename="${restaurant.slug}-${row.date}.ics"`,
    });
  });

  router.post('/api/public/r/:slug/waitlist', rateLimit('waitlist', 6, 10 * 60_000), (ctx) => {
    const r = bySlug(app, ctx.params.slug);
    if (ctx.body.website) throw new HttpError(400, 'invalid', 'Something went wrong. Please try again.');
    const entry = addToWaitlist(app, r, ctx.body, { source: 'online' });
    return { id: entry.id, statusUrl: `/w/${entry.id}?t=${waitlistToken(app, entry)}`, quotedMin: entry.quoted_min };
  });

  const waitlistEntry = (ctx) => {
    const entry = app.db.one('SELECT * FROM waitlist WHERE id = ?', int(ctx.params.id));
    if (!entry || !verifyWaitlistToken(app, entry, ctx.query.t || ctx.body?.t)) throw new HttpError(404, 'not_found', 'Waitlist entry not found.');
    return { entry, restaurant: app.db.one('SELECT * FROM restaurants WHERE id = ?', entry.restaurant_id) };
  };

  router.get('/api/public/w/:id', (ctx) => {
    const { entry, restaurant } = waitlistEntry(ctx);
    return publicWaitlistStatus(app, restaurant, entry);
  });

  router.post('/api/public/w/:id/leave', (ctx) => {
    const { entry, restaurant } = waitlistEntry(ctx);
    const updated = ['waiting', 'notified'].includes(entry.status) ? removeFromWaitlist(app, restaurant, entry.id, 'cancelled') : entry;
    return publicWaitlistStatus(app, restaurant, updated);
  });
}
