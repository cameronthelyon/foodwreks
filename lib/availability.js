// Availability and table assignment.
//
// Pure functions: no database, no clock. Callers pass everything in through a
// context object, which keeps the engine easy to test and to reason about.
//
// Model:
//   - A "unit" is something a party can sit at: a single table, or a defined
//     combination of tables (T4+T5 seats 6-8).
//   - A reservation occupies every table in its unit for
//     [start, start + duration + buffer).
//   - Pacing caps covers and/or parties that may START within one slot, so
//     the kitchen is not slammed at 7:00.
//   - Auto-assigned reservations may be shuffled between tables to make room
//     (repack). Anything a host pinned, or a party already in the building,
//     never moves.

import { addDays, daysBetween, localDate, localMinutes, weekdayOf, zonedToUtc } from './time.js';

// Statuses that hold a table.
export const HOLDING = new Set(['pending', 'booked', 'confirmed', 'arrived', 'seated']);
// Statuses the optimizer may move to another table.
export const MOVABLE = new Set(['pending', 'booked', 'confirmed']);
// Statuses that count toward kitchen pacing (a party that already ate still
// loaded the kitchen in its slot).
const PACED = new Set(['pending', 'booked', 'confirmed', 'arrived', 'seated', 'completed']);
// Bookings that came from public channels may only be re-seated onto tables
// that are open to online booking (walk-in inventory stays protected).
const ONLINE_SOURCES = new Set(['online', 'website', 'google', 'instagram']);
// A party still seated past its planned end is assumed to leave within this
// many minutes; the table stays blocked until then (or until marked done).
const OVERSTAY_MINUTES = 15;

export const DEFAULT_TURN_TIMES = [
  { upTo: 2, minutes: 90 },
  { upTo: 4, minutes: 105 },
  { upTo: 6, minutes: 120 },
  { upTo: 99, minutes: 150 },
];

export function turnTimeFor(settings, partySize) {
  const list = [...(settings.turnTimes?.length ? settings.turnTimes : DEFAULT_TURN_TIMES)].sort(
    (a, b) => a.upTo - b.upTo,
  );
  for (const t of list) if (partySize <= t.upTo) return t.minutes;
  return list[list.length - 1].minutes;
}

// Which seating windows apply on a date. A closure row either closes the day
// or replaces the regular shifts with one special window.
export function serviceWindows({ date, shifts, closure, settings, channel = 'online' }) {
  if (closure && closure.closed) return { closed: true, note: closure.note || 'Closed', windows: [] };
  if (closure && closure.start_min != null) {
    return {
      closed: false,
      note: closure.note || '',
      windows: [
        {
          shiftId: null,
          name: closure.note || 'Special hours',
          start: closure.start_min,
          lastSeating: closure.last_seating_min ?? closure.start_min,
          interval: settings.slotInterval || 15,
          maxCovers: null,
          maxParties: null,
        },
      ],
    };
  }
  const wd = weekdayOf(date);
  const windows = shifts
    .filter(
      (s) =>
        s.active &&
        s.days.includes(wd) &&
        (!s.starts_on || s.starts_on <= date) &&
        (!s.ends_on || date <= s.ends_on) &&
        (channel !== 'online' || s.online),
    )
    .map((s) => ({
      shiftId: s.id,
      name: s.name,
      start: s.start_min,
      lastSeating: s.last_seating_min,
      interval: s.interval_min || settings.slotInterval || 15,
      maxCovers: s.max_covers_per_slot || null,
      maxParties: s.max_parties_per_slot || null,
    }))
    .sort((a, b) => a.start - b.start);
  return { closed: windows.length === 0, note: '', windows };
}

export function buildUnits(tables, combos, channel = 'online') {
  const byId = new Map(tables.filter((t) => t.active).map((t) => [t.id, t]));
  const units = [];
  for (const t of byId.values()) {
    if (channel === 'online' && !t.online) continue;
    units.push({
      key: `t${t.id}`,
      tableIds: [t.id],
      min: t.min_covers,
      max: t.max_covers,
      combo: false,
      sort: t.sort ?? 0,
    });
  }
  for (const c of combos) {
    if (!c.active) continue;
    const ids = c.table_ids;
    if (!ids.length || !ids.every((id) => byId.has(id))) continue;
    if (channel === 'online' && (!c.online || !ids.every((id) => byId.get(id).online))) continue;
    units.push({
      key: `c${c.id}`,
      tableIds: [...ids].sort((a, b) => a - b),
      min: c.min_covers,
      max: c.max_covers,
      combo: true,
      sort: Math.min(...ids.map((id) => byId.get(id).sort ?? 0)),
    });
  }
  return units;
}

