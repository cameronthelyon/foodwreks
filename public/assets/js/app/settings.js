// Settings: every configuration screen, plus the getting-started checklist.

import { api, busy, checkbox, clear, confirmDialog, copyText, field, fmtDate, fmtHHMM, formValues, h, money, parseHHMM, toast, toastError, ago } from '../lib.js';
import { can, loadDay, loadRestaurant, rApi, state, today } from './state.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SECTIONS = {
  start: { label: 'Getting started', render: start },
  restaurant: { label: 'Restaurant', role: 'manager', render: profile },
  rules: { label: 'Booking rules', role: 'manager', render: rules },
  floor: { label: 'Floor plan', role: 'manager', render: floor },
  hours: { label: 'Hours & closures', role: 'manager', render: hours },
  messages: { label: 'Guest messages', role: 'manager', render: messages },
  protection: { label: 'No-show protection', role: 'manager', render: protection },
  integrations: { label: 'POS & Google', role: 'manager', render: integrations },
  share: { label: 'Share & embed', render: share },
  team: { label: 'Team', role: 'manager', render: team },
  data: { label: 'Import & export', role: 'manager', render: data },
  license: { label: 'License', render: license },
  account: { label: 'Your account', render: account },
  activity: { label: 'Activity log', role: 'manager', render: activity },
};

export function render(root, route) {
  const key = SECTIONS[route.arg] && (!SECTIONS[route.arg].role || can(SECTIONS[route.arg].role)) ? route.arg : 'start';
  const content = h('div');
  clear(
    root,
    h(
      'div',
      { class: 'settings' },
      h(
        'nav',
        { class: 'subnav', 'aria-label': 'Settings' },
        Object.entries(SECTIONS)
          .filter(([, s]) => !s.role || can(s.role))
          .map(([k, s]) => h('a', { href: `#/settings/${k}`, 'aria-current': k === key ? 'page' : 'false' }, s.label)),
      ),
      content,
    ),
  );
  Promise.resolve(SECTIONS[key].render(content, route)).catch(toastError);
}

const r = () => state.restaurant;

