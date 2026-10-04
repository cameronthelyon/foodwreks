// Demo data: a fictional neighborhood restaurant with a month of history and
// two weeks of upcoming bookings, so every screen has something real on it.

import { hashPassword } from './auth.js';
import { createRestaurant, sanitizeSettings } from './restaurants.js';
import { createReservation } from './reservations.js';
import { findOrCreateGuest, refreshGuestStats } from './guests.js';
import { addToWaitlist } from './waitlist.js';
import { addDays, localDate, localMinutes, weekdayOf } from './time.js';

export const DEMO_EMAIL = 'demo@freeheld.test';
export const DEMO_PASSWORD = 'freeheld-demo';

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Maya', 'Jordan', 'Priya', 'Luis', 'Grace', 'Omar', 'Hannah', 'Kenji', 'Sofia', 'Marcus', 'Elena', 'Andre', 'Nadia', 'Tom', 'Aisha', 'Ben', 'Carmen', 'Dev', 'Fatima', 'Gabe', 'Ines', 'Jamal', 'Keiko', 'Leo', 'Mina', 'Noah', 'Olivia', 'Paolo', 'Rosa', 'Sam'];
const LAST = ['Chen', 'Okafor', 'Patel', 'Ramirez', 'Kim', 'Haddad', 'Novak', 'Tanaka', 'Rossi', 'Johnson', 'Petrova', 'Williams', 'Farah', 'Burke', 'Diallo', 'Cohen', 'Vega', 'Shah', 'Ali', 'Moreno', 'Silva', 'Brooks', 'Sato', 'Nguyen', 'Park', 'Garcia', 'Lee', 'Bianchi', 'Lopez', 'Reyes'];
const TAGS = [['VIP'], ['Regular'], ['Allergy: shellfish'], ['Industry'], ['Vegetarian'], ['Allergy: nuts'], [], [], [], [], [], []];
const NOTES = ['Prefers a booth', 'Celebrated anniversary here last year', 'Likes the window', 'Sommelier friend of the chef', '', '', '', ''];
const OCCASIONS = ['Birthday', 'Anniversary', 'Date night', 'Business', '', '', '', '', '', ''];

