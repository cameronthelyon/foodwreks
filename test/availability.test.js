import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAvailability,
  nextAvailable,
  resolveBooking,
  tablesFree,
  turnTimeFor,
} from '../lib/availability.js';
import { zonedToUtc } from '../lib/time.js';

const TZ = 'America/Los_Angeles';
const DATE = '2026-10-10'; // Saturday
const NOW = zonedToUtc('2026-10-09', 12 * 60, TZ); // the day before, noon
const hm = (s) => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);

const SETTINGS = {
  minPartySize: 1,
  maxPartySize: 8,
  bookingWindowDays: 30,
  minNoticeMinutes: 60,
  bufferMinutes: 0,
  slotInterval: 30,
  autoOptimize: true,
  turnTimes: [
    { upTo: 2, minutes: 90 },
    { upTo: 4, minutes: 105 },
    { upTo: 6, minutes: 120 },
    { upTo: 99, minutes: 150 },
  ],
};

const TABLES = [
  { id: 1, name: 'T1', min_covers: 1, max_covers: 2, online: 1, active: 1, sort: 1 },
  { id: 2, name: 'T2', min_covers: 1, max_covers: 2, online: 1, active: 1, sort: 2 },
  { id: 3, name: 'T3', min_covers: 2, max_covers: 4, online: 1, active: 1, sort: 3 },
  { id: 4, name: 'T4', min_covers: 2, max_covers: 4, online: 1, active: 1, sort: 4 },
  { id: 5, name: 'T5', min_covers: 4, max_covers: 6, online: 1, active: 1, sort: 5 },
  { id: 6, name: 'Bar', min_covers: 1, max_covers: 2, online: 0, active: 1, sort: 6 },
];
const COMBOS = [{ id: 1, name: 'T3+T4', table_ids: [3, 4], min_covers: 6, max_covers: 8, online: 1, active: 1 }];
const SHIFTS = [
  {
    id: 1,
    name: 'Dinner',
    days: [0, 1, 2, 3, 4, 5, 6],
    start_min: hm('17:00'),
    last_seating_min: hm('21:00'),
    end_min: hm('22:00'),
    interval_min: 30,
    max_covers_per_slot: null,
    max_parties_per_slot: null,
    online: 1,
    active: 1,
  },
];

let nextId = 100;
function res(time, party, tableIds = [], extra = {}) {
  return {
    id: nextId++,
    date: DATE,
    start_min: hm(time),
    duration_min: turnTimeFor(SETTINGS, party),
    party_size: party,
    status: 'booked',
    source: 'online',
    table_ids: tableIds,
    table_locked: 0,
    ...extra,
  };
}

function ctx(over = {}) {
  return {
    date: DATE,
    partySize: 2,
    settings: SETTINGS,
    timezone: TZ,
    nowMs: NOW,
    channel: 'online',
    shifts: SHIFTS,
    closure: null,
    tables: TABLES,
    combos: COMBOS,
    reservations: [],
    ...over,
  };
}

const slotAt = (result, time) => result.slots.find((s) => s.time === hm(time));

test('empty night: every slot open, smallest fitting table chosen', () => {
  const r = computeAvailability(ctx());
  assert.equal(r.slots.length, 9); // 17:00..21:00 every 30
  assert.ok(r.slots.every((s) => s.available));
  const staff = computeAvailability(ctx({ channel: 'staff' }));
  assert.deepEqual(slotAt(staff, '18:00').tableIds, [1]);
});

test('turn time follows party size', () => {
  assert.equal(turnTimeFor(SETTINGS, 2), 90);
  assert.equal(turnTimeFor(SETTINGS, 3), 105);
  assert.equal(turnTimeFor(SETTINGS, 7), 150);
  assert.equal(computeAvailability(ctx({ partySize: 5 })).duration, 120);
});

test('combos seat parties no single table fits', () => {
  const staff = computeAvailability(ctx({ channel: 'staff', partySize: 7 }));
  assert.deepEqual(slotAt(staff, '19:00').tableIds, [3, 4]);
});