async function saveSettings(patch, message = 'Saved') {
  try {
    await rApi('/settings', { method: 'PATCH', body: patch });
    await loadRestaurant();
    toast(message, 'ok');
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

function panel(title, ...children) {
  return h('section', { class: 'panel' }, title ? h('h3', {}, title) : null, ...children);
}

// ---- Getting started (a READ-DO checklist) ------------------------------------

async function start(el) {
  const key = `checklist:${state.rid}`;
  let ticked = {};
  try {
    ticked = JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    /* no storage */
  }
  const [guests, integrations, teamList] = await Promise.all([
    rApi('/guests?limit=1').catch(() => ({ total: 0 })),
    can('manager') ? rApi('/integrations').catch(() => ({ connected: [] })) : { connected: [] },
    can('manager') ? rApi('/staff').catch(() => []) : [],
  ]);
  const connected = new Set(integrations.connected.map((i) => i.provider));
  const items = [
    ['floor', 'Check your floor plan: real table names, sizes, and which tables are walk-in only.', '#/settings/floor', false],
    ['hours', 'Set your hours, turn times and pacing.', '#/settings/hours', false],
    ['rules', 'Review booking rules and your cancellation policy.', '#/settings/rules', false],
    ['test', 'Make a test booking on your own booking page, then cancel it from the email link.', r().links.booking, guests.total > 0],
    ['import', 'Import your guest list and upcoming reservations from your current system.', '#/settings/data', guests.total > 2],
    ['google', 'Add your booking link to your Google Business Profile (Bookings → reservation link).', '#/settings/share', false],
    ['site', 'Put the booking button on your website and your link in your Instagram bio.', '#/settings/share', false],
    ['team', 'Invite your managers and hosts.', '#/settings/team', teamList.length > 1],
    ['pos', 'Optional: connect your POS (Toast, Square or Clover) and Stripe for card holds.', '#/settings/integrations', connected.size > 0],
    ['license', `Activate your lifetime license (${money(r().license.priceCents)} once).`, '#/settings/license', ['lifetime', 'comped'].includes(r().license.kind)],
    ['cutover', 'Cut over: switch your old system off only after one full service on this one.', null, false],
  ];
  const list = h('ul', { class: 'checklist' });
  const paint = () =>
    clear(
      list,
      items.map(([id, text, href, auto]) => {
        const done = Boolean(auto || ticked[id]);
        return h(
          'li',
          { class: done ? 'done' : '' },
          h(
            'button',
            {
              class: 'box',
              'aria-label': done ? 'Mark not done' : 'Mark done',
              style: { cursor: 'pointer', padding: 0 },
              onclick: () => {
                ticked[id] = !ticked[id];
                try {
                  localStorage.setItem(key, JSON.stringify(ticked));
                } catch {
                  /* ignore */
                }
                paint();
              },
            },
            done ? '✓' : '',
          ),
          h('span', { class: 'what' }, text),
          href ? h('a', { class: 'btn small', href, target: href.startsWith('http') ? '_blank' : null }, 'Open') : h('span'),
        );
      }),
    );
  paint();
  const doneCount = () => items.filter(([id, , , auto]) => auto || ticked[id]).length;
  clear(
    el,
    panel(
      'Getting started',
      h('p', { class: 'muted' }, `Work down the list once. ${doneCount()} of ${items.length} done. Ticks are saved on this device; items we can verify tick themselves.`),
      list,
    ),
    panel(
      'Leaving your old system cleanly',
      h(
        'ol',
        { class: 'small', style: { margin: 0, paddingLeft: '18px' } },
        h('li', {}, 'Export guests and future reservations from the old system as CSV. Import both here.'),
        h('li', {}, 'Point your website button, Google link and Instagram link at your new booking page.'),
        h('li', {}, 'Run one full service with both systems: take new bookings here only, honor anything still arriving there.'),
        h('li', {}, 'Close online availability in the old system. Keep its account until the last old booking has been served.'),
        h('li', {}, 'Cancel the old subscription. Keep the cancellation confirmation.'),
      ),
    ),
  );
}

// ---- Restaurant profile ----------------------------------------------------------

function profile(el) {
  const x = r();
  const form = h(
    'form',
    {},
    panel(
      'Restaurant',
      field('Name', h('input', { name: 'name', value: x.name, required: true })),
      h('div', { class: 'grid-2' }, field('Phone', h('input', { name: 'phone', type: 'tel', value: x.phone })), field('Email', h('input', { name: 'email', type: 'email', value: x.email }), 'Guests who reply to a confirmation or reminder reach this address.')),
      field('Website', h('input', { name: 'website', type: 'url', value: x.website, placeholder: 'https://' })),
      field('Street address', h('input', { name: 'address', value: x.address })),
      h('div', { class: 'grid-3' }, field('City', h('input', { name: 'city', value: x.city })), field('State', h('input', { name: 'region', value: x.region })), field('ZIP', h('input', { name: 'postalCode', value: x.postalCode }))),
      h('div', { class: 'grid-2' }, field('Cuisine', h('input', { name: 'cuisine', value: x.cuisine })), field('Time zone', h('input', { name: 'timezone', value: x.timezone }), 'An IANA name, for example America/Los_Angeles.')),
      checkbox('onlineBooking', 'Take online bookings', x.onlineBooking, 'Switch off to pause your booking page without changing anything else.'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.restaurant = await rApi('', { method: 'PATCH', body: formValues(form) });
      await loadRestaurant();
      toast('Saved', 'ok');
    } catch (err) {
      toastError(err);
    }
  });
  clear(el, form);
}

// ---- Booking rules ------------------------------------------------------------------

function rules(el) {
  const s = r().settings;
  let turns = s.turnTimes.map((t) => ({ ...t }));
  const turnsEl = h('div');
  const paintTurns = () =>
    clear(
      turnsEl,
      h(
        'table',
        { class: 'data edit-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Parties up to'), h('th', {}, 'Minutes'), h('th', {}))),
        h(
          'tbody',
          {},
          turns.map((t, i) =>
            h(
              'tr',
              {},
              h('td', {}, i === turns.length - 1 ? h('span', { class: 'muted' }, 'Any larger party') : h('input', { type: 'number', min: 1, max: 99, value: t.upTo, oninput: (e) => (t.upTo = Number(e.target.value)) })),
              h('td', {}, h('input', { type: 'number', min: 15, max: 600, step: 5, value: t.minutes, oninput: (e) => (t.minutes = Number(e.target.value)) })),
              h('td', {}, turns.length > 1 ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => ((turns = turns.filter((_, j) => j !== i)), paintTurns()) }, 'Remove') : null),
            ),
          ),
        ),
      ),
      h('button', { type: 'button', class: 'btn small', onclick: () => (turns.splice(turns.length - 1, 0, { upTo: (turns[turns.length - 2]?.upTo || 0) + 2, minutes: 120 }), paintTurns()) }, 'Add a size band'),
    );
  paintTurns();
  const num = (name, label, value, attrs = {}, hint) => field(label, h('input', { type: 'number', name, value, ...attrs }), hint);
  const form = h(
    'form',
    {},
    panel(
      'Who can book, and when',
      h('div', { class: 'grid-3' }, num('minPartySize', 'Smallest online party', s.minPartySize, { min: 1 }), num('maxPartySize', 'Largest online party', s.maxPartySize, { min: 1 }), num('bookingWindowDays', 'Days ahead bookable', s.bookingWindowDays, { min: 0, max: 365 })),
      h('div', { class: 'grid-3' }, num('minNoticeMinutes', 'Minimum notice (min)', s.minNoticeMinutes, { min: 0 }), num('cancelCutoffMinutes', 'Self-service cutoff (min)', s.cancelCutoffMinutes, { min: 0 }, 'Guests can change or cancel online until this long before.'), field('Time slot every', h('select', { name: 'slotInterval' }, [5, 10, 15, 20, 30, 60].map((v) => h('option', { value: v, selected: v === s.slotInterval }, `${v} min`))))),
      field('Large-party message', h('input', { name: 'largePartyMessage', value: s.largePartyMessage }), 'Shown when a party is over your online limit. {max} becomes the limit.'),
    ),
    panel(
      'Seating',
      h('p', { class: 'small muted' }, 'How long a table is held, by party size.'),
      turnsEl,
      h('div', { class: 'grid-2', style: { marginTop: '12px' } }, num('bufferMinutes', 'Reset time between parties (min)', s.bufferMinutes, { min: 0, max: 120 })),
      checkbox('autoOptimize', 'Re-seat auto-assigned parties to fit one more booking', s.autoOptimize, 'Pinned tables and parties already in the building never move.'),
    ),
    panel(
      'Booking page',
      checkbox('requirePhone', 'Require a phone number', s.requirePhone),
      checkbox('requireEmail', 'Require an email address', s.requireEmail),
      checkbox('collectOccasion', 'Ask about the occasion', s.collectOccasion),
      checkbox('waitlistOnline', 'Let guests join the waitlist from the booking page (needs texting)', s.waitlistOnline),
      field('Reservation policy', h('textarea', { name: 'policyText', rows: 3 }, s.policyText), 'Guests must tick that they read it. Leave empty for none.'),
      field('Confirmation note', h('textarea', { name: 'confirmationMessage', rows: 2 }, s.confirmationMessage), 'Added to confirmations: parking, dress code, anything useful.'),
      field('Accent color', h('input', { type: 'color', name: 'brandColor', value: s.brandColor })),
    ),
    panel(
      'Reporting',
      field(
        'Comparison fee per cover ($)',
        h('input', { type: 'number', name: 'feeComparisonDollars', min: 0, step: 0.05, value: (s.feeComparisonCents / 100).toFixed(2) }),
        'Used for the "fees avoided" estimate. OpenTable listed $1.00 (Core, Pro) and $1.50 (Basic) per network cover in October 2026.',
      ),
    ),
    h('button', { type: 'submit', class: 'btn primary' }, 'Save booking rules'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    const patch = { ...v, turnTimes: turns, feeComparisonCents: Math.round((v.feeComparisonDollars || 0) * 100) };
    delete patch.feeComparisonDollars;
    if (await saveSettings(patch, 'Booking rules saved')) rules(el);
  });
  clear(el, form);
}