// Tightest fit first: least wasted seats, single tables before combos, fewer
// tables, then the restaurant's own table order.
function rankUnits(units, partySize) {
  return units
    .filter((u) => partySize >= u.min && partySize <= u.max)
    .sort(
      (a, b) =>
        a.max - b.max ||
        Number(a.combo) - Number(b.combo) ||
        a.tableIds.length - b.tableIds.length ||
        a.sort - b.sort ||
        (a.key < b.key ? -1 : 1),
    );
}

function free(tableIds, start, end, occ) {
  for (const id of tableIds) {
    const list = occ.get(id);
    if (!list) continue;
    for (const iv of list) if (start < iv.end && iv.start < end) return false;
  }
  return true;
}

function occupy(occ, tableIds, start, end, resId) {
  for (const id of tableIds) {
    if (!occ.has(id)) occ.set(id, []);
    occ.get(id).push({ start, end, resId });
  }
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// Normalizes the day's reservations into intervals on one minute axis.
// Previous-day reservations that spill past midnight are shifted to negative
// minutes so a 24-hour room never double-books at 1 AM.
function dayIntervals(ctx) {
  const { date, reservations, settings, timezone, nowMs, excludeReservationId } = ctx;
  const buffer = settings.bufferMinutes || 0;
  const prev = addDays(date, -1);
  const isToday = localDate(nowMs, timezone) === date;
  const nowMin = isToday ? localMinutes(nowMs, timezone) : null;
  const tableIds = new Set(ctx.tables.filter((t) => t.active).map((t) => t.id));
  const out = [];
  for (const r of reservations) {
    if (r.id === excludeReservationId) continue;
    let start;
    if (r.date === date) start = r.start_min;
    else if (r.date === prev && r.start_min + r.duration_min > 1440) start = r.start_min - 1440;
    else continue;
    let end = start + r.duration_min + buffer;
    // A party still seated past its planned end keeps the table.
    if (r.status === 'seated' && nowMin != null && nowMin >= start) {
      end = Math.max(end, nowMin + OVERSTAY_MINUTES);
    }
    const tables = (r.table_ids || []).filter((id) => tableIds.has(id));
    out.push({ r, start, end, party: r.party_size, tables, sameDay: r.date === date });
  }
  return out;
}

// Builds table occupancy for the day. Reservations with no usable table
// (imported, or their table was removed) are placed greedily; those that
// cannot be placed are reported as overbooked.
export function planDay(ctx) {
  const staffUnits = buildUnits(ctx.tables, ctx.combos, 'staff');
  const occ = new Map();
  const floating = [];
  const placed = new Map();
  const intervals = dayIntervals(ctx);
  for (const iv of intervals) {
    if (!HOLDING.has(iv.r.status)) continue;
    if (iv.tables.length) {
      occupy(occ, iv.tables, iv.start, iv.end, iv.r.id);
      placed.set(iv.r.id, iv.tables);
    } else {
      floating.push(iv);
    }
  }
  const overbooked = [];
  floating.sort((a, b) => a.start - b.start || b.party - a.party);
  for (const iv of floating) {
    const unit = rankUnits(staffUnits, iv.party).find((u) => free(u.tableIds, iv.start, iv.end, occ));
    if (unit) {
      occupy(occ, unit.tableIds, iv.start, iv.end, iv.r.id);
      placed.set(iv.r.id, unit.tableIds);
    } else {
      overbooked.push(iv.r.id);
    }
  }
  return { occ, intervals, staffUnits, placed, overbooked };
}

function pacingCheck(window, start, partySize, intervals) {
  if (!window || (!window.maxCovers && !window.maxParties)) return { ok: true, covers: 0, parties: 0 };
  let covers = 0;
  let parties = 0;
  for (const iv of intervals) {
    if (!iv.sameDay || !PACED.has(iv.r.status)) continue;
    if (iv.start >= start && iv.start < start + window.interval) {
      covers += iv.party;
      parties += 1;
    }
  }
  const ok =
    (!window.maxCovers || covers + partySize <= window.maxCovers) &&
    (!window.maxParties || parties + 1 <= window.maxParties);
  return { ok, covers, parties };
}

// Re-seats every movable reservation (plus the request) from scratch.
// Pass 1 keeps parties on their current tables where possible so hosts are
// not surprised; pass 2 ignores current tables. Greedy by start time, which
// is optimal for identical tables and a good heuristic for mixed sizes.
function repack(ctx, plan, request) {
  const fixedOcc = new Map();
  const items = [];
  for (const iv of plan.intervals) {
    if (!HOLDING.has(iv.r.status)) continue;
    const tables = iv.tables.length ? iv.tables : plan.placed.get(iv.r.id) || [];
    const movable = MOVABLE.has(iv.r.status) && !iv.r.table_locked && iv.sameDay;
    if (!movable) {
      if (tables.length) occupy(fixedOcc, tables, iv.start, iv.end, iv.r.id);
      continue;
    }
    items.push({
      id: iv.r.id,
      start: iv.start,
      end: iv.end,
      party: iv.party,
      current: tables,
      units: ONLINE_SOURCES.has(iv.r.source) ? ctx.onlineUnits : plan.staffUnits,
    });
  }
  items.push({ id: null, start: request.start, end: request.end, party: request.party, current: [], units: request.units });
  items.sort((a, b) => a.start - b.start || b.party - a.party);

  for (const preferCurrent of [true, false]) {
    const occ = new Map([...fixedOcc].map(([k, v]) => [k, [...v]]));
    const assignment = new Map();
    let ok = true;
    for (const it of items) {
      let tables = null;
      if (preferCurrent && it.current.length && free(it.current, it.start, it.end, occ)) {
        const fits = it.units.some((u) => sameSet(u.tableIds, it.current) && it.party <= u.max);
        if (fits) tables = it.current;
      }
      if (!tables) {
        const unit = rankUnits(it.units, it.party).find((u) => free(u.tableIds, it.start, it.end, occ));
        if (unit) tables = unit.tableIds;
      }
      if (!tables) {
        ok = false;
        break;
      }
      occupy(occ, tables, it.start, it.end, it.id);
      assignment.set(it.id, tables);
    }
    if (ok) {
      const moves = [];
      for (const it of items) {
        if (it.id == null) continue;
        const next = assignment.get(it.id);
        if (!sameSet(next, it.current)) moves.push({ reservationId: it.id, tableIds: next });
      }
      return { tableIds: assignment.get(null), moves };
    }
  }
  return null;
}

// Finds seating for one party at one start time. Returns
// { tableIds, moves } or null. `moves` lists other reservations that must be
// re-seated to make room (empty when a free unit exists).
export function findSeating(ctx, plan, start, partySize, duration) {
  const end = start + duration + (ctx.settings.bufferMinutes || 0);
  const units = ctx.channel === 'online' ? ctx.onlineUnits : plan.staffUnits;
  const unit = rankUnits(units, partySize).find((u) => free(u.tableIds, start, end, plan.occ));
  if (unit) return { tableIds: unit.tableIds, moves: [] };
  if (ctx.settings.autoOptimize === false) return null;
  return repack(ctx, plan, { start, end, party: partySize, units });
}

function prepare(ctx) {
  const channel = ctx.channel || 'online';
  return { ...ctx, channel, onlineUnits: buildUnits(ctx.tables, ctx.combos, 'online') };
}

// Online-only gates that do not depend on the time of day.
function onlineGate(ctx) {
  const { date, partySize, settings, timezone, nowMs } = ctx;
  if (partySize < (settings.minPartySize || 1)) {
    return { message: `Online booking starts at ${settings.minPartySize} guests.` };
  }
  if (partySize > settings.maxPartySize) {
    const msg = settings.largePartyMessage || 'For larger parties, please call us.';
    return { message: msg.replace('{max}', String(settings.maxPartySize)), largeParty: true };
  }
  const ahead = daysBetween(localDate(nowMs, timezone), date);
  if (ahead < 0) return { closed: true, message: 'That date has passed.' };
  if (ahead > settings.bookingWindowDays) {
    return { closed: true, message: `Reservations open ${settings.bookingWindowDays} days ahead.` };
  }
  return null;
}

// One start time, fully evaluated. Online: notice and pacing block.
// Staff: they become warnings; only a missing table blocks.
function evaluateSlot(ctx, plan, window, t, duration) {
  const { date, partySize, settings, timezone, nowMs, channel } = ctx;
  const slot = { time: t, shiftId: window?.shiftId ?? null, shift: window?.name ?? null, available: false, reason: null, warnings: [] };
  const startsAt = zonedToUtc(date, t, timezone);
  const noticeMs = (settings.minNoticeMinutes || 0) * 60000;
  if (startsAt < nowMs + noticeMs) {
    if (channel === 'online') {
      slot.reason = startsAt < nowMs ? 'past' : 'too_soon';
      return slot;
    }
    if (startsAt < nowMs) slot.warnings.push('past');
  }
  if (!pacingCheck(window, t, partySize, plan.intervals).ok) {
    if (channel === 'online') {
      slot.reason = 'pacing';
      return slot;
    }
    slot.warnings.push('pacing');
  }
  const seating = findSeating(ctx, plan, t, partySize, duration);
  if (!seating) {
    slot.reason = 'full';
    return slot;
  }
  slot.available = true;
  slot.seating = seating;
  return slot;
}

// Slots for one date and party size.
//   channel 'online': enforces party limits, booking window, notice, pacing.
//   channel 'staff':  everything is bookable if a table exists; pacing and
//                     notice become warnings, never blocks.
export function computeAvailability(input) {
  const ctx = prepare(input);
  const { partySize, settings, channel } = ctx;
  const result = { date: ctx.date, partySize, closed: false, message: '', duration: 0, slots: [] };

  if (channel === 'online') {
    const gate = onlineGate(ctx);
    if (gate) return { ...result, ...gate };
  }
  const sw = serviceWindows(ctx);
  if (sw.closed) return { ...result, closed: true, message: sw.note || 'Closed' };
  result.message = sw.note || '';

  const duration = turnTimeFor(settings, partySize);
  result.duration = duration;
  const plan = planDay(ctx);
  result.overbooked = plan.overbooked;
  const seen = new Set();
  for (const w of sw.windows) {
    for (let t = w.start; t <= w.lastSeating; t += w.interval) {
      if (seen.has(t)) continue;
      seen.add(t);
      const { seating, ...slot } = evaluateSlot(ctx, plan, w, t, duration);
      if (seating && channel !== 'online') {
        slot.tableIds = seating.tableIds;
        slot.moves = seating.moves.length;
      }
      result.slots.push(slot);
    }
  }
  return result;
}

// Decides whether a specific time can be booked and how to seat it. Called at
// write time inside a transaction, so two diners cannot get the same table.
// Online bookings must land on the published grid; staff may book any minute
// (a walk-in at 6:07) and even on a closed day.
export function resolveBooking(input) {
  const ctx = prepare(input);
  const { time, partySize, settings, channel } = ctx;
  const duration = ctx.duration || turnTimeFor(settings, partySize);
  let window = null;

  if (channel === 'online') {
    const gate = onlineGate(ctx);
    if (gate) return { ok: false, reason: gate.largeParty ? 'party_size' : 'unavailable', message: gate.message };
    const sw = serviceWindows(ctx);
    window = sw.windows.find((w) => time >= w.start && time <= w.lastSeating && (time - w.start) % w.interval === 0);
    if (!window) return { ok: false, reason: 'not_a_slot', message: 'That time is not bookable.' };
  } else {
    const sw = serviceWindows(ctx);
    window = sw.windows.find((w) => time >= w.start && time < w.lastSeating + w.interval) || null;
  }

  const plan = planDay(ctx);
  const slot = evaluateSlot(ctx, plan, window, time, duration);
  if (slot.available) {
    return { ok: true, duration, tableIds: slot.seating.tableIds, moves: slot.seating.moves, warnings: slot.warnings };
  }
  if (channel === 'staff' && ctx.allowUnassigned && slot.reason === 'full') {
    return { ok: true, duration, tableIds: [], moves: [], warnings: [...slot.warnings, 'no_table'] };
  }
  return { ok: false, reason: slot.reason || 'full', message: REASON_TEXT[slot.reason] || 'That time is no longer available.' };
}

const REASON_TEXT = {
  past: 'That time has passed.',
  too_soon: 'That time is too soon to book online. Please call us.',
  pacing: 'That time just filled up. Please pick another.',
  full: 'That time just filled up. Please pick another.',
};

// Checks whether specific tables are free for a party (manual assignment).
export function tablesFree(input, tableIds, start, duration) {
  const ctx = prepare({ ...input, channel: 'staff' });
  const plan = planDay(ctx);
  const end = start + duration + (ctx.settings.bufferMinutes || 0);
  const conflicts = [];
  for (const id of tableIds) {
    for (const iv of plan.occ.get(id) || []) {
      if (start < iv.end && iv.start < end) conflicts.push(iv.resId);
    }
  }
  return { free: conflicts.length === 0, conflicts: [...new Set(conflicts)] };
}

// Scans forward for the first dates with any open slot (diner UX:
// "Fully booked tonight. Next available: Thu 6:30 PM").
export function nextAvailable(loadContext, { fromDate, partySize, days = 14, limit = 3 }) {
  const found = [];
  for (let i = 0; i < days && found.length < limit; i++) {
    const date = addDays(fromDate, i);
    const ctx = loadContext(date);
    const result = computeAvailability({ ...ctx, date, partySize });
    const open = result.slots.filter((s) => s.available).map((s) => s.time);
    if (open.length) found.push({ date, times: open.slice(0, 6) });
    if (result.largeParty) break;
  }
  return found;
}
