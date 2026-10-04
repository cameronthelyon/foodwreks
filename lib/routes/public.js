// Diner-facing routes: booking page data, availability, booking, manage
// links, calendar files, card holds, and the online waitlist.

import { computeAvailability, nextAvailable } from '../availability.js';
import { dayContext, loadFloor, loadShifts, publicProfile, restaurantSettings } from '../restaurants.js';
import {
  cancelByGuest,
  createReservation,
  manageToken,
  manageUrl,
  modifyByGuest,
  publicReservationView,
  setStatus,
  verifyManageToken,
} from '../reservations.js';
import { addToWaitlist, publicWaitlistStatus, removeFromWaitlist, verifyWaitlistToken, waitlistToken } from '../waitlist.js';
import { normalizeEmail, normalizePhone } from '../guests.js';
import { canTakeOnlineBookings } from '../license.js';
import { completedCardHold, createCardHoldSession } from '../integrations/stripe.js';
import { addDays, fmt12, isValidDate, localDate, zonedToUtc } from '../time.js';
import { HttpError, redirect, sendText } from '../http.js';
import { int, rateLimit } from './helpers.js';

function bySlug(app, slug) {
  const r = app.db.one('SELECT * FROM restaurants WHERE slug = ?', String(slug));
  if (!r) throw new HttpError(404, 'not_found', 'Restaurant not found.');
  return r;
}

function byCode(app, code, token) {
  const row = app.db.one('SELECT * FROM reservations WHERE code = ?', String(code).toUpperCase());
  if (!row || !verifyManageToken(app, row, token)) throw new HttpError(404, 'not_found', 'Reservation not found. Check the link in your confirmation.');
  const restaurant = app.db.one('SELECT * FROM restaurants WHERE id = ?', row.restaurant_id);
  return { row, restaurant };
}

function manageInfo(app, restaurant, row) {
  const settings = restaurantSettings(restaurant);
  const beforeCutoff = row.starts_at - app.now() >= settings.cancelCutoffMinutes * 60000;
  return {
    reservation: publicReservationView(row, restaurant),
    restaurant: publicProfile(restaurant),
    canChange: ['booked', 'confirmed'].includes(row.status) && beforeCutoff,
    canCancel: ['pending', 'booked', 'confirmed'].includes(row.status) && (beforeCutoff || row.status === 'pending'),
    cancelCutoffMinutes: settings.cancelCutoffMinutes,
    calendarUrl: `/m/${row.code}/calendar.ics?t=${manageToken(app, row)}`,
  };
}