// ---- Floor plan -----------------------------------------------------------------------

async function floor(el) {
  const { tables, combos } = await rApi('/floor');
  const tableRow = (t) => {
    const row = h(
      'tr',
      {},
      h('td', {}, h('input', { name: 'name', value: t.name, 'aria-label': 'Table name', style: { width: '90px' } })),
      h('td', {}, h('input', { name: 'section', value: t.section, 'aria-label': 'Section', style: { width: '120px' } })),
      h('td', {}, h('input', { name: 'min_covers', type: 'number', min: 1, value: t.min_covers, 'aria-label': 'Min', style: { width: '64px' } })),
      h('td', {}, h('input', { name: 'max_covers', type: 'number', min: 1, value: t.max_covers, 'aria-label': 'Max', style: { width: '64px' } })),
      h('td', {}, h('input', { name: 'online', type: 'checkbox', checked: t.online, 'aria-label': 'Bookable online' })),
      h('td', {}, h('input', { name: 'active', type: 'checkbox', checked: t.active, 'aria-label': 'In use' })),
      h('td', {}, h('input', { name: 'pos_ref', value: t.pos_ref, placeholder: 'as in POS', 'aria-label': 'POS name', style: { width: '110px' } })),
      h(
        'td',
        { style: { whiteSpace: 'nowrap' } },
        h('button', { class: 'btn small', onclick: (e) => saveRow(e.target) }, t.id ? 'Save' : 'Add'),
        t.id ? h('button', { class: 'btn small ghost', onclick: () => remove() }, 'Delete') : null,
      ),
    );
    const read = () => {
      const v = {};
      for (const input of row.querySelectorAll('input')) v[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
      return v;
    };
    const saveRow = async (button) => {
      await busy(
        button,
        (t.id ? rApi(`/tables/${t.id}`, { method: 'PATCH', body: read() }) : rApi('/tables', { method: 'POST', body: read() }))
          .then(() => {
            toast(t.id ? 'Table saved' : 'Table added', 'ok');
            floor(el);
            loadDay().catch(() => {});
          })
          .catch(toastError),
      );
    };
    const remove = async () => {
      if (!(await confirmDialog(`Delete table ${t.name}? Tables with past bookings are retired instead, so history stays intact.`, { confirmLabel: 'Delete', danger: true }))) return;
      try {
        const res = await rApi(`/tables/${t.id}`, { method: 'DELETE' });
        toast(res.retired ? 'Table retired (it has booking history)' : 'Table deleted', 'ok');
        floor(el);
      } catch (err) {
        toastError(err);
      }
    };
    return row;
  };

  const comboForm = h(
    'form',
    { class: 'row', style: { alignItems: 'flex-end' } },
    field('Tables', h('select', { name: 'table_ids', multiple: true, size: 4, style: { minWidth: '140px' } }, tables.filter((t) => t.active).map((t) => h('option', { value: t.id }, `${t.name} (${t.max_covers})`)))),
    field('Name', h('input', { name: 'name', placeholder: 'e.g. 12+13', style: { width: '120px' } })),
    field('Min', h('input', { name: 'min_covers', type: 'number', min: 1, value: 5, style: { width: '70px' } })),
    field('Max', h('input', { name: 'max_covers', type: 'number', min: 1, value: 8, style: { width: '70px' } })),
    h('button', { type: 'submit', class: 'btn', style: { marginBottom: '14px' } }, 'Add combination'),
  );
  comboForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = [...comboForm.elements.table_ids.selectedOptions].map((o) => Number(o.value));
    try {
      await rApi('/combos', { method: 'POST', body: { table_ids: ids, name: comboForm.elements.name.value, min_covers: Number(comboForm.elements.min_covers.value), max_covers: Number(comboForm.elements.max_covers.value) } });
      toast('Combination added', 'ok');
      floor(el);
    } catch (err) {
      toastError(err);
    }
  });
  const name = (id) => tables.find((t) => t.id === id)?.name || id;
  clear(
    el,
    panel(
      'Tables',
      h('p', { class: 'small muted' }, 'Untick "online" to keep a table for walk-ins. "POS name" helps match checks when your POS names tables differently.'),
      h(
        'div',
        { style: { overflowX: 'auto' } },
        h(
          'table',
          { class: 'data edit-table' },
          h('thead', {}, h('tr', {}, ['Name', 'Section', 'Min', 'Max', 'Online', 'In use', 'POS name', ''].map((c) => h('th', {}, c)))),
          h('tbody', {}, tables.map(tableRow), tableRow({ id: null, name: '', section: tables[tables.length - 1]?.section || '', min_covers: 2, max_covers: 4, online: true, active: true, pos_ref: '' })),
        ),
      ),
    ),
    panel(
      'Combinations',
      h('p', { class: 'small muted' }, 'Tables you push together for bigger parties. Used only when no single table fits.'),
      combos.length
        ? h(
            'table',
            { class: 'data' },
            h(
              'tbody',
              {},
              combos.map((c) =>
                h(
                  'tr',
                  {},
                  h('td', {}, h('b', {}, c.name)),
                  h('td', {}, c.table_ids.map(name).join(' + ')),
                  h('td', {}, `${c.min_covers}-${c.max_covers} guests`),
                  h('td', {}, c.active ? '' : h('span', { class: 'chip' }, 'off')),
                  h(
                    'td',
                    {},
                    h(
                      'button',
                      {
                        class: 'btn small ghost',
                        onclick: async () => {
                          try {
                            await rApi(`/combos/${c.id}`, { method: 'DELETE' });
                            floor(el);
                          } catch (err) {
                            toastError(err);
                          }
                        },
                      },
                      'Delete',
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'No combinations yet.'),
      comboForm,
    ),
  );
}

// ---- Hours & closures --------------------------------------------------------------------

async function hours(el) {
  const [shifts, closures] = await Promise.all([rApi('/shifts'), rApi('/closures')]);
  const shiftForm = (s) => {
    const days = h(
      'div',
      { class: 'days' },
      DAYS.map((d, i) => h('label', {}, h('input', { type: 'checkbox', name: `day${i}`, checked: s.days.includes(i) }), d)),
    );
    const time = (name, label, value, hint) => field(label, h('input', { name, value: value == null ? '' : fmtHHMM(value), placeholder: 'HH:MM', inputmode: 'numeric', style: { width: '90px' } }), hint);
    const form = h(
      'form',
      { class: 'panel' },
      h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, s.id ? s.name : 'New shift'), s.id ? h('span', { class: `chip ${s.active ? 'ok' : ''}` }, s.active ? 'Active' : 'Off') : null),
      h('div', { class: 'grid-3', style: { marginTop: '10px' } }, field('Name', h('input', { name: 'name', value: s.name, required: true })), field('Slots every', h('select', { name: 'interval_min' }, [5, 10, 15, 20, 30, 60].map((v) => h('option', { value: v, selected: v === s.interval_min }, `${v} min`)))), h('div')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Days'), days),
      h('div', { class: 'row' }, time('start_min', 'First seating', s.start_min), time('last_seating_min', 'Last seating', s.last_seating_min), time('end_min', 'Close', s.end_min, 'Use 25:00 for 1 AM')),
      h(
        'div',
        { class: 'row' },
        field('Max covers starting per slot', h('input', { name: 'max_covers_per_slot', type: 'number', min: 0, value: s.max_covers_per_slot ?? '', placeholder: 'no limit', style: { width: '130px' } }), 'Pacing protects the kitchen.'),
        field('Max parties per slot', h('input', { name: 'max_parties_per_slot', type: 'number', min: 0, value: s.max_parties_per_slot ?? '', placeholder: 'no limit', style: { width: '130px' } })),
        field('Season from', h('input', { name: 'starts_on', type: 'date', value: s.starts_on || '' })),
        field('to', h('input', { name: 'ends_on', type: 'date', value: s.ends_on || '' })),
      ),
      checkbox('online', 'Bookable online', s.online),
      checkbox('active', 'Active', s.active),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'submit', class: 'btn primary' }, s.id ? 'Save shift' : 'Add shift'),
        s.id
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn danger',
                onclick: async () => {
                  if (!(await confirmDialog(`Delete the ${s.name} shift? Existing bookings stay.`, { confirmLabel: 'Delete', danger: true }))) return;
                  await rApi(`/shifts/${s.id}`, { method: 'DELETE' }).catch(toastError);
                  hours(el);
                },
              },
              'Delete',
            )
          : null,
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(form);
      const body = {
        name: v.name,
        days: DAYS.map((_, i) => (v[`day${i}`] ? i : null)).filter((x) => x !== null),
        start_min: parseHHMM(v.start_min),
        last_seating_min: parseHHMM(v.last_seating_min),
        end_min: parseHHMM(v.end_min),
        interval_min: Number(v.interval_min),
        max_covers_per_slot: v.max_covers_per_slot || null,
        max_parties_per_slot: v.max_parties_per_slot || null,
        starts_on: v.starts_on || null,
        ends_on: v.ends_on || null,
        online: v.online,
        active: v.active,
      };
      if (body.start_min === null || body.last_seating_min === null) return toast('Times must look like 17:30.', 'error');
      try {
        await (s.id ? rApi(`/shifts/${s.id}`, { method: 'PATCH', body }) : rApi('/shifts', { method: 'POST', body }));
        toast('Shift saved', 'ok');
        hours(el);
        loadDay().catch(() => {});
      } catch (err) {
        toastError(err);
      }
    });
    return form;
  };

  const closureForm = h(
    'form',
    { class: 'row', style: { alignItems: 'flex-end' } },
    field('Date', h('input', { type: 'date', name: 'date', required: true, min: today() })),
    field('What', h('select', { name: 'closed' }, h('option', { value: '1' }, 'Closed all day'), h('option', { value: '0' }, 'Special hours'))),
    field('First seating', h('input', { name: 'start', placeholder: '17:00', style: { width: '90px' } })),
    field('Last seating', h('input', { name: 'last', placeholder: '21:00', style: { width: '90px' } })),
    field('Note', h('input', { name: 'note', placeholder: 'Private event, holiday…' })),
    h('button', { type: 'submit', class: 'btn', style: { marginBottom: '14px' } }, 'Save date'),
  );
  closureForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(closureForm);
    const closed = v.closed === '1';
    try {
      const res = await rApi('/closures', { method: 'POST', body: { date: v.date, closed, start_min: closed ? null : parseHHMM(v.start), last_seating_min: closed ? null : parseHHMM(v.last), note: v.note } });
      toast(res.existingReservations ? `Saved. ${res.existingReservations} existing reservations that day were NOT cancelled: contact those guests.` : 'Saved', res.existingReservations ? 'info' : 'ok', 8000);
      hours(el);
    } catch (err) {
      toastError(err);
    }
  });

  clear(
    el,
    shifts.map(shiftForm),
    shiftForm({ id: null, name: '', days: [2, 3, 4, 5, 6], start_min: 17 * 60, last_seating_min: 21 * 60, end_min: 22 * 60, interval_min: 15, online: true, active: true }),
    panel(
      'Closures and special days',
      closures.length
        ? h(
            'table',
            { class: 'data' },
            h(
              'tbody',
              {},
              closures.map((c) =>
                h(
                  'tr',
                  {},
                  h('td', {}, fmtDate(c.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })),
                  h('td', {}, c.closed ? h('span', { class: 'chip danger' }, 'Closed') : `${fmtHHMM(c.start_min)}–${fmtHHMM(c.last_seating_min)}`),
                  h('td', {}, c.note),
                  h(
                    'td',
                    {},
                    h(
                      'button',
                      {
                        class: 'btn small ghost',
                        onclick: async () => {
                          await rApi(`/closures/${c.id}`, { method: 'DELETE' }).catch(toastError);
                          hours(el);
                        },
                      },
                      'Remove',
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'No upcoming closures.'),
      closureForm,
    ),
  );
}

// ---- Guest messages ------------------------------------------------------------------------

async function messages(el) {
  const s = r().settings;
  const m = r().messaging;
  const log = await rApi('/messages').catch(() => []);
  const form = h(
    'form',
    {},
    panel(
      'What guests receive',
      h('p', { class: 'small muted' }, `Email: ${m.email || 'not configured'} · Text messages: ${m.sms || 'not configured on this server'}`),
      checkbox('emailEnabled', 'Email confirmations, changes, reminders and cancellations', s.emailEnabled),
      checkbox('smsEnabled', 'Text them too', s.smsEnabled && Boolean(m.sms), m.sms ? 'Texts cost about 1.3¢ each in carrier fees, passed through at cost.' : 'Texting needs a Twilio account configured by your administrator.'),
      field('Reminder', h('select', { name: 'remindHoursBefore' }, [0, 2, 4, 12, 24, 48].map((v) => h('option', { value: v, selected: v === s.remindHoursBefore }, v ? `${v} hours before` : 'No reminders')))),
      field('Email staff about new online bookings', h('input', { type: 'email', name: 'staffAlertEmail', value: s.staffAlertEmail, placeholder: 'manager@yourrestaurant.com' })),
      h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
    ),
  );
  if (!m.sms) form.elements.smsEnabled.disabled = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    await saveSettings({ ...v, remindHoursBefore: Number(v.remindHoursBefore), smsEnabled: Boolean(v.smsEnabled) });
  });
  clear(
    el,
    form,
    panel(
      'Recent messages',
      log.length
        ? h(
            'div',
            { style: { overflowX: 'auto' } },
            h(
              'table',
              { class: 'data' },
              h('thead', {}, h('tr', {}, ['When', 'What', 'To', 'Status'].map((c) => h('th', {}, c)))),
              h(
                'tbody',
                {},
                log.slice(0, 50).map((x) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'small' }, ago(x.created_at)),
                    h('td', {}, `${x.kind.replace(/_/g, ' ')} (${x.channel})`),
                    h('td', { class: 'small' }, x.recipient),
                    h('td', {}, h('span', { class: `chip ${x.status === 'sent' ? 'ok' : x.status === 'failed' ? 'danger' : ''}` }, x.status), x.error ? h('div', { class: 'small muted' }, x.error) : null),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'Nothing sent yet.'),
    ),
  );
}

// ---- No-show protection ---------------------------------------------------------------------

function protection(el) {
  const s = r().settings;
  const connected = r().stripeConnected;
  const keyForm = h(
    'form',
    {},
    field('Stripe restricted key', h('input', { name: 'secretKey', placeholder: 'rk_live_…', autocomplete: 'off' }), 'Create it in Stripe: Developers → API keys → Create restricted key.'),
    h('button', { type: 'submit', class: 'btn' }, connected ? 'Replace key' : 'Connect Stripe'),
  );
  keyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await rApi('/integrations/stripe/connect', { method: 'POST', body: { secretKey: keyForm.elements.secretKey.value } });
      toast(`Stripe connected (${res.mode} mode)`, 'ok');
      await loadRestaurant();
      protection(el);
    } catch (err) {
      toastError(err);
    }
  });
  const rulesForm = h(
    'form',
    {},
    field('Require a card for parties of', h('input', { type: 'number', name: 'cardRequiredMinParty', min: 0, value: s.cardRequiredMinParty, style: { width: '120px' } }), '0 turns card holds off. Typical: 6 or more.'),
    field('No-show fee per guest ($)', h('input', { type: 'number', name: 'fee', min: 0, step: 1, value: (s.noShowFeeCents / 100).toFixed(0), style: { width: '120px' } })),
    h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
  );
  rulesForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(rulesForm);
    await saveSettings({ cardRequiredMinParty: v.cardRequiredMinParty || 0, noShowFeeCents: Math.round((v.fee || 0) * 100) });
  });
  clear(
    el,
    panel(
      'Card holds on your own Stripe account',
      h('p', {}, 'Guests save a card on a secure Stripe page. Nothing is charged unless you mark a no-show and press charge. Money goes straight to your Stripe account. We never take a cut.'),
      h('p', {}, connected ? h('span', { class: 'chip ok' }, 'Stripe connected') : h('span', { class: 'chip' }, 'Not connected')),
      h(
        'details',
        {},
        h('summary', {}, 'Which permissions does the restricted key need?'),
        h('ul', { class: 'small' }, h('li', {}, 'Customers: Write'), h('li', {}, 'Checkout Sessions: Write'), h('li', {}, 'SetupIntents: Write'), h('li', {}, 'PaymentIntents: Write'), h('li', {}, 'PaymentMethods: Read')),
      ),
      can('owner') ? keyForm : h('p', { class: 'muted small' }, 'Only an owner can connect Stripe.'),
    ),
    panel('Rules', rulesForm, !connected ? h('p', { class: 'small muted' }, 'Until Stripe is connected, bookings go through without a card.') : null),
  );
}

