// Public booking page: party -> date -> time -> details -> confirmed.

import { $, addDays, api, applyTheme, clear, fmt12, fmtDate, h, parseHHMM, toastError } from './lib.js';

applyTheme();
const params = new URLSearchParams(location.search);
const embed = params.get('embed') === '1';
if (embed) document.body.classList.add('embed');
const slug = document.body.dataset.slug;
const SOURCES = ['google', 'instagram', 'website'];
const source = SOURCES.includes(params.get('ref')) ? params.get('ref') : embed ? 'website' : 'online';

const state = {
  restaurant: null,
  onlineBooking: true,
  cardHolds: false,
  today: null,
  party: Number(params.get('party')) || 2,
  date: params.get('date') || null,
  time: parseHHMM(params.get('time')),
  availability: null,
  loading: false,
};
const app = $('#app');
let request = 0;

async function init() {
  try {
    const data = await api(`/api/public/r/${encodeURIComponent(slug)}`);
    Object.assign(state, { restaurant: data.restaurant, onlineBooking: data.onlineBooking, cardHolds: data.cardHolds, today: data.today });
    const r = data.restaurant;
    $('#r-name').textContent = r.name;
    const meta = $('#r-meta');
    clear(meta, [r.address, r.city].filter(Boolean).join(', '), r.phone ? [' · ', h('a', { href: `tel:${r.phone}` }, r.phone)] : null);
    if (embed) $('#head').style.marginBottom = '8px';
    state.party = Math.min(Math.max(state.party, r.minPartySize), r.maxPartySize + 1);
    if (!state.date || state.date < state.today) state.date = state.today;
    if (!state.onlineBooking) return renderUnavailable();
    renderPicker();
    loadTimes();
  } catch (err) {
    clear(app, h('p', {}, err.message));
  }
}

function renderUnavailable() {
  const r = state.restaurant;
  clear(app, h('div', { class: 'empty-state' }, h('strong', {}, 'Online booking is not available right now.'), r.phone ? h('p', {}, 'Please call ', h('a', { href: `tel:${r.phone}` }, r.phone), '.') : null));
}

