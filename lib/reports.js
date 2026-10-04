// Reports. Plain aggregates over the reservation table. Past bookings still
// marked booked/confirmed are reported as "unresolved" rather than guessed
// at: nobody marked them seated or no-show, so we do not pretend to know.

import { HttpError } from './http.js';
import { daysBetween, isValidDate, localDate } from './time.js';
import { restaurantSettings } from './restaurants.js';

const SEATED = new Set(['arrived', 'seated', 'completed']);
const NETWORK_RATE_SOURCES = new Set(['google', 'instagram']);

export function buildReport(db, restaurant, from, to, nowMs = Date.now()) {
  if (!isValidDate(from) || !isValidDate(to)) throw new HttpError(400, 'invalid', 'Dates must be YYYY-MM-DD.');
  if (daysBetween(from, to) < 0) throw new HttpError(400, 'invalid', 'Start date must be before end date.');
  if (daysBetween(from, to) > 400) throw new HttpError(400, 'invalid', 'Pick a range of 400 days or less.');
  const today = localDate(nowMs, restaurant.timezone);
  const settings = restaurantSettings(restaurant);
  const rows = db.all(
    `SELECT r.date, r.start_min, r.party_size, r.status, r.source, r.spend_cents, r.cancelled_by, r.guest_id,
            g.visit_count AS visits
       FROM reservations r LEFT JOIN guests g ON g.id = r.guest_id
      WHERE r.restaurant_id = ? AND r.date BETWEEN ? AND ?`,
    restaurant.id,
    from,
    to,
  );

  const totals = {
    reservations: 0,
    bookedCovers: 0,
    seatedCovers: 0,
    seatedParties: 0,
    noShows: 0,
    noShowCovers: 0,
    cancelled: 0,
    cancelledByGuest: 0,
    unresolved: 0,
    walkIns: 0,
    spendCents: 0,
    returningParties: 0,
  };
  const byDay = new Map();
  const bySource = {};
  const byHour = {};
  const bySize = {};

  for (const r of rows) {
    totals.reservations++;
    const day = byDay.get(r.date) || { date: r.date, reservations: 0, covers: 0, noShows: 0, cancelled: 0 };
    byDay.set(r.date, day);
    day.reservations++;
    const src = (bySource[r.source] ||= { parties: 0, covers: 0 });
    if (r.status === 'cancelled') {
      totals.cancelled++;
      day.cancelled++;
      if (r.cancelled_by === 'guest') totals.cancelledByGuest++;
      continue;
    }
    totals.bookedCovers += r.party_size;
    src.parties++;
    src.covers += r.party_size;
    if (r.status === 'no_show') {
      totals.noShows++;
      totals.noShowCovers += r.party_size;
      day.noShows++;
    } else if (SEATED.has(r.status)) {
      totals.seatedParties++;
      totals.seatedCovers += r.party_size;
      day.covers += r.party_size;
      if (r.source === 'walkin') totals.walkIns++;
      if ((r.visits || 0) > 1) totals.returningParties++;
      const hour = Math.floor(r.start_min / 60) % 24;
      byHour[hour] = (byHour[hour] || 0) + r.party_size;
      bySize[r.party_size] = (bySize[r.party_size] || 0) + 1;
    } else if (daysBetween(today, r.date) < 0) {
      totals.unresolved++;
    }
    totals.spendCents += r.spend_cents || 0;
  }

  const decided = totals.seatedParties + totals.noShows;
  const networkCovers = Object.entries(bySource)
    .filter(([s]) => NETWORK_RATE_SOURCES.has(s))
    .reduce((a, [, v]) => a + v.covers, 0);

  return {
    from,
    to,
    totals,
    rates: {
      noShowRate: decided ? totals.noShows / decided : null,
      cancelRate: totals.reservations ? totals.cancelled / totals.reservations : null,
      returningShare: totals.seatedParties ? totals.returningParties / totals.seatedParties : null,
      avgPartySize: totals.seatedParties ? totals.seatedCovers / totals.seatedParties : null,
      avgSpendPerCoverCents: totals.seatedCovers && totals.spendCents ? Math.round(totals.spendCents / totals.seatedCovers) : null,
    },
    byDay: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    bySource,
    byHour,
    bySize,
    // An honest, narrow estimate: covers from Google and Instagram, which
    // OpenTable bills at its network rate, times the configured per-cover fee.
    feesAvoided: {
      networkRateCovers: networkCovers,
      perCoverCents: settings.feeComparisonCents,
      estimatedCents: networkCovers * settings.feeComparisonCents,
    },
  };
}