// ---- POS & Google -----------------------------------------------------------------------------

async function integrations(el, route) {
  const info = await rApi('/integrations');
  const conn = Object.fromEntries(info.connected.map((c) => [c.provider, c]));
  const q = route.query;
  const status = (c) =>
    c
      ? h(
          'div',
          { class: 'small', style: { margin: '6px 0 10px' } },
          h('span', { class: `chip ${c.status === 'connected' ? 'ok' : 'danger'}` }, c.status === 'connected' ? 'Connected' : 'Error'),
          ` Last sync ${c.lastSyncAt ? ago(c.lastSyncAt) : 'never'}`,
          c.lastError ? h('div', { class: 'notice danger', style: { marginTop: '6px' } }, c.lastError) : null,
        )
      : h('div', { class: 'small muted', style: { margin: '6px 0 10px' } }, 'Not connected');
  const actions = (provider) =>
    conn[provider]
      ? h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn small',
              onclick: (e) =>
                busy(
                  e.target,
                  rApi(`/integrations/${provider}/sync`, { method: 'POST', body: {} })
                    .then((res) => toast(`Synced: ${res.received} checks, ${res.matched} matched`, 'ok'))
                    .catch(toastError)
                    .finally(() => integrations(el, route)),
                ),
            },
            'Sync now',
          ),
          can('owner')
            ? h(
                'button',
                {
                  class: 'btn small danger',
                  onclick: async () => {
                    if (!(await confirmDialog(`Disconnect ${provider}? Spend already matched stays.`, { confirmLabel: 'Disconnect', danger: true }))) return;
                    await rApi(`/integrations/${provider}`, { method: 'DELETE' }).catch(toastError);
                    integrations(el, route);
                  },
                },
                'Disconnect',
              )
            : null,
        )
      : null;
  const oauth = (provider, name) =>
    panel(
      name,
      status(conn[provider]),
      conn[provider]
        ? actions(provider)
        : info.available[provider].configured
          ? can('owner')
            ? h(
                'button',
                {
                  class: 'btn primary',
                  onclick: async () => {
                    try {
                      const res = await rApi(`/integrations/${provider}/authorize`, { method: 'POST', body: {} });
                      location.href = res.url;
                    } catch (err) {
                      toastError(err);
                    }
                  },
                },
                `Connect ${name}`,
              )
            : h('p', { class: 'small muted' }, 'Only an owner can connect.')
          : h('p', { class: 'small muted' }, `${name} needs app credentials on this server first (see docs/INTEGRATIONS.md).`),
      provider === 'square' && conn.square?.config.locations?.length > 1
        ? field(
            'Location',
            h(
              'select',
              {
                onchange: async (e) => {
                  await rApi('/integrations/square', { method: 'PATCH', body: { locationId: e.target.value } }).catch(toastError);
                  toast('Location saved', 'ok');
                },
              },
              conn.square.config.locations.map((l) => h('option', { value: l.id, selected: l.id === conn.square.config.locationId }, l.name)),
            ),
          )
        : null,
    );
  const toastForm = h(
    'form',
    {},
    h('div', { class: 'grid-2' }, field('Client ID', h('input', { name: 'clientId', autocomplete: 'off' })), field('Client secret', h('input', { name: 'clientSecret', type: 'password', autocomplete: 'off' }))),
    h('div', { class: 'grid-2' }, field('Restaurant GUID', h('input', { name: 'restaurantGuid', autocomplete: 'off' })), field('API hostname (optional)', h('input', { name: 'host', placeholder: 'https://…' }), 'Shown with your Toast credentials.')),
    h('button', { type: 'submit', class: 'btn primary' }, 'Connect Toast'),
  );
  toastForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await rApi('/integrations/toast/connect', { method: 'POST', body: formValues(toastForm) });
      toast('Toast connected', 'ok');
      integrations(el, route);
    } catch (err) {
      toastError(err);
    }
  });
  const s = r().settings;
  clear(
    el,
    q.get('connected') ? h('p', { class: 'notice ok' }, `${q.get('connected')} connected. The first sync runs in the background.`) : null,
    q.get('error') ? h('p', { class: 'notice danger' }, q.get('error')) : null,
    h('p', { class: 'muted' }, 'POS connections are read-only. We read closed checks to show spend per guest and to free tables when a check closes. Nothing is ever written to your POS. Everything else works without one.'),
    panel(
      'Toast',
      status(conn.toast),
      conn.toast
        ? actions('toast')
        : [
            h('p', { class: 'small' }, 'In Toast Web go to Integrations → Toast API access → Manage credentials, create credentials with the orders:read, config:read and guest.pi:read scopes, then paste them here. Needs the Manage Integrations permission and RMS Essentials or higher.'),
            can('owner') ? toastForm : null,
          ],
    ),
    oauth('square', 'Square'),
    oauth('clover', 'Clover'),
    panel(
      'Google',
      h('p', {}, 'Most diners find you on Google. Add this as the reservation link on your Google Business Profile (Edit profile → Bookings). Bookings from it are tracked as Google in your reports.'),
      snippet(r().links.google),
      checkbox(
        'googleEndToEnd',
        'Offer my tables for booking directly inside Google (Reserve with Google)',
        s.googleEndToEnd,
        'Works only once this service is an approved Google booking partner. Until then the link above is the way.',
      ),
      h(
        'button',
        {
          class: 'btn small',
          onclick: (e) => saveSettings({ googleEndToEnd: e.target.closest('section').querySelector('input[name=googleEndToEnd]').checked }),
        },
        'Save',
      ),
    ),
  );
}