test('online party limits and large-party message', () => {
  const r = computeAvailability(ctx({ partySize: 9, settings: { ...SETTINGS, largePartyMessage: 'Over {max}? Call us.' } }));
  assert.equal(r.slots.length, 0);
  assert.equal(r.largeParty, true);
  assert.equal(r.message, 'Over 8? Call us.');
  // Staff can try, but nothing seats 9 here
  const staff = computeAvailability(ctx({ channel: 'staff', partySize: 9 }));
  assert.ok(staff.slots.every((s) => !s.available && s.reason === 'full'));
});

test('walk-in-only tables are hidden from online booking', () => {
  const reservations = [res('18:00', 2, [1]), res('18:00', 2, [2]), res('18:00', 4, [3]), res('18:00', 4, [4]), res('18:00', 6, [5])];
  const online = computeAvailability(ctx({ reservations }));
  assert.equal(slotAt(online, '18:00').available, false);
  const staff = computeAvailability(ctx({ channel: 'staff', reservations }));
  assert.deepEqual(slotAt(staff, '18:00').tableIds, [6]);
});

test('overlap blocks a table for the full turn, then frees it', () => {
  // Only T1 exists: a 2-top booked 18:00-19:30
  const tables = [TABLES[0]];
  const reservations = [res('18:00', 2, [1])];
  const r = computeAvailability(ctx({ tables, combos: [], reservations }));
  assert.equal(slotAt(r, '17:00').available, false); // 17:00-18:30 overlaps
  assert.equal(slotAt(r, '18:30').available, false);
  assert.equal(slotAt(r, '19:00').available, false);
  assert.equal(slotAt(r, '19:30').available, true);
  assert.equal(slotAt(r, '19:30').tableIds, undefined, 'online responses never expose tables');
});

test('buffer minutes extend occupancy', () => {
  const tables = [TABLES[0]];
  const reservations = [res('18:00', 2, [1])];
  const r = computeAvailability(ctx({ tables, combos: [], reservations, settings: { ...SETTINGS, bufferMinutes: 15 } }));
  assert.equal(slotAt(r, '19:30').available, false);
  assert.equal(slotAt(r, '20:00').available, true);
});

test('pacing blocks online, warns staff', () => {
  const shifts = [{ ...SHIFTS[0], max_covers_per_slot: 6 }];
  const reservations = [res('19:00', 4, [3]), res('19:00', 2, [1])];
  const online = computeAvailability(ctx({ shifts, reservations }));
  assert.equal(slotAt(online, '19:00').reason, 'pacing');
  assert.equal(slotAt(online, '19:30').available, true);
  const staff = computeAvailability(ctx({ shifts, reservations, channel: 'staff' }));
  assert.equal(slotAt(staff, '19:00').available, true);
  assert.deepEqual(slotAt(staff, '19:00').warnings, ['pacing']);
  // Cancelled bookings do not count toward pacing
  const cancelled = reservations.map((r) => ({ ...r, status: 'cancelled' }));
  assert.equal(slotAt(computeAvailability(ctx({ shifts, reservations: cancelled })), '19:00').available, true);
});

test('max parties per slot', () => {
  const shifts = [{ ...SHIFTS[0], max_parties_per_slot: 1 }];
  const r = computeAvailability(ctx({ shifts, reservations: [res('20:00', 2, [1])] }));
  assert.equal(slotAt(r, '20:00').reason, 'pacing');
});

test('closures and special hours', () => {
  const closed = computeAvailability(ctx({ closure: { closed: 1, note: 'Private event' } }));
  assert.equal(closed.closed, true);
  assert.equal(closed.message, 'Private event');
  const special = computeAvailability(
    ctx({ closure: { closed: 0, start_min: hm('12:00'), last_seating_min: hm('13:00'), note: 'Brunch only' } }),
  );
  assert.deepEqual(
    special.slots.map((s) => s.time),
    [hm('12:00'), hm('12:30'), hm('13:00')],
  );
});

