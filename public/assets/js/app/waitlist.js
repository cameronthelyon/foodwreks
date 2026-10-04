// Walk-in waitlist: add with an automatic quote, text when ready, seat.
// Always the current service day, whatever date the book is showing: this
// view loads its own copy of today's floor and never moves state.date.

import { clear, debounce, fmtPhone, h, modal, toast, toastError } from '../lib.js';
import { emit, on, rApi, state, today } from './state.js';
import { go } from './nav.js';

let live = null; // today's /day payload: tables, reservations, waitlist

// After any change here: this view and the nav badge both re-fetch (live
// events do the same for changes made on other devices).
const announce = () => emit('waitlist-changed', today());

export function render(root) {
  const list = h('div', { id: 'wl-list' });
  let request = 0;
  const reload = debounce(async () => {
    const mine = ++request;
    try {
      const data = await rApi(`/day/${today()}`);
      if (mine !== request) return;
      live = data;
      paintList(list);
    } catch (err) {
      toastError(err);
    }
  }, 150);
  clear(root, h('div', { class: 'panel' }, h('h3', {}, 'Add a party'), addForm()), list);
  live = state.day?.date === today() ? state.day : null;
  if (live) paintList(list);
  reload();
  const offs = [
    on('waitlist-changed', (e) => (!e.detail || e.detail === today()) && reload()),
    // The book is on today too: reuse its fresh copy (it follows reservation events).
    on('day', () => {
      if (state.day?.date !== today()) return;
      live = state.day;
      paintList(list);
    }),
  ];
  // Re-fetch, not just repaint: the 4 AM turnover and missed events both land here.
  const tick = setInterval(reload, 30_000);
  return () => {
    offs.forEach((off) => off());
    clearInterval(tick);
    request++;
  };
}

function addForm() {
  const smsReady = Boolean(state.restaurant.messaging.sms);
  const quote = h('input', { type: 'number', name: 'quotedMin', min: 0, max: 600, step: 5, placeholder: 'auto' });
  let manualQuote = false;
  quote.addEventListener('input', () => (manualQuote = true));
  const party = h('input', { type: 'number', name: 'partySize', min: 1, max: 100, value: 2, required: true });
  const estimate = debounce(async () => {
    if (manualQuote) return;
    try {
      const res = await rApi(`/waitlist/estimate?party=${Number(party.value) || 2}`);
      quote.value = res.quotedMin ?? '';
      quote.placeholder = res.quotedMin == null ? 'no fitting table' : 'auto';
    } catch {
      /* leave blank */
    }
  }, 200);
  party.addEventListener('input', estimate);
  estimate();
  const form = h(
    'form',
    { class: 'wl-add' },
    h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { name: 'name', required: true, autocomplete: 'off' })),
    h('label', { class: 'field' }, h('span', {}, 'Party'), party),
    h('label', { class: 'field' }, h('span', {}, smsReady ? 'Mobile (for the text)' : 'Phone'), h('input', { type: 'tel', name: 'phone', autocomplete: 'off' })),
    h('label', { class: 'field' }, h('span', {}, 'Quote (min)'), quote),
    h('label', { class: 'field' }, h('span', {}, 'Notes'), h('input', { name: 'notes', placeholder: 'Booth, stroller…' })),
    h('button', { type: 'submit', class: 'btn primary' }, 'Add'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    try {
      await rApi('/waitlist', {
        method: 'POST',
        body: { name: f.name.value, partySize: Number(f.partySize.value), phone: f.phone.value || undefined, quotedMin: f.quotedMin.value === '' ? undefined : Number(f.quotedMin.value), notes: f.notes.value },
      });
      form.reset();
      manualQuote = false;
      party.value = 2;
      estimate();
      f.name.focus();
      announce();
    } catch (err) {
      toastError(err);
    }
  });
  return form;
}