// ---- Share & embed ------------------------------------------------------------------------------

function snippet(text) {
  return h('div', { class: 'snippet' }, h('pre', {}, text), h('button', { class: 'btn small', type: 'button', onclick: () => copyText(text) }, 'Copy'));
}

function share(el) {
  const l = r().links;
  const inline = l.widget.replace(' async>', ' data-inline="true" async>');
  clear(
    el,
    panel('Your booking page', h('p', { class: 'small muted' }, 'Share it anywhere: menus, email signatures, QR codes on the door.'), snippet(l.booking), h('a', { class: 'btn small', href: l.booking, target: '_blank', rel: 'noopener' }, 'Open booking page')),
    panel('Google Business Profile', h('p', { class: 'small' }, 'Paste as your reservation link (Edit profile → Bookings). Tracked as Google in reports.'), snippet(l.google)),
    panel('Instagram bio', h('p', { class: 'small' }, 'Tracked as Instagram in reports.'), snippet(l.instagram)),
    panel(
      'Website button',
      h('p', { class: 'small' }, 'Paste where the button should appear. It opens the booking form over your page, still works if scripts are blocked, and is a link search engines follow to your booking page. Bookings are tracked as Website.'),
      snippet(l.widget),
      h('p', { class: 'small' }, 'Or show the full form inline on a reservations page:'),
      snippet(inline),
    ),
  );
}