function renderPicker() {
  const r = state.restaurant;
  const parties = [];
  for (let n = r.minPartySize; n <= Math.min(r.maxPartySize, 12); n++) parties.push(n);
  const days = [];
  for (let i = 0; i < Math.min(21, r.bookingWindowDays + 1); i++) days.push(addDays(state.today, i));

  const partyPills = h(
    'div',
    { class: 'pills', role: 'group', 'aria-label': 'Party size' },
    parties.map((n) =>
      h('button', { type: 'button', class: 'pill', 'aria-pressed': String(state.party === n), onclick: () => ((state.party = n), (state.time = null), renderPicker(), loadTimes()) }, String(n)),
    ),
    h('button', { type: 'button', class: 'pill', 'aria-pressed': String(state.party > r.maxPartySize), onclick: () => ((state.party = r.maxPartySize + 1), renderPicker(), loadTimes()) }, `${r.maxPartySize + 1}+`),
  );

  const datePills = h(
    'div',
    { class: 'pills', role: 'group', 'aria-label': 'Date' },
    days.map((d) =>
      h(
        'button',
        { type: 'button', class: 'pill date', 'aria-pressed': String(state.date === d), onclick: () => ((state.date = d), (state.time = null), renderPicker(), loadTimes()) },
        d === state.today ? 'Today' : fmtDate(d, { weekday: 'short' }),
        h('b', {}, fmtDate(d, { day: 'numeric' })),
        fmtDate(d, { month: 'short' }),
      ),
    ),
  );
  const otherDate = h('input', {
    type: 'date',
    min: state.today,
    max: addDays(state.today, r.bookingWindowDays),
    value: state.date,
    'aria-label': 'Pick another date',
    onchange: (e) => {
      if (!e.target.value) return;
      state.date = e.target.value;
      state.time = null;
      renderPicker();
      loadTimes();
    },
  });

  clear(
    app,
    h('h2', { class: 'step-title' }, 'Party size'),
    partyPills,
    h('h2', { class: 'step-title' }, 'Date'),
    datePills,
    h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'muted small' }, 'Another date:'), h('div', { style: { maxWidth: '190px' } }, otherDate)),
    h('h2', { class: 'step-title' }, `Times for ${fmtDate(state.date, { weekday: 'long', month: 'long', day: 'numeric' })}`),
    h('div', { id: 'times' }, h('p', { class: 'muted' }, 'Checking tables…')),
  );
  setTimeout(() => app.querySelector('.pill[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }), 0);
}

async function loadTimes() {
  const r = state.restaurant;
  const target = () => $('#times');
  if (state.party > r.maxPartySize) {
    clear(target(), h('div', { class: 'empty-state' }, h('strong', {}, 'Large party?'), h('p', {}, r.largePartyMessage), r.phone ? h('a', { class: 'btn brand', href: `tel:${r.phone}` }, `Call ${r.phone}`) : null));
    return;
  }
  const mine = ++request;
  try {
    const data = await api(`/api/public/r/${encodeURIComponent(slug)}/availability?date=${state.date}&party=${state.party}`);
    if (mine !== request) return;
    state.availability = data;
    renderTimes();
  } catch (err) {
    if (mine === request) clear(target(), h('p', { class: 'notice danger' }, err.message));
  }
}

function renderTimes() {
  const data = state.availability;
  const el = $('#times');
  const open = data.slots.filter((s) => s.available);
  if (state.time != null && open.some((s) => s.time === state.time)) {
    const t = state.time;
    state.time = null;
    return renderDetails(t);
  }
  if (!open.length) {
    const r = state.restaurant;
    const reason = data.closed ? data.message || 'Closed that day.' : 'Fully booked for that party size.';
    clear(
      el,
      h(
        'div',
        { class: 'empty-state' },
        h('strong', {}, reason),
        data.next?.length
          ? h(
              'div',
              { class: 'suggest' },
              h('p', { class: 'muted small', style: { textAlign: 'center' } }, 'Next available:'),
              data.next.map((n) =>
                h(
                  'div',
                  {},
                  h('h4', {}, fmtDate(n.date, { weekday: 'long', month: 'short', day: 'numeric' })),
                  h('div', { class: 'times' }, n.times.map((t) => h('button', { type: 'button', class: 'time', onclick: () => ((state.date = n.date), renderDetails(t.time)) }, t.label))),
                ),
              ),
            )
          : r.phone
            ? h('p', {}, 'Call ', h('a', { href: `tel:${r.phone}` }, r.phone), ' and we will do our best.')
            : null,
        r.waitlistOnline && state.date === state.today ? waitlistLink() : null,
      ),
    );
    return;
  }
  clear(
    el,
    data.message ? h('p', { class: 'notice' }, data.message) : null,
    timeGroups(open),
    state.restaurant.waitlistOnline && state.date === state.today ? h('p', { class: 'small muted', style: { marginTop: '14px' } }, 'Walking in instead? ', waitlistLink()) : null,
  );
}

// Brunch and dinner read as separate lists, not one run of times.
function timeGroups(open) {
  const groups = new Map();
  for (const s of open) {
    const key = s.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const button = (s) => h('button', { type: 'button', class: 'time', onclick: () => renderDetails(s.time) }, s.label);
  if (groups.size <= 1) return h('div', { class: 'times' }, open.map(button));
  return [...groups].map(([name, slots]) => h('div', { style: { marginBottom: '12px' } }, name ? h('div', { class: 'small muted', style: { fontWeight: 600, margin: '0 0 6px' } }, name) : null, h('div', { class: 'times' }, slots.map(button))));
}

function waitlistLink() {
  return h('button', { type: 'button', class: 'btn ghost small', onclick: renderWaitlist }, 'Join the waitlist');
}

function cardNeeded() {
  const r = state.restaurant;
  return state.cardHolds && r.cardRequiredMinParty > 0 && state.party >= r.cardRequiredMinParty;
}

function renderDetails(time) {
  const r = state.restaurant;
  const when = `${fmtDate(state.date, { weekday: 'short', month: 'short', day: 'numeric' })} at ${fmt12(time)}`;
  const fee = r.noShowFeeCents ? `$${(r.noShowFeeCents / 100).toFixed(0)} per guest` : 'a fee';
  const form = h(
    'form',
    { novalidate: true },
    h(
      'div',
      { class: 'summary-line' },
      h('span', {}, `${state.party} ${state.party === 1 ? 'guest' : 'guests'} · ${when}`),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => (renderPicker(), loadTimes()) }, 'Change'),
    ),
    h(
      'div',
      { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'First name'), h('input', { name: 'firstName', autocomplete: 'given-name', required: true })),
      h('label', { class: 'field' }, h('span', {}, 'Last name'), h('input', { name: 'lastName', autocomplete: 'family-name' })),
    ),
    h('label', { class: 'field' }, h('span', {}, `Mobile phone${r.requirePhone ? '' : ' (optional)'}`), h('input', { name: 'phone', type: 'tel', autocomplete: 'tel', required: r.requirePhone, inputmode: 'tel' })),
    h('label', { class: 'field' }, h('span', {}, `Email${r.requireEmail ? '' : ' (for your confirmation)'}`), h('input', { name: 'email', type: 'email', autocomplete: 'email', required: r.requireEmail })),
    r.collectOccasion
      ? h(
          'label',
          { class: 'field' },
          h('span', {}, 'Occasion'),
          h('select', { name: 'occasion' }, ['', 'Birthday', 'Anniversary', 'Date night', 'Business', 'Celebration'].map((o) => h('option', { value: o }, o || 'None'))),
        )
      : null,
    h('label', { class: 'field' }, h('span', {}, 'Notes for the restaurant'), h('textarea', { name: 'notes', rows: 2, maxlength: 1000, placeholder: 'Allergies, accessibility needs, a high chair…' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'marketingOptIn' }), h('span', {}, `Send me news and offers from ${r.name}`)),
    r.policyText ? h('div', { class: 'policy' }, r.policyText) : null,
    r.policyText ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'policyAccepted', required: true }), h('span', {}, 'I understand the reservation policy')) : null,
    cardNeeded()
      ? h('p', { class: 'notice' }, `A card holds tables for parties of ${r.cardRequiredMinParty} or more. Nothing is charged now. If you do not show up or cancel late, ${fee} may be charged.`)
      : null,
    h('div', { class: 'hp', 'aria-hidden': 'true' }, h('label', {}, 'Website', h('input', { name: 'website', tabindex: '-1', autocomplete: 'off' }))),
    h('p', { class: 'notice danger', id: 'form-error', hidden: true }),
    h('button', { type: 'submit', class: 'btn brand block', style: { minHeight: '48px', fontSize: '16px' } }, cardNeeded() ? 'Continue to hold with a card' : 'Confirm reservation'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error', form);
    err.hidden = true;
    const v = Object.fromEntries(new FormData(form));
    if (!v.firstName?.trim()) return showError(err, 'Please enter your first name.');
    if (r.requirePhone && !v.phone?.trim()) return showError(err, 'Please enter a mobile number.');
    if (!v.phone?.trim() && !v.email?.trim()) return showError(err, 'Please enter a phone number or email so we can reach you.');
    if (r.policyText && !v.policyAccepted) return showError(err, 'Please confirm you have read the policy.');
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    button.textContent = 'Booking…';
    try {
      const res = await api(`/api/public/r/${encodeURIComponent(slug)}/reservations`, {
        method: 'POST',
        body: {
          date: state.date,
          time,
          partySize: state.party,
          firstName: v.firstName,
          lastName: v.lastName,
          phone: v.phone,
          email: v.email,
          occasion: v.occasion,
          notes: v.notes,
          marketingOptIn: Boolean(v.marketingOptIn),
          policyAccepted: Boolean(v.policyAccepted),
          website: v.website,
          source,
        },
      });
      if (res.checkoutUrl) {
        if (!embed) {
          location.href = res.checkoutUrl;
          return;
        }
        // Stripe Checkout cannot load inside a frame: hand off with a real click.
        clear(
          app,
          h(
            'div',
            { class: 'confirm' },
            h('h2', {}, 'One more step'),
            h('p', { class: 'muted' }, 'Your table is held for 20 minutes while you add a card. Nothing is charged now.'),
            h('a', { class: 'btn brand', href: res.checkoutUrl, target: '_blank', rel: 'noopener' }, 'Open the secure card form'),
          ),
        );
        return;
      }
      renderConfirmed(res);
    } catch (e2) {
      button.disabled = false;
      button.textContent = cardNeeded() ? 'Continue to hold with a card' : 'Confirm reservation';
      showError(err, e2.message);
      if (e2.status === 409 && e2.code === 'unavailable') loadTimes();
    }
  });
  clear(app, form);
  form.querySelector('input[name=firstName]').focus();
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest' });
}

