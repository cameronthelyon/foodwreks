// Floor timeline: tables down the side, time across. Drag a party sideways
// to change its time, up or down to move tables; tap an empty slot to book.

import { clear, confirmDialog, fmt12, h, nowMinutesIn, toast, toastError } from '../lib.js';
import { HOLDING, loadDay, on, rApi, state } from './state.js';
import { newReservation, openReservation } from './reservation.js';

const SLOT_W = 30; // px per 15 minutes
const LABEL_W = 96;
const SHOWN = new Set(['pending', 'booked', 'confirmed', 'arrived', 'seated', 'completed']);

export function render(root) {
  const draw = () => paint(root);
  const off = on('day', draw);
  const tick = setInterval(() => {
    if (!document.querySelector('.tl-block.dragging')) draw();
  }, 60_000);
  if (state.day?.date === state.date) draw();
  else clear(root, h('p', { class: 'muted' }, 'Loading the floor…'));
  return () => {
    off();
    clearInterval(tick);
  };
}

function range(day) {
  const times = [];
  for (const w of day.windows) times.push(w.start, w.lastSeating + 150);
  for (const r of day.reservations) if (SHOWN.has(r.status)) times.push(r.time, r.time + r.duration);
  if (!times.length) times.push(17 * 60, 23 * 60);
  const start = Math.floor((Math.min(...times) - 30) / 60) * 60;
  const end = Math.ceil(Math.max(...times) / 60) * 60;
  return { start: Math.max(0, start), end: Math.max(end, start + 240) };
}

function paint(root) {
  const day = state.day;
  if (!day) return;
  const scrollEl = root.querySelector('.timeline');
  const keep = scrollEl ? { left: scrollEl.scrollLeft, top: scrollEl.scrollTop } : null;
  const { start, end } = range(day);
  const width = ((end - start) / 15) * SLOT_W;
  const x = (min) => ((min - start) / 15) * SLOT_W;
  const isToday = day.date === state.restaurant.today;
  const visible = day.reservations.filter((r) => SHOWN.has(r.status));
  const usedTables = new Set(visible.flatMap((r) => r.tableIds));
  const tables = day.tables.filter((t) => t.active || usedTables.has(t.id));
  const sections = [];
  for (const t of tables) {
    let s = sections.find((x2) => x2.name === (t.section || ''));
    if (!s) sections.push((s = { name: t.section || '', tables: [] }));
    s.tables.push(t);
  }
  const unassigned = visible.filter((r) => !r.tableIds.length && r.status !== 'completed');

  // One labelled tick per hour; the lanes draw the quarter-hour grid.
  const ticks = [];
  for (let m = start; m < end; m += 60) {
    ticks.push(h('div', { class: 'tl-tick hour', style: { width: `${SLOT_W * 4}px` } }, fmt12(m).replace(':00', '')));
  }

  const lane = (tableId, blocks) => {
    const el = h('div', { class: 'tl-lane', style: { width: `${width}px`, backgroundSize: `${SLOT_W}px 100%` } }, blocks);
    el.addEventListener('click', (e) => {
      if (e.target !== el) return;
      const time = start + Math.floor(e.offsetX / SLOT_W) * 15;
      newReservation({ date: day.date, time, tableIds: tableId ? [tableId] : undefined });
    });
    return el;
  };

  const block = (r, laneTableId) => {
    const el = h(
      'div',
      {
        class: `tl-block status-${r.status} ${laneTableId === null ? 'unplaced' : ''}`,
        style: { left: `${x(r.time)}px`, width: `${Math.max(SLOT_W, (r.duration / 15) * SLOT_W - 3)}px` },
        title: `${r.name}, ${r.partySize} · ${fmt12(r.time)} · ${r.duration} min${r.guestNotes ? ` · ${r.guestNotes}` : ''}`,
        tabindex: '0',
        role: 'button',
        onkeydown: (e) => e.key === 'Enter' && openReservation(r.id),
      },
      h('b', {}, `${r.name.split(' ').slice(-1)[0] || r.name} · ${r.partySize}`),
      h('span', {}, `${fmt12(r.time)}${r.guest?.tags?.length ? ` · ${r.guest.tags[0]}` : ''}`),
    );
    attachDrag(el, r, laneTableId, root);
    return el;
  };

  const rows = [];
  if (unassigned.length) {
    rows.push(h('div', { class: 'tl-section' }, 'Needs a table'));
    rows.push(h('div', { class: 'tl-row', dataset: { tableId: '' } }, h('div', { class: 'tl-label', style: { width: `${LABEL_W}px` } }, 'Unassigned'), lane(null, unassigned.map((r) => block(r, null)))));
  }
  for (const s of sections) {
    if (s.name) rows.push(h('div', { class: 'tl-section' }, s.name));
    for (const t of s.tables) {
      const blocks = visible.filter((r) => r.tableIds.includes(t.id)).map((r) => block(r, t.id));
      rows.push(
        h(
          'div',
          { class: 'tl-row', dataset: { tableId: String(t.id) } },
          h('div', { class: 'tl-label', style: { width: `${LABEL_W}px` } }, t.name, h('small', {}, `${t.min_covers}-${t.max_covers}${t.online ? '' : ' · walk-in'}${t.active ? '' : ' · retired'}`)),
          lane(t.id, blocks),
        ),
      );
    }
  }

  const nowMin = isToday ? nowMinutesIn(state.restaurant.timezone) : null;
  const timeline = h(
    'div',
    { class: 'timeline' },
    h(
      'div',
      { class: 'tl-inner', style: { width: `${width + LABEL_W}px` } },
      h('div', { class: 'tl-axis' }, h('div', { class: 'tl-corner', style: { width: `${LABEL_W}px` } }), ticks),
      rows,
      nowMin !== null && nowMin >= start && nowMin <= end ? h('div', { class: 'tl-now', style: { left: `${LABEL_W + x(nowMin)}px` } }) : null,
    ),
  );

  clear(
    root,
    h(
      'div',
      { class: 'legend' },
      [
        ['booked', 'Booked'],
        ['confirmed', 'Confirmed'],
        ['arrived', 'Arrived'],
        ['seated', 'Seated'],
        ['completed', 'Done'],
      ].map(([s, label]) => h('span', {}, h('i', { class: `tl-swatch status-${s}` }), label)),
      h('span', { class: 'spacer' }),
      h('span', {}, 'Drag to move · tap an empty slot to book'),
    ),
    tables.length ? timeline : h('div', { class: 'empty' }, h('strong', {}, 'No tables yet.'), h('a', { class: 'btn primary', href: '#/settings/floor' }, 'Set up your floor')),
  );
  const fresh = root.querySelector('.timeline');
  if (fresh) {
    if (keep) {
      fresh.scrollLeft = keep.left;
      fresh.scrollTop = keep.top;
    } else if (nowMin !== null) fresh.scrollLeft = Math.max(0, x(nowMin) - 200);
  }
}