// ---- Team -----------------------------------------------------------------------------------------

async function team(el) {
  const people = await rApi('/staff');
  const owner = can('owner');
  const invite = h(
    'form',
    { class: 'row', style: { alignItems: 'flex-end' } },
    field('Email', h('input', { type: 'email', name: 'email', required: true })),
    field('Name', h('input', { name: 'name' })),
    field('Role', h('select', { name: 'role' }, h('option', { value: 'host' }, 'Host'), h('option', { value: 'manager' }, 'Manager'), h('option', { value: 'owner' }, 'Owner'))),
    h('button', { type: 'submit', class: 'btn primary', style: { marginBottom: '14px' } }, 'Invite'),
  );
  invite.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await rApi('/staff', { method: 'POST', body: formValues(invite) });
      toast('Invitation sent', 'ok');
      team(el);
    } catch (err) {
      toastError(err);
    }
  });
  clear(
    el,
    panel(
      'Team',
      h('p', { class: 'small muted' }, 'Hosts run the book and waitlist. Managers also change settings and see reports. Owners also manage the team, integrations and the license.'),
      h(
        'table',
        { class: 'data' },
        h(
          'tbody',
          {},
          people.map((p) =>
            h(
              'tr',
              {},
              h('td', {}, h('b', {}, p.name || p.email), h('div', { class: 'small muted' }, p.email)),
              h('td', {}, p.pending ? h('span', { class: 'chip warn' }, 'Invited') : p.last_login_at ? h('span', { class: 'small muted' }, `Active ${ago(p.last_login_at)}`) : null),
              h(
                'td',
                {},
                owner
                  ? h(
                      'select',
                      {
                        'aria-label': 'Role',
                        onchange: async (e) => {
                          try {
                            await rApi(`/staff/${p.id}`, { method: 'PATCH', body: { role: e.target.value } });
                            toast('Role updated', 'ok');
                          } catch (err) {
                            toastError(err);
                            team(el);
                          }
                        },
                      },
                      ['host', 'manager', 'owner'].map((x) => h('option', { value: x, selected: x === p.role }, x)),
                    )
                  : p.role,
              ),
              h(
                'td',
                {},
                owner
                  ? h(
                      'button',
                      {
                        class: 'btn small ghost',
                        onclick: async () => {
                          if (!(await confirmDialog(`Remove ${p.name || p.email} from the team?`, { confirmLabel: 'Remove', danger: true }))) return;
                          try {
                            await rApi(`/staff/${p.id}`, { method: 'DELETE' });
                            team(el);
                          } catch (err) {
                            toastError(err);
                          }
                        },
                      },
                      'Remove',
                    )
                  : null,
              ),
            ),
          ),
        ),
      ),
      owner ? invite : null,
    ),
  );
}