test('shifts respect weekdays and seasonal windows', () => {
  const weekdaysOnly = [{ ...SHIFTS[0], days: [1, 2, 3, 4, 5] }];
  assert.equal(computeAvailability(ctx({ shifts: weekdaysOnly })).closed, true);
  const summer = [{ ...SHIFTS[0], starts_on: '2026-06-01', ends_on: '2026-09-30' }];
  assert.equal(computeAvailability(ctx({ shifts: summer })).closed, true);
  const staffOnly = [{ ...SHIFTS[0], online: 0 }];
  assert.equal(computeAvailability(ctx({ shifts: staffOnly })).closed, true);
  assert.equal(computeAvailability(ctx({ shifts: staffOnly, channel: 'staff' })).closed, false);
});

test('minimum notice and booking window', () => {
  const now = zonedToUtc(DATE, hm('16:30'), TZ);
  const r = computeAvailability(ctx({ nowMs: now }));
  assert.equal(slotAt(r, '17:00').reason, 'too_soon');
  assert.equal(slotAt(r, '17:30').available, true);
  const late = computeAvailability(ctx({ nowMs: zonedToUtc(DATE, hm('19:10'), TZ) }));
  assert.equal(slotAt(late, '18:00').reason, 'past');
  const far = computeAvailability(ctx({ date: '2026-12-01' }));
  assert.equal(far.closed, true);
  assert.match(far.message, /30 days/);
  const past = computeAvailability(ctx({ date: '2026-10-01' }));
  assert.equal(past.closed, true);
});

test('repack moves an auto-assigned party to make room', () => {
  const tables = [
    { id: 1, name: 'S', min_covers: 1, max_covers: 2, online: 1, active: 1, sort: 1 },
    { id: 2, name: 'M', min_covers: 2, max_covers: 4, online: 1, active: 1, sort: 2 },
  ];
  const two = res('18:00', 2, [2]); // a 2-top party sitting on the 4-top
  const base = { tables, combos: [], reservations: [two], partySize: 4, time: hm('18:00') };

  const r = resolveBooking(ctx(base));
  assert.equal(r.ok, true);
  assert.deepEqual(r.tableIds, [2]);
  assert.deepEqual(r.moves, [{ reservationId: two.id, tableIds: [1] }]);

  // A host-pinned party never moves
  const pinned = resolveBooking(ctx({ ...base, reservations: [{ ...two, table_locked: 1 }] }));
  assert.equal(pinned.ok, false);
  // Neither does a party already seated
  const seated = resolveBooking(ctx({ ...base, reservations: [{ ...two, status: 'seated' }] }));
  assert.equal(seated.ok, false);
  // And the optimizer can be switched off
  const off = resolveBooking(ctx({ ...base, settings: { ...SETTINGS, autoOptimize: false } }));
  assert.equal(off.ok, false);
});

test('a party seated past its planned end keeps the table', () => {
  const tables = [TABLES[0]];
  const seated = res('18:00', 2, [1], { status: 'seated' });
  const now = zonedToUtc(DATE, hm('19:45'), TZ);
  const r = computeAvailability(ctx({ tables, combos: [], reservations: [seated], nowMs: now, channel: 'staff' }));
  assert.equal(slotAt(r, '19:30').available, false);
  assert.equal(slotAt(r, '20:00').available, true); // blocked until now + 15 min
  const done = computeAvailability(
    ctx({ tables, combos: [], reservations: [{ ...seated, status: 'completed' }], nowMs: now, channel: 'staff' }),
  );
  assert.equal(slotAt(done, '19:30').available, true);
});

