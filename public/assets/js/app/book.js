// "The book": tonight's reservations as a list grouped by time, with
// one-tap status changes and a pacing strip.

import { clear, fmt12, fmtPhone, h, nowMinutesIn } from '../lib.js';
import { on, SOURCE, state, tableNames } from './state.js';
import { changeStatus, guestFlags, newReservation, nextActions, openReservation, statusChip } from './reservation.js';

let filter = null;

const FILTERS = {
  upcoming: { label: 'Upcoming', test: (r) => ['pending', 'booked', 'confirmed', 'arrived'].includes(r.status) },
  seated: { label: 'Seated', test: (r) => r.status === 'seated' },
  done: { label: 'Done', test: (r) => r.status === 'completed' },
  all: { label: 'All active', test: (r) => !['cancelled', 'no_show'].includes(r.status) },
  gone: { label: 'Cancelled & no-shows', test: (r) => ['cancelled', 'no_show'].includes(r.status) },
};

export function render(root) {
  const draw = () => paint(root);
  const off = on('day', draw);
  const tick = setInterval(draw, 60_000);
  if (state.day?.date === state.date) draw();
  else clear(root, h('p', { class: 'muted' }, 'Loading the book…'));
  return () => {
    off();
    clearInterval(tick);
  };
}

function paint(root) {
  const day = state.day;
  if (!day) return;
  const isToday = day.date === state.restaurant.today;
  const nowMin = isToday ? nowMinutesIn(state.restaurant.timezone) : null;
  if (!filter) filter = isToday ? 'upcoming' : 'all';
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, day.reservations.filter(f.test).length]));
  const list = day.reservations.filter(FILTERS[filter].test);
  const waiting = day.waitlist.filter((w) => ['waiting', 'notified'].includes(w.status)).length;
  const unassigned = day.reservations.filter((r) => !r.tableIds.length && !['cancelled', 'no_show', 'completed'].includes(r.status)).length;

  const groups = new Map();
  for (const r of list) {
    if (!groups.has(r.time)) groups.set(r.time, []);
    groups.get(r.time).push(r);
  }

  clear(
    root,
    day.closure?.closed
      ? h('div', { class: 'notice warn' }, `Closed: ${day.closure.note || 'no service'}. You can still add bookings by hand.`)
      : !day.windows.length
        ? h('div', { class: 'notice' }, 'No service hours on this day, so online booking is closed. You can still add bookings by hand.')
        : null,
    h(
      'div',
      { class: 'statbar' },
      stat(day.stats.covers, 'covers booked'),
      stat(day.stats.parties, 'parties'),
      stat(day.stats.seated, 'covers seated'),
      day.stats.noShows ? stat(day.stats.noShows, 'no-shows') : null,
      waiting ? stat(waiting, 'waiting') : null,
      unassigned ? h('div', { class: 'stat', style: { borderColor: 'var(--warn)' } }, h('b', {}, String(unassigned)), h('span', {}, 'without a table')) : null,
    ),
    pacingStrip(day),
    h(
      'div',
      { class: 'tabs', role: 'group', 'aria-label': 'Filter' },
      Object.entries(FILTERS).map(([k, f]) => h('button', { 'aria-pressed': String(filter === k), onclick: () => ((filter = k), paint(root)) }, `${f.label} ${counts[k]}`)),
    ),
    list.length
      ? [...groups.entries()].map(([time, rows]) =>
          h(
            'section',
            { class: 'slot-group' },
            h('div', { class: 'slot-head' }, h('b', {}, fmt12(time)), `${rows.length} ${rows.length === 1 ? 'party' : 'parties'} · ${rows.reduce((a, r) => a + r.partySize, 0)} covers`),
            rows.map((r) => row(r, nowMin)),
          ),
        )
      : h(
          'div',
          { class: 'empty' },
          h('strong', {}, day.reservations.length ? 'Nothing in this view.' : 'No reservations yet for this day.'),
          h('button', { class: 'btn primary', onclick: () => newReservation({ date: state.date }) }, 'Add a reservation'),
        ),
  );
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', {}, String(value)), h('span', {}, label));
}

function row(r, nowMin) {
  const late = nowMin !== null && ['booked', 'confirmed'].includes(r.status) && nowMin - r.time > 15;
  const actions = nextActions(r);
  return h(
    'div',
    { class: `res-row status-${r.status} ${['completed', 'cancelled', 'no_show'].includes(r.status) ? 'dim' : ''}`, onclick: () => openReservation(r.id), role: 'button', tabindex: '0', onkeydown: (e) => e.key === 'Enter' && openReservation(r.id) },
    h('div', { class: 'party', title: `Party of ${r.partySize}` }, String(r.partySize)),
    h(
      'div',
      { class: 'who' },
      h('div', { class: 'name' }, r.name, guestFlags(r), late ? h('span', { class: 'chip danger' }, `${nowMin - r.time} min late`) : null),
      h(
        'div',
        { class: 'meta' },
        h('span', {}, `${fmt12(r.time)} · ${r.tableIds.length ? `Table ${tableNames(r.tableIds)}` : 'No table'}`),
        h('span', {}, SOURCE[r.source] || r.source),
        r.phone ? h('span', {}, fmtPhone(r.phone)) : null,
        r.guestNotes ? h('span', { class: 'note' }, `“${r.guestNotes.slice(0, 80)}”`) : null,
        r.staffNotes ? h('span', {}, `Staff: ${r.staffNotes.slice(0, 60)}`) : null,
        r.card?.status === 'on_file' ? h('span', {}, 'Card on file') : null,
      ),
    ),
    h(
      'div',
      { class: 'actions', onclick: (e) => e.stopPropagation() },
      statusChip(r.status),
      actions.map(([s, label]) => h('button', { class: `btn small ${s === 'seated' || s === 'completed' ? 'primary' : ''}`, onclick: () => changeStatus(r, s) }, label)),
      late ? h('button', { class: 'btn small danger', onclick: () => changeStatus(r, 'no_show') }, 'No-show') : null,
    ),
  );
}

// Covers starting in each slot vs the shift's pacing limit.
function pacingStrip(day) {
  const windows = day.windows || [];
  if (!windows.length) return null;
  const bars = [];
  const active = day.reservations.filter((r) => !['cancelled', 'no_show'].includes(r.status));
  for (const w of windows) {
    for (let t = w.start; t <= w.lastSeating; t += w.interval) {
      const covers = active.filter((r) => r.time >= t && r.time < t + w.interval).reduce((a, r) => a + r.partySize, 0);
      bars.push({ t, covers, limit: w.maxCovers });
    }
  }
  const max = Math.max(1, ...bars.map((b) => Math.max(b.covers, b.limit || 0)));
  return h(
    'div',
    { class: 'pacing', 'aria-label': 'Covers starting in each time slot' },
    bars.map((b) =>
      h('div', {
        class: `bar ${b.covers === 0 ? 'zero' : ''} ${b.limit && b.covers > b.limit ? 'over' : ''}`,
        style: { height: `${Math.max(3, (b.covers / max) * 44)}px` },
        title: `${fmt12(b.t)}: ${b.covers} covers${b.limit ? ` (limit ${b.limit})` : ''}`,
      }),
    ),
  );
}