// ---- Import & export ---------------------------------------------------------------------------------

const FIELD_NAMES = {
  firstName: 'First name',
  lastName: 'Last name',
  name: 'Full name',
  email: 'Email',
  phone: 'Phone',
  notes: 'Notes',
  tags: 'Tags',
  visits: 'Visit count',
  marketingOptIn: 'Marketing opt-in',
  date: 'Date',
  time: 'Time',
  datetime: 'Date and time',
  partySize: 'Party size',
  status: 'Status',
  externalId: 'Confirmation number',
  occasion: 'Occasion',
};

function data(el) {
  let csv = '';
  const out = h('div');
  const form = h(
    'form',
    {},
    h('div', { class: 'grid-2' }, field('What is in the file?', h('select', { name: 'kind' }, h('option', { value: 'guests' }, 'Guest list'), h('option', { value: 'reservations' }, 'Reservations'))), field('CSV file', h('input', { type: 'file', name: 'file', accept: '.csv,text/csv', required: true }))),
    checkbox('includePast', 'Also import past reservations as visit history', false, 'Off by default: only upcoming bookings come across.'),
    h('button', { type: 'submit', class: 'btn' }, 'Preview'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = form.elements.file.files[0];
    if (!file) return;
    if (file.size > 7_000_000) return toast('That file is over 7 MB. Split it and import in parts.', 'error');
    csv = await file.text();
    try {
      const p = await rApi('/import/preview', { method: 'POST', body: { kind: form.elements.kind.value, csv } });
      const mapped = Object.entries(p.mapping).map(([k, i]) => h('li', {}, `${p.headers[i]} → ${FIELD_NAMES[k] || k}`));
      clear(
        out,
        h('p', {}, h('b', {}, `${p.rows} rows found.`), ' Columns we recognized:'),
        h('ul', { class: 'small' }, mapped),
        p.missing.length ? h('p', { class: 'notice danger' }, `Missing required columns: ${p.missing.join('; ')}. Rename the headers in the file and try again.`) : null,
        h(
          'div',
          { style: { overflowX: 'auto' } },
          h('table', { class: 'data' }, h('thead', {}, h('tr', {}, p.headers.map((x) => h('th', {}, x)))), h('tbody', {}, p.sample.map((row) => h('tr', {}, row.map((c) => h('td', { class: 'small' }, c)))))),
        ),
        !p.missing.length
          ? h(
              'button',
              {
                class: 'btn primary',
                style: { marginTop: '12px' },
                onclick: (ev) =>
                  busy(
                    ev.target,
                    rApi('/import/commit', { method: 'POST', body: { kind: form.elements.kind.value, csv, includePast: form.elements.includePast.checked } })
                      .then((res) => {
                        clear(
                          out,
                          h(
                            'div',
                            { class: 'notice ok' },
                            `Imported ${res.created} new${res.updated !== undefined ? `, updated ${res.updated}` : ''}. Skipped ${res.skipped}.${res.duplicates ? ` ${res.duplicates} already imported.` : ''}${res.unassigned ? ` ${res.unassigned} reservations need a table: see the Floor view.` : ''}`,
                          ),
                          res.errors?.length ? h('details', {}, h('summary', {}, `${res.errors.length} rows with problems`), h('ul', { class: 'small' }, res.errors.map((x) => h('li', {}, `Row ${x.row}: ${x.error}`)))) : null,
                        );
                        loadDay().catch(() => {});
                      })
                      .catch(toastError),
                  ),
              },
              `Import ${p.rows} rows`,
            )
          : null,
      );
    } catch (err) {
      toastError(err);
    }
  });
  const base = `/api/r/${state.rid}/export`;
  clear(
    el,
    panel(
      'Import from your old system',
      h('p', { class: 'small muted' }, 'Export guests and upcoming reservations from OpenTable, Resy, Tock, Yelp or a spreadsheet as CSV. We match columns automatically, skip duplicates, and never message guests during an import.'),
      form,
      out,
    ),
    panel(
      'Export everything',
      h('p', { class: 'small muted' }, 'Your data is yours. Take it any time, in formats any system can read.'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: `${base}/guests.csv` }, 'Guests (CSV)'), h('a', { class: 'btn', href: `${base}/reservations.csv` }, 'Reservations (CSV)'), can('owner') ? h('a', { class: 'btn', href: `${base}/all.json` }, 'Everything (JSON)') : null),
    ),
  );
}