test('late reservations from the previous service date spill into this one', () => {
  const tables = [TABLES[0]];
  const lateNight = { ...res('23:30', 2, [1]), date: '2026-10-09', duration_min: 150 };
  const closure = { closed: 0, start_min: 0, last_seating_min: 180, note: 'After hours' };
  const r = computeAvailability(ctx({ tables, combos: [], reservations: [lateNight], closure, channel: 'staff' }));
  assert.equal(slotAt(r, '00:30').available, false); // occupied until 02:00
  assert.equal(slotAt(r, '02:00').available, true);
});

test('unassigned reservations still consume capacity', () => {
  const tables = TABLES.slice(0, 2); // two 2-tops
  const reservations = [res('18:00', 2), res('18:00', 2)];
  const r = computeAvailability(ctx({ tables, combos: [], reservations }));
  assert.equal(slotAt(r, '18:00').available, false);
  assert.equal(slotAt(r, '20:00').available, true);
  // Overbooked imports are reported, not silently absorbed
  const over = computeAvailability(ctx({ tables, combos: [], reservations: [...reservations, res('18:00', 2)] }));
  assert.equal(over.overbooked.length, 1);
});

test('inactive tables and combos with missing members are ignored', () => {
  const tables = TABLES.map((t) => (t.id === 4 ? { ...t, active: 0 } : t));
  const r = computeAvailability(ctx({ tables, channel: 'staff', partySize: 7 }));
  assert.ok(r.slots.every((s) => !s.available));
});

test('resolveBooking: grid rules online, any minute for staff', () => {
  const offGrid = resolveBooking(ctx({ time: hm('18:07') }));
  assert.equal(offGrid.ok, false);
  assert.equal(offGrid.reason, 'not_a_slot');
  const onGrid = resolveBooking(ctx({ time: hm('18:00') }));
  assert.equal(onGrid.ok, true);
  assert.deepEqual(onGrid.tableIds, [1]);
  const walkIn = resolveBooking(ctx({ time: hm('18:07'), channel: 'staff' }));
  assert.equal(walkIn.ok, true);
  const closedDay = resolveBooking(ctx({ time: hm('18:00'), channel: 'staff', closure: { closed: 1 } }));
  assert.equal(closedDay.ok, true, 'staff can seat a private event on a closed day');
});

test('resolveBooking: staff may overbook into an unassigned reservation', () => {
  const tables = [TABLES[0]];
  const reservations = [res('18:00', 2, [1])];
  const blocked = resolveBooking(ctx({ tables, combos: [], reservations, time: hm('18:00'), channel: 'staff' }));
  assert.equal(blocked.ok, false);
  const forced = resolveBooking(
    ctx({ tables, combos: [], reservations, time: hm('18:00'), channel: 'staff', allowUnassigned: true }),
  );
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.tableIds, []);
  assert.ok(forced.warnings.includes('no_table'));
});

test('modifying a reservation does not collide with itself', () => {
  const tables = [TABLES[0]];
  const mine = res('18:00', 2, [1]);
  const blocked = resolveBooking(ctx({ tables, combos: [], reservations: [mine], time: hm('18:30') }));
  assert.equal(blocked.ok, false);
  const moved = resolveBooking(
    ctx({ tables, combos: [], reservations: [mine], time: hm('18:30'), excludeReservationId: mine.id }),
  );
  assert.equal(moved.ok, true);
});

test('tablesFree reports conflicts for manual assignment', () => {
  const a = res('18:00', 2, [1]);
  const check = tablesFree(ctx({ reservations: [a] }), [1, 2], hm('19:00'), 90);
  assert.equal(check.free, false);
  assert.deepEqual(check.conflicts, [a.id]);
  assert.equal(tablesFree(ctx({ reservations: [a] }), [2], hm('19:00'), 90).free, true);
});

test('nextAvailable skips closed and full dates', () => {
  const load = (date) => ctx({ date, closure: date === DATE ? { closed: 1 } : null });
  const found = nextAvailable(load, { fromDate: DATE, partySize: 2, days: 5, limit: 2 });
  assert.equal(found.length, 2);
  assert.equal(found[0].date, '2026-10-11');
  assert.equal(found[0].times[0], hm('17:00'));
});