function rowAt(xPos, yPos) {
  return document.elementsFromPoint(xPos, yPos).find((el) => el.classList?.contains('tl-row')) || null;
}

function attachDrag(el, r, laneTableId, root) {
  const movable = HOLDING.has(r.status);
  const multi = r.tableIds.length > 1;
  el.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    const sx = down.clientX;
    const sy = down.clientY;
    let moved = false;
    let target = null;
    el.setPointerCapture(down.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      if (!movable) return;
      moved = true;
      el.classList.add('dragging');
      el.style.transform = `translate(${Math.round(dx / SLOT_W) * SLOT_W}px, ${multi ? 0 : dy}px)`;
      const row = multi ? null : rowAt(ev.clientX, ev.clientY);
      if (row !== target) {
        target?.classList.remove('drop');
        target = row;
        target?.classList.add('drop');
      }
    };
    const up = async (ev) => {
      el.releasePointerCapture(down.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      target?.classList.remove('drop');
      if (!moved) return openReservation(r.id);
      const dSlots = Math.round((ev.clientX - sx) / SLOT_W);
      const patch = { notify: false };
      if (dSlots) patch.time = r.time + dSlots * 15;
      const tid = target?.dataset.tableId ? Number(target.dataset.tableId) : null;
      if (!multi && tid && tid !== laneTableId) patch.tableIds = [tid];
      if (patch.time === undefined && !patch.tableIds) {
        el.classList.remove('dragging');
        el.style.transform = '';
        return;
      }
      await save(r, patch);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

async function save(r, patch) {
  try {
    const res = await rApi(`/reservations/${r.id}`, { method: 'PATCH', body: patch });
    const v = res.reservation;
    toast(`${v.name}: ${fmt12(v.time)}${patch.tableIds ? `, moved tables` : ''}${patch.time !== undefined ? ' (guest not notified)' : ''}`, 'ok');
  } catch (err) {
    if (err.code === 'table_conflict' && (await confirmDialog('That table is taken then. Double-book it anyway?', { title: 'Table conflict', confirmLabel: 'Double-book' }))) {
      return save(r, { ...patch, force: true });
    }
    toastError(err);
  }
  await loadDay();
}
