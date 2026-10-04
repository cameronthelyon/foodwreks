// Booking logic shared by every diner-facing door: the booking page's JSON
// API (routes/public.js) and the AI agent server (mcp.js). One set of rules
// (limits, pacing, the one-booking-per-day check, card holds) for all.

import { computeAvailability, nextAvailable } from './availability.js';
import { dayContext, loadFloor, loadShifts, publicProfile, restaurantSettings } from './restaurants.js';
import { createReservation, manageToken, manageUrl, publicReservationView, setStatus, verifyManageToken } from './reservations.js';
import { canTakeOnlineBookings } from './license.js';
import { createCardHoldSession } from './integrations/stripe.js';
import { addDays, fmt12, isValidDate } from './time.js';
import { HttpError } from './http.js';

const int = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

// Channels a diner-facing link may claim. "google" here only tags a booking
// that arrived from the Business Profile link; it grants nothing.
export const PUBLIC_CHANNELS = ['online', 'website', 'google', 'instagram'];
export const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export function bySlug(app, slug) {
  const r = app.db.one('SELECT * FROM restaurants WHERE slug = ?', String(slug));
  if (!r) throw new HttpError(404, 'not_found', 'Restaurant not found.');
  return r;
}

export function byCode(app, code, token) {
  const row = app.db.one('SELECT * FROM reservations WHERE code = ?', String(code).toUpperCase());
  if (!row || !verifyManageToken(app, row, token)) throw new HttpError(404, 'not_found', 'Reservation not found. Check the link in your confirmation.');
  const restaurant = app.db.one('SELECT * FROM restaurants WHERE id = ?', row.restaurant_id);
  return { row, restaurant };
}

export function manageInfo(app, restaurant, row) {
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

export async function startCardHold(app, restaurant, row) {
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

// Open times for a party on a date, the way diners see them. `excludeId`
// leaves out the guest's own booking when they are changing it.
export function publicAvailability(app, r, { date, partySize, excludeId = null }) {
  if (!isValidDate(date)) throw new HttpError(400, 'invalid', 'Pick a valid date.');
  if (!partySize || partySize < 1 || partySize > 100) throw new HttpError(400, 'invalid', 'Pick a party size.');
  if (!canTakeOnlineBookings(r, app.now())) {
    return { date, partySize, closed: true, message: `Online booking is not available right now.${r.phone ? ` Please call ${r.phone}.` : ''}`, slots: [], next: [] };
  }
  const floor = loadFloor(app.db, r.id);
  const shifts = loadShifts(app.db, r.id);
  const load = (d) => ({ ...dayContext(app.db, r, d, { nowMs: app.now(), channel: 'online', floor, shifts }), excludeReservationId: excludeId });
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
}

// A diner booking. Only the listed fields cross into a reservation; anything
// else (external references, statuses, staff notes) is server-side only.
export async function bookOnline(app, r, b, { source } = {}) {
  const settings = restaurantSettings(r);
  const partySize = int(b.partySize);
  if (settings.policyText && b.policyAccepted !== true) throw new HttpError(400, 'invalid', 'Please accept the reservation policy.');
  const input = {
    date: str(b.date),
    time: int(b.time),
    partySize,
    firstName: str(b.firstName),
    lastName: str(b.lastName),
    phone: str(b.phone) || undefined,
    email: str(b.email) || undefined,
    notes: str(b.notes),
    occasion: str(b.occasion),
    marketingOptIn: b.marketingOptIn === true,
    source: source || (PUBLIC_CHANNELS.includes(b.source) ? b.source : 'online'),
    cardAvailable: settings.cardRequiredMinParty > 0 && partySize >= settings.cardRequiredMinParty && Boolean(app.integrations.stripeKey(r.id)),
  };
  const { reservation } = createReservation(app, r, input, { channel: 'online' });
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
}

export { publicProfile, restaurantSettings, canTakeOnlineBookings };