async function startCardHold(app, restaurant, row) {
  const key = app.integrations.stripeKey(restaurant.id);
  if (!key) throw new HttpError(409, 'card_unavailable', 'Card holds are not set up for this restaurant.');
  const guest = row.guest_id ? app.db.one('SELECT * FROM guests WHERE id = ?', row.guest_id) : null;
  const token = manageToken(app, row);
  const base = app.config.baseUrl;
  const session = await createCardHoldSession(key, {
    customerId: guest?.stripe_customer_id || null,
    guest: { id: guest?.id ?? `r${row.id}`, name: row.guest_name, email: row.guest_email, phone: row.guest_phone },
    reservation: row,
    restaurant,
    successUrl: `${base}/r/${restaurant.slug}/card-return?code=${row.code}&t=${token}`,
    cancelUrl: `${base}/m/${row.code}?t=${token}&card=cancelled`,
    fetchImpl: app.fetch,
  });
  app.db.run("UPDATE reservations SET card_status = 'pending', card_session_ref = ?, updated_at = ? WHERE id = ?", session.sessionId, app.now(), row.id);
  if (guest && !guest.stripe_customer_id) app.db.run('UPDATE guests SET stripe_customer_id = ? WHERE id = ?', session.customerId, guest.id);
  return session.url;
}

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
    const date = ctx.query.date;
    const partySize = int(ctx.query.party);
    if (!isValidDate(date)) throw new HttpError(400, 'invalid', 'Pick a valid date.');
    if (!partySize || partySize < 1 || partySize > 100) throw new HttpError(400, 'invalid', 'Pick a party size.');
    if (!canTakeOnlineBookings(r, app.now())) {
      return { date, partySize, closed: true, message: `Online booking is not available right now.${r.phone ? ` Please call ${r.phone}.` : ''}`, slots: [], next: [] };
    }
    let exclude = null;
    if (ctx.query.code && ctx.query.t) exclude = byCode(app, ctx.query.code, ctx.query.t).row.id;
    const floor = loadFloor(app.db, r.id);
    const shifts = loadShifts(app.db, r.id);
    const load = (d) => ({ ...dayContext(app.db, r, d, { nowMs: app.now(), channel: 'online', floor, shifts }), excludeReservationId: exclude });
    const result = computeAvailability({ ...load(date), partySize });
    const slots = result.slots.filter((s) => s.reason !== 'past').map((s) => ({ time: s.time, label: fmt12(s.time), available: s.available, group: s.shift }));
    const next =
      !slots.some((s) => s.available) && !result.largeParty
        ? nextAvailable(load, { fromDate: addDays(date, 1), partySize, days: 21, limit: 3 }).map((n) => ({
            date: n.date,
            times: n.times.map((t) => ({ time: t, label: fmt12(t) })),
          }))
        : [];
    return { date, partySize, closed: result.closed, message: result.message, largeParty: Boolean(result.largeParty), slots, next };
  });

  router.post('/api/public/r/:slug/reservations', rateLimit('book', 12, 10 * 60_000), async (ctx) => {
    const r = bySlug(app, ctx.params.slug);
    const b = ctx.body;
    if (b.website) throw new HttpError(400, 'invalid', 'Something went wrong. Please try again.'); // honeypot
    const settings = restaurantSettings(r);
    const partySize = int(b.partySize);
    const phone = normalizePhone(b.phone, r.country);
    const email = normalizeEmail(b.email);
    // One active booking per person per evening: stops double-submits and
    // the most common form of table hoarding.
    if (isValidDate(b.date) && (phone || email)) {
      const dupe = app.db.one(
        `SELECT start_min FROM reservations WHERE restaurant_id = ? AND date = ?
           AND status IN ('pending', 'booked', 'confirmed') AND ((? IS NOT NULL AND guest_phone = ?) OR (? IS NOT NULL AND guest_email = ?))`,
        r.id,
        b.date,
        phone,
        phone,
        email,
        email,
      );
      if (dupe) throw new HttpError(409, 'duplicate', `You already have a reservation that day at ${fmt12(dupe.start_min)}. Use the link in your confirmation to change it.`);
    }
    const cardAvailable = settings.cardRequiredMinParty > 0 && partySize >= settings.cardRequiredMinParty && Boolean(app.integrations.stripeKey(r.id));
    if (settings.policyText && !b.policyAccepted) throw new HttpError(400, 'invalid', 'Please accept the reservation policy.');
    const { reservation } = createReservation(app, r, { ...b, partySize, cardAvailable }, { channel: 'online' });
    if (reservation.status === 'pending') {
      try {
        const checkoutUrl = await startCardHold(app, r, reservation);
        return { code: reservation.code, status: 'pending', checkoutUrl };
      } catch (err) {
        setStatus(app, r, reservation.id, 'cancelled', { by: 'system', notify: false, reason: 'card hold failed' });
        app.log.warn?.(`card hold failed for ${reservation.code}: ${err.message}`);
        throw new HttpError(502, 'card_unavailable', `We could not start the card hold. Please try again${r.phone ? ` or call ${r.phone}` : ''}.`);
      }
    }
    return { code: reservation.code, status: reservation.status, manageUrl: manageUrl(app, reservation), reservation: publicReservationView(reservation, r) };
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