function renderConfirmed(res) {
  const r = state.restaurant;
  const v = res.reservation;
  const manage = new URL(res.manageUrl, location.origin);
  const calendar = `/m/${v.code}/calendar.ics?t=${manage.searchParams.get('t')}`;
  clear(
    app,
    h(
      'div',
      { class: 'confirm' },
      h('div', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
      h('h2', {}, "You're booked"),
      h('p', { class: 'muted' }, v.email ? `A confirmation is on its way to ${v.email}.` : 'Save your confirmation code below.'),
      h(
        'div',
        { class: 'details' },
        h('div', {}, h('span', {}, 'Where'), h('span', {}, r.name)),
        h('div', {}, h('span', {}, 'When'), h('span', {}, `${fmtDate(v.date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${v.timeLabel}`)),
        h('div', {}, h('span', {}, 'Party'), h('span', {}, `${v.partySize} ${v.partySize === 1 ? 'guest' : 'guests'}`)),
        h('div', {}, h('span', {}, 'Confirmation'), h('span', { class: 'code' }, v.code)),
      ),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('a', { class: 'btn', href: calendar }, 'Add to calendar'), h('a', { class: 'btn brand', href: manage.pathname + manage.search, target: embed ? '_top' : null }, 'View or change')),
    ),
  );
}