// ---- License -------------------------------------------------------------------------------------------

// Back from Stripe with ?paid=1, the license flips when the payment webhook
// lands, usually within seconds. Check every 3 s for 30 s, and only while
// this screen is still open.
const LICENSE_CHECKS = 10;

function license(el, route, attempt = 0) {
  const l = r().license;
  const waiting = route.query.get('paid') === '1' && l.kind !== 'lifetime';
  const gaveUp = waiting && attempt >= LICENSE_CHECKS;
  const statusLine =
    l.kind === 'lifetime'
      ? h('p', { class: 'notice ok' }, `Lifetime license active${l.paidAt ? ` since ${new Date(l.paidAt).toLocaleDateString()}` : ''}. Thank you.`)
      : l.kind === 'comped'
        ? h('p', { class: 'notice ok' }, 'Complimentary license active.')
        : l.kind === 'suspended'
          ? h('p', { class: 'notice danger' }, 'This account is suspended. Contact support.')
          : l.active
            ? h('p', { class: 'notice' }, `Free trial: ${l.daysLeft} ${l.daysLeft === 1 ? 'day' : 'days'} left.`)
            : h('p', { class: 'notice warn' }, 'Trial ended. Online booking is paused; everything else keeps working, including exports.');
  if (waiting && !gaveUp) {
    setTimeout(() => {
      const here = () => el.isConnected && location.hash.startsWith('#/settings/license');
      if (here()) loadRestaurant().then(() => here() && license(el, route, attempt + 1), () => here() && license(el, route, attempt + 1));
    }, 3000);
  }
  clear(
    el,
    panel(
      'License',
      waiting
        ? h(
            'p',
            { class: gaveUp ? 'notice warn' : 'notice' },
            gaveUp
              ? 'Payment received, but the activation has not come through yet. Refresh this page in a minute; if it still shows the trial, contact support and we will activate it by hand.'
              : 'Payment received. Activation takes a few seconds…',
          )
        : null,
      statusLine,
      h('h2', { style: { margin: '6px 0' } }, `${money(l.priceCents)} once, per location`),
      h(
        'ul',
        {},
        h('li', {}, 'Every feature, every update, for as long as you run this location.'),
        h('li', {}, 'No per-cover fees and no monthly fee. Ever.'),
        h('li', {}, 'Transfers with the restaurant if you sell it.'),
        h('li', {}, 'Your data exports any time, and the software is open source (AGPL-3.0), so it outlives any one company.'),
        h('li', {}, 'Text messages are billed separately at carrier cost (about 1.3¢ each), because carriers charge per message.'),
      ),
      ['lifetime', 'comped'].includes(l.kind)
        ? null
        : can('owner')
          ? l.checkoutAvailable
            ? h(
                'button',
                {
                  class: 'btn primary',
                  onclick: (e) =>
                    busy(
                      e.target,
                      rApi('/license/checkout', { method: 'POST', body: {} })
                        .then((res) => (location.href = res.url))
                        .catch(toastError),
                    ),
                },
                `Pay ${money(l.priceCents)} and activate`,
              )
            : h('p', {}, 'To activate, email ', h('a', { href: `mailto:${document.body.dataset.support || ''}` }, 'support'), '. Online payment is not set up on this server yet.')
          : h('p', { class: 'small muted' }, 'An owner can activate the license.'),
    ),
  );
}

// ---- Account --------------------------------------------------------------------------------------------

function account(el) {
  const form = h(
    'form',
    {},
    panel(
      'Change password',
      field('Current password', h('input', { type: 'password', name: 'currentPassword', autocomplete: 'current-password', required: true })),
      field('New password', h('input', { type: 'password', name: 'newPassword', autocomplete: 'new-password', minlength: 10, required: true }), 'At least 10 characters.'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Change password'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/password', { method: 'POST', body: formValues(form) });
      form.reset();
      toast('Password changed', 'ok');
    } catch (err) {
      toastError(err);
    }
  });
  clear(el, panel('Signed in as', h('p', {}, state.me.user.email)), form);
}

// ---- Activity ----------------------------------------------------------------------------------------------

async function activity(el) {
  const rows = await rApi('/activity');
  clear(
    el,
    panel(
      'Activity',
      h('p', { class: 'small muted' }, 'Every change, who made it and when. Kept for accountability.'),
      h(
        'table',
        { class: 'data' },
        h(
          'tbody',
          {},
          rows.map((a) =>
            h(
              'tr',
              {},
              h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, ago(a.created_at)),
              h('td', {}, a.action.replace('.', ' ').replace(/_/g, ' ')),
              h('td', { class: 'small muted' }, a.user_name || a.user_email || 'Guest or system'),
              h('td', { class: 'small' }, a.entity === 'reservation' ? h('a', { href: '#', onclick: (e) => (e.preventDefault(), import('./reservation.js').then((m) => m.openReservation(a.entity_id))) }, 'Open') : ''),
            ),
          ),
        ),
      ),
    ),
  );
}

