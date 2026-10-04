// Diner's manage page: view, change, cancel, add a card, add to calendar.

import { $, addDays, api, applyTheme, clear, confirmDialog, fmtDate, h, toast, toastError, todayIn } from './lib.js';

applyTheme();
const code = location.pathname.split('/').pop();
const params = new URLSearchParams(location.search);
const token = params.get('t');
if (params.get('embed') === '1') document.body.classList.add('embed');
const app = $('#app');
let info = null;

const STATUS = {
  pending: ['Waiting for card', 'violet'],
  booked: ['Confirmed', 'ok'],
  confirmed: ['Confirmed', 'ok'],
  arrived: ['Checked in', 'info'],
  seated: ['Seated', 'info'],
  completed: ['Completed', ''],
  cancelled: ['Cancelled', 'danger'],
  no_show: ['Missed', 'danger'],
};

async function load() {
  try {
    info = await api(`/api/public/m/${encodeURIComponent(code)}?t=${encodeURIComponent(token || '')}`);
    if (info.restaurant.brandColor) document.body.style.setProperty('--brand', info.restaurant.brandColor);
    render();
  } catch (err) {
    clear(app, h('div', { class: 'empty-state' }, h('strong', {}, 'We could not find that reservation.'), h('p', {}, err.message)));
  }
}

function render() {
  const { reservation: v, restaurant: r } = info;
  $('#r-name').textContent = r.name;
  clear($('#r-meta'), [r.address, r.city].filter(Boolean).join(', '), r.phone ? [' · ', h('a', { href: `tel:${r.phone}` }, r.phone)] : null);
  const [label, tone] = STATUS[v.status] || [v.status, ''];
  const banner =
    params.get('card') === 'ok'
      ? h('p', { class: 'notice ok' }, 'Card saved. Your table is confirmed.')
      : params.get('card') === 'cancelled' && v.status === 'pending'
        ? h('p', { class: 'notice warn' }, 'The card step was not finished. Your table is held for a few more minutes.')
        : null;
  clear(
    app,
    banner,
    h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, `${v.partySize} ${v.partySize === 1 ? 'guest' : 'guests'}`), h('span', { class: `chip ${tone}` }, label)),
    h(
      'div',
      { class: 'confirm' },
      h(
        'div',
        { class: 'details' },
        h('div', {}, h('span', {}, 'When'), h('span', {}, `${fmtDate(v.displayDate || v.date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${v.timeLabel}`)),
        h('div', {}, h('span', {}, 'Name'), h('span', {}, v.name)),
        v.notes ? h('div', {}, h('span', {}, 'Notes'), h('span', {}, v.notes)) : null,
        h('div', {}, h('span', {}, 'Confirmation'), h('span', { class: 'code' }, v.code)),
      ),
    ),
    r.policyText ? h('div', { class: 'policy' }, r.policyText) : null,
    h(
      'div',
      { class: 'row' },
      v.status === 'pending' ? h('button', { class: 'btn brand', onclick: addCard }, 'Add a card to confirm') : null,
      ['booked', 'confirmed'].includes(v.status) ? h('a', { class: 'btn', href: info.calendarUrl }, 'Add to calendar') : null,
      info.canChange ? h('button', { class: 'btn', onclick: renderChange }, 'Change') : null,
      info.canCancel ? h('button', { class: 'btn danger', onclick: cancel }, 'Cancel reservation') : null,
    ),
    !info.canChange && ['booked', 'confirmed'].includes(v.status)
      ? h('p', { class: 'small muted', style: { marginTop: '12px' } }, `Changes within ${Math.round(info.cancelCutoffMinutes / 60)} hours of your reservation need a phone call${r.phone ? `: ${r.phone}` : ''}.`)
      : null,
    v.status === 'cancelled' ? h('p', { style: { marginTop: '12px' } }, h('a', { href: `/r/${r.slug}` }, 'Book another time')) : null,
  );
}

async function addCard(e) {
  e.target.disabled = true;
  try {
    const res = await api(`/api/public/m/${encodeURIComponent(code)}/card?t=${encodeURIComponent(token)}`, { method: 'POST', body: {} });
    location.href = res.checkoutUrl;
  } catch (err) {
    e.target.disabled = false;
    toastError(err);
  }
}

async function cancel() {
  const ok = await confirmDialog('Cancel this reservation? The table goes back to other guests.', { title: 'Cancel reservation', confirmLabel: 'Yes, cancel', danger: true });
  if (!ok) return;
  try {
    info = await api(`/api/public/m/${encodeURIComponent(code)}/cancel?t=${encodeURIComponent(token)}`, { method: 'POST', body: {} });
    toast('Reservation cancelled', 'ok');
    render();
  } catch (err) {
    toastError(err);
  }
}

function renderChange() {
  const { reservation: v, restaurant: r } = info;
  const state = { date: v.date, party: v.partySize };
  const timesEl = h('div', { id: 'times' });
  const today = todayIn(r.timezone);
  const loadTimes = async () => {
    clear(timesEl, h('p', { class: 'muted' }, 'Checking tables…'));
    try {
      const data = await api(
        `/api/public/r/${encodeURIComponent(r.slug)}/availability?date=${state.date}&party=${state.party}&code=${encodeURIComponent(code)}&t=${encodeURIComponent(token)}`,
      );
      const open = data.slots.filter((s) => s.available);
      clear(
        timesEl,
        open.length
          ? h('div', { class: 'times' }, open.map((s) => h('button', { type: 'button', class: 'time', 'aria-pressed': String(s.time === v.time && state.date === v.date), onclick: () => save(s.time) }, s.label)))
          : h('div', { class: 'empty-state' }, h('strong', {}, data.message || 'No tables for that party size.'), r.phone ? h('p', {}, `Call ${r.phone} and we will try to help.`) : null),
      );
    } catch (err) {
      clear(timesEl, h('p', { class: 'notice danger' }, err.message));
    }
  };
  const save = async (time) => {
    try {
      info = await api(`/api/public/m/${encodeURIComponent(code)}/modify?t=${encodeURIComponent(token)}`, { method: 'POST', body: { date: state.date, time, partySize: state.party } });
      toast('Reservation updated', 'ok');
      render();
    } catch (err) {
      toastError(err);
      loadTimes();
    }
  };
  clear(
    app,
    h('h2', { class: 'step-title' }, 'Party size'),
    h('input', { type: 'number', 'aria-label': 'Party size', min: r.minPartySize, max: r.maxPartySize, value: state.party, style: { maxWidth: '120px' }, onchange: (e) => ((state.party = Number(e.target.value)), loadTimes()) }),
    h('h2', { class: 'step-title' }, 'Date'),
    h('input', { type: 'date', 'aria-label': 'Date', min: today, max: addDays(today, r.bookingWindowDays), value: state.date, style: { maxWidth: '200px' }, onchange: (e) => e.target.value && ((state.date = e.target.value), loadTimes()) }),
    h('h2', { class: 'step-title' }, 'Pick a new time'),
    timesEl,
    h('p', { style: { marginTop: '16px' } }, h('button', { class: 'btn ghost', onclick: render }, 'Keep my reservation as is')),
  );
  loadTimes();
}

load();