function renderWaitlist() {
  const r = state.restaurant;
  const form = h(
    'form',
    {},
    h('h2', { class: 'step-title' }, 'Join the waitlist'),
    h('p', { class: 'muted small' }, `We will text you when a table is ready at ${r.name}. Please be nearby.`),
    h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { name: 'name', required: true, autocomplete: 'name' })),
    h('label', { class: 'field' }, h('span', {}, 'Mobile phone'), h('input', { name: 'phone', type: 'tel', required: true, autocomplete: 'tel' })),
    h('label', { class: 'field' }, h('span', {}, 'Party size'), h('input', { name: 'partySize', type: 'number', min: 1, max: r.maxPartySize, value: state.party, required: true })),
    h('div', { class: 'hp', 'aria-hidden': 'true' }, h('input', { name: 'website', tabindex: '-1', autocomplete: 'off' })),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn brand' }, 'Add me to the list'), h('button', { type: 'button', class: 'btn ghost', onclick: () => (renderPicker(), loadTimes()) }, 'Back')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try {
      const res = await api(`/api/public/r/${encodeURIComponent(slug)}/waitlist`, { method: 'POST', body: { ...v, partySize: Number(v.partySize) } });
      location.href = res.statusUrl + (embed ? '&embed=1' : '');
    } catch (err) {
      toastError(err);
    }
  });
  clear(app, form);
}

init();