export async function seedDemo(app) {
  const { db } = app;
  if (db.one('SELECT 1 FROM users WHERE email = ?', DEMO_EMAIL)) return { created: false, email: DEMO_EMAIL, password: DEMO_PASSWORD };
  const now = app.now();
  const rand = rng(20261004);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const hash = await hashPassword(DEMO_PASSWORD);

  const { restaurant } = db.tx(() => {
    const { id: ownerId } = db.run(
      'INSERT INTO users (email, name, password_hash, is_platform_admin, created_at) VALUES (?, ?, ?, 1, ?)',
      DEMO_EMAIL,
      'Dana Demo',
      hash,
      now,
    );
    const r = createRestaurant(db, {
      name: 'Juniper & Rye',
      timezone: 'America/Los_Angeles',
      ownerId,
      trialDays: 23,
      now,
      phone: '(510) 555-0142',
      email: 'hello@juniper-rye.example',
      website: '',
      address: '1200 Alder Street',
      city: 'Oakland',
      region: 'CA',
      postal_code: '94612',
    });
    db.run("UPDATE restaurants SET cuisine = 'Seasonal Californian' WHERE id = ?", r.id);
    db.run(
      'UPDATE restaurants SET settings = ? WHERE id = ?',
      JSON.stringify(
        sanitizeSettings({
          maxPartySize: 8,
          bookingWindowDays: 45,
          minNoticeMinutes: 30,
          policyText: 'Plans change. Please cancel or modify at least 2 hours ahead so we can offer the table to someone else.',
          confirmationMessage: 'Street parking is easiest on 13th. Tell us about allergies and we will take care of you.',
          waitlistOnline: true,
          noShowFeeCents: 2500,
          brandColor: '#2F5D50',
        }),
      ),
      r.id,
    );
    const { id: hostId } = db.run(
      'INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
      'host@freeheld.test',
      'Hayden Host',
      hash,
      now,
    );
    db.run("INSERT INTO memberships (user_id, restaurant_id, role, created_at) VALUES (?, ?, 'host', ?)", hostId, r.id, now);

    const table = (name, section, min, max, sort, online = 1) =>
      db.run(
        'INSERT INTO tables (restaurant_id, name, section, min_covers, max_covers, online, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
        r.id,
        name,
        section,
        min,
        max,
        online,
        sort,
      ).id;
    const ids = {};
    let sort = 1;
    for (const n of ['1', '2', '3', '4']) ids[n] = table(n, 'Window', 1, 2, sort++);
    for (const n of ['10', '11', '12', '13', '14']) ids[n] = table(n, 'Dining room', 2, 4, sort++);
    for (const n of ['20', '21']) ids[n] = table(n, 'Dining room', 4, 6, sort++);
    for (const n of ['P1', 'P2']) ids[n] = table(n, 'Patio', 2, 4, sort++);
    for (const n of ['Bar 1', 'Bar 2', 'Bar 3']) ids[n] = table(n, 'Bar', 1, 2, sort++, 0);
    const combo = (name, list, min, max) =>
      db.run('INSERT INTO table_combos (restaurant_id, name, table_ids, min_covers, max_covers) VALUES (?, ?, ?, ?, ?)', r.id, name, JSON.stringify(list.map((n) => ids[n])), min, max);
    combo('13+14', ['13', '14'], 6, 8);
    combo('20+21', ['20', '21'], 8, 12);
    db.run(
      `INSERT INTO shifts (restaurant_id, name, days, start_min, last_seating_min, end_min, interval_min, max_covers_per_slot)
       VALUES (?, 'Dinner', '[0,2,3,4,5,6]', 1020, 1290, 1350, 15, 20)`,
      r.id,
    );
    db.run(
      `INSERT INTO shifts (restaurant_id, name, days, start_min, last_seating_min, end_min, interval_min)
       VALUES (?, 'Weekend brunch', '[0,6]', 600, 810, 870, 15)`,
      r.id,
    );
    const today = localDate(now, r.timezone);
    db.run("INSERT INTO closures (restaurant_id, date, closed, note) VALUES (?, ?, 1, 'Private event')", r.id, addDays(today, 11));
    return { restaurant: db.one('SELECT * FROM restaurants WHERE id = ?', r.id) };
  });

  // Guests
  const guests = [];
  db.tx(() => {
    for (let i = 0; i < 70; i++) {
      const first = FIRST[i % FIRST.length];
      const last = LAST[(i * 7) % LAST.length];
      const g = findOrCreateGuest(
        db,
        restaurant.id,
        {
          firstName: first,
          lastName: last,
          phone: `+1510555${String(1000 + i).padStart(4, '0')}`,
          email: `${first}.${last}${i}@example.com`.toLowerCase(),
          tags: pick(TAGS),
          notes: pick(NOTES),
          importedVisits: Math.floor(rand() * rand() * 14),
          marketingOptIn: rand() < 0.4,
        },
        now,
      );
      guests.push(g);
    }
  });

  // Reservations: 21 days back, 14 ahead.
  const today = localDate(now, restaurant.timezone);
  const nowMin = localMinutes(now, restaurant.timezone);
  const sources = ['online', 'online', 'online', 'google', 'google', 'phone', 'phone', 'website', 'instagram'];
  for (let d = -21; d <= 14; d++) {
    const date = addDays(today, d);
    const wd = weekdayOf(date);
    if (wd === 1 || d === 11) continue; // closed Mondays and the private event
    const busy = wd === 5 || wd === 6 ? 30 : wd === 0 ? 22 : 16;
    const count = Math.round(busy * (d > 7 ? 0.45 : d > 2 ? 0.7 : 1) * (0.8 + rand() * 0.4));
    const brunch = wd === 0 || wd === 6;
    const made = [];
    for (let i = 0; i < count; i++) {
      const g = guests[Math.floor(rand() * guests.length)];
      const isBrunch = brunch && rand() < 0.3;
      const start = isBrunch ? 600 : 1020;
      const span = isBrunch ? 14 : 18;
      const time = start + Math.floor(Math.pow(rand(), 0.8) * span) * 15;
      const party = [2, 2, 2, 2, 3, 4, 4, 4, 5, 6, 2, 7][Math.floor(rand() * 12)];
      try {
        const { reservation } = createReservation(
          app,
          restaurant,
          {
            date,
            time,
            partySize: party,
            firstName: g.first_name,
            lastName: g.last_name,
            phone: g.phone,
            email: g.email,
            occasion: pick(OCCASIONS),
            notes: rand() < 0.1 ? 'Celebrating, a quiet table would be lovely' : '',
            source: pick(sources),
            notify: false,
          },
          { channel: 'staff' },
        );
        made.push(reservation);
      } catch {
        // full at that time: skip, like a real diner would
      }
    }
    // Statuses are applied after the whole day is booked, so finished parties
    // keep their tables while later bookings are placed.
    for (const reservation of made) {
      const time = reservation.start_min;
      const party = reservation.party_size;
      let status = 'booked';
      const end = time + reservation.duration_min;
      if (d < 0) {
        const roll = rand();
        status = roll < 0.06 ? 'no_show' : roll < 0.15 ? 'cancelled' : 'completed';
      } else if (d === 0) {
        if (end <= nowMin) status = rand() < 0.07 ? 'no_show' : 'completed';
        else if (time <= nowMin) status = 'seated';
        else status = rand() < 0.4 ? 'confirmed' : 'booked';
      } else if (rand() < 0.35) status = 'confirmed';
      else if (rand() < 0.06) status = 'cancelled';
      if (status !== 'booked') {
        const spend = status === 'completed' && rand() < 0.75 ? party * (4200 + Math.floor(rand() * 4800)) : null;
        db.run(
          `UPDATE reservations SET status = ?, spend_cents = ?, cancelled_by = CASE WHEN ? = 'cancelled' THEN 'guest' END,
             cancelled_at = CASE WHEN ? = 'cancelled' THEN created_at END,
             seated_at = CASE WHEN ? IN ('seated', 'completed') THEN starts_at END,
             completed_at = CASE WHEN ? = 'completed' THEN starts_at + duration_min * 60000 END,
             confirmed_at = CASE WHEN ? = 'confirmed' THEN created_at END
           WHERE id = ?`,
          status,
          spend,
          status,
          status,
          status,
          status,
          status,
          reservation.id,
        );
      }
      // Bookings are made days ahead, not "now", so reminders behave.
      db.run('UPDATE reservations SET created_at = starts_at - ? WHERE id = ?', Math.floor((1 + rand() * 9) * 86400_000), reservation.id);
    }
  }
  for (const g of guests) refreshGuestStats(db, g.id, now);

  for (const [name, party, phone] of [
    ['Wes Ortega', 2, '+15105559001'],
    ['Lina Haddad', 4, '+15105559002'],
    ['Pat Kowalski', 3, null],
  ]) {
    addToWaitlist(app, restaurant, { name, partySize: party, phone, notify: false }, { source: 'staff' });
  }
  return { created: true, email: DEMO_EMAIL, password: DEMO_PASSWORD, restaurantId: restaurant.id };
}