function paintList(root) {
  if (!root.isConnected || !live) return;
  const entries = live.waitlist;
  const open = entries.filter((w) => ['waiting', 'notified'].includes(w.status));
  const closed = entries.filter((w) => !['waiting', 'notified'].includes(w.status));
  const smsReady = Boolean(state.restaurant.messaging.sms);
  clear(
    root,
    !smsReady ? h('p', { class: 'notice' }, 'Texting is not set up on this server, so "table ready" messages cannot be sent. Call or wave guests in instead.') : null,
    open.length ? open.map((w, i) => entry(w, i + 1, smsReady)) : h('div', { class: 'empty' }, h('strong', {}, 'Nobody waiting.'), 'Add walk-ins above. Quotes come from your live floor.'),
    closed.length ? h('details', { style: { marginTop: '18px' } }, h('summary', {}, `Earlier today (${closed.length})`), closed.map((w) => entry(w, null, smsReady))) : null,
  );
}

function entry(w, position, smsReady) {
  const waited = Math.max(0, Math.round((Date.now() - w.createdAt) / 60000));
  const over = w.quotedMin && waited > w.quotedMin;
  const statusChip = {
    waiting: null,
    notified: h('span', { class: 'chip ok' }, 'Texted'),
    seated: h('span', { class: 'chip' }, 'Seated'),
    left: h('span', { class: 'chip danger' }, 'Left'),
    cancelled: h('span', { class: 'chip danger' }, 'Cancelled'),
  }[w.status];
  const act = async (path, body = {}) => {
    try {
      await rApi(`/waitlist/${w.id}/${path}`, { method: 'POST', body });
      announce();
    } catch (err) {
      toastError(err);
    }
  };
  return h(
    'div',
    { class: 'wl-row' },
    h('div', { class: 'pos' }, position ? String(position) : ''),
    h(
      'div',
      {},
      h('div', { class: 'row', style: { gap: '6px' } }, h('b', {}, `${w.name} · ${w.partySize}`), statusChip, w.source === 'online' ? h('span', { class: 'chip info' }, 'Joined online') : null),
      h(
        'div',
        { class: 'small muted' },
        ['waiting', 'notified'].includes(w.status) ? h('span', { class: over ? 'late' : '' }, `Waiting ${waited} min`) : null,
        w.quotedMin ? ` · quoted ${w.quotedMin}` : '',
        w.phone ? ` · ${fmtPhone(w.phone)}` : '',
        w.notes ? ` · ${w.notes}` : '',
      ),
    ),
    h(
      'div',
      { class: 'row', style: { gap: '6px' } },
      ['waiting', 'notified'].includes(w.status)
        ? [
            smsReady && w.phone ? h('button', { class: 'btn small', onclick: () => act('notify').then(() => toast('Text queued', 'ok')) }, w.status === 'notified' ? 'Text again' : 'Text: ready') : null,
            h('button', { class: 'btn small primary', onclick: () => seat(w) }, 'Seat'),
            h('button', { class: 'btn small danger', onclick: () => act('remove', { status: 'left' }) }, 'Left'),
          ]
        : w.status === 'seated' && w.reservationId
          ? h('button', { class: 'btn small ghost', onclick: () => go('book', live.date) }, 'View')
          : h('button', { class: 'btn small ghost', onclick: () => act('remove', { status: 'waiting' }) }, 'Restore'),
    ),
  );
}

function seat(w) {
  const tables = live.tables.filter((t) => t.active && w.partySize <= t.max_covers);
  const busy = new Set(live.reservations.filter((r) => r.status === 'seated').flatMap((r) => r.tableIds));
  const select = h(
    'select',
    { name: 'table' },
    h('option', { value: '' }, 'Best fit (automatic)'),
    tables.map((t) => h('option', { value: t.id }, `${t.name} (${t.min_covers}-${t.max_covers})${busy.has(t.id) ? ' · occupied' : ''}`)),
  );
  modal({
    title: `Seat ${w.name}, party of ${w.partySize}`,
    initialFocus: 'select',
    body: h('label', { class: 'field' }, h('span', {}, 'Table'), select),
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Seat now',
        primary: true,
        onClick: async ({ close }) => {
          try {
            await rApi(`/waitlist/${w.id}/seat`, { method: 'POST', body: { tableIds: select.value ? [Number(select.value)] : [] } });
            close();
            toast(`${w.name} seated`, 'ok');
            announce();
          } catch (err) {
            toastError(err);
          }
        },
      },
    ],
  });
}
