// Reservation detail/editor and the new-reservation form.

import { $, ago, clear, confirmDialog, fmt12, fmtDate, fmtHHMM, h, modal, money, parseHHMM, toast, toastError } from '../lib.js';
import { can, HOLDING, loadDay, rApi, SOURCE, state, STATUS, tableNames } from './state.js';
import { go } from './nav.js';

const OCCASIONS = ['', 'Birthday', 'Anniversary', 'Date night', 'Business', 'Celebration'];

export function statusChip(status) {
  const s = STATUS[status] || { label: status, tone: '' };
  return h('span', { class: `chip ${s.tone}` }, s.label);
}

export function guestFlags(r) {
  const out = [];
  const g = r.guest;
  if (g) {
    for (const t of g.tags.slice(0, 3)) out.push(h('span', { class: `chip ${/allerg/i.test(t) ? 'danger' : /vip/i.test(t) ? 'warn' : ''}` }, t));
    if (g.noShows >= 2) out.push(h('span', { class: 'chip danger', title: 'Previous no-shows' }, `${g.noShows} no-shows`));
    // Which visit this is: completed visits so far, plus this one unless it is already counted.
    const nth = g.visits + (r.status === 'completed' ? 0 : 1);
    if (nth <= 1) out.push(h('span', { class: 'chip accent' }, 'New guest'));
    else out.push(h('span', { class: 'chip', title: 'Visit number' }, `${nth}${ordinal(nth)} visit`));
  }
  if (r.occasion) out.push(h('span', { class: 'chip info' }, r.occasion));
  return out;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// The next sensible move for a reservation, for one-tap buttons.
export function nextActions(r) {
  switch (r.status) {
    case 'booked':
    case 'confirmed':
      return [
        ['arrived', 'Arrived'],
        ['seated', 'Seat'],
      ];
    case 'arrived':
      return [['seated', 'Seat']];
    case 'seated':
      return [['completed', 'Done']];
    default:
      return [];
  }
}

export async function changeStatus(r, status, extra = {}) {
  try {
    if (status === 'cancelled') {
      const ok = await confirmDialog(`Cancel ${r.name}'s reservation for ${r.partySize}?${r.email || r.phone ? ' The guest will be notified.' : ''}`, { title: 'Cancel reservation', confirmLabel: 'Cancel reservation', danger: true });
      if (!ok) return null;
    }
    const res = await rApi(`/reservations/${r.id}/status`, { method: 'POST', body: { status, ...extra } });
    await loadDay();
    return res.reservation;
  } catch (err) {
    toastError(err);
    return null;
  }
}

export async function openReservation(id) {
  let data;
  try {
    data = await rApi(`/reservations/${id}`);
  } catch (err) {
    return toastError(err);
  }
  const body = h('div');
  const m = modal({ title: 'Reservation', wide: true, body });
  render();

  async function refresh() {
    data = await rApi(`/reservations/${id}`);
    render();
  }

  function render() {
    const r = data.reservation;
    m.el.querySelector('header h2').textContent = `${r.name} · party of ${r.partySize}`;
    const actions = [];
    if (r.status === 'booked') actions.push(['confirmed', 'Confirmed by phone']);
    for (const a of nextActions(r)) actions.push(a);
    if (['booked', 'confirmed'].includes(r.status)) actions.push(['no_show', 'No-show']);
    if (['arrived'].includes(r.status)) actions.push(['booked', 'Undo arrival']);
    if (r.status === 'seated') actions.push(['arrived', 'Undo seat']);
    if (r.status === 'completed') actions.push(['seated', 'Reopen']);
    if (['cancelled', 'no_show'].includes(r.status)) actions.push(['booked', 'Restore']);
    if (['booked', 'confirmed', 'pending', 'arrived'].includes(r.status)) actions.push(['cancelled', 'Cancel']);

    clear(
      body,
      h(
        'div',
        { class: 'row', style: { marginBottom: '6px' } },
        statusChip(r.status),
        h('span', { class: 'chip' }, SOURCE[r.source] || r.source),
        h('span', { class: 'muted small mono' }, r.code),
        r.tableLocked ? h('span', { class: 'chip', title: 'Pinned by staff: auto-seating will not move it' }, 'Table pinned') : null,
      ),
      h(
        'p',
        { style: { fontSize: '1.05rem', margin: '6px 0 10px' } },
        h('b', {}, `${fmtDate(r.date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${r.timeLabel}`),
        ` · ${r.duration} min · ${r.tableIds.length ? `Table ${tableNames(r.tableIds)}` : 'No table yet'}`,
      ),
      h(
        'div',
        { class: 'status-actions' },
        actions.map(([s, label]) =>
          h(
            'button',
            {
              class: `btn small ${s === 'cancelled' || s === 'no_show' ? 'danger' : ['seated', 'completed', 'arrived'].includes(s) ? 'primary' : ''}`,
              onclick: async () => {
                const updated = await changeStatus(r, s);
                if (updated) refresh();
              },
            },
            label,
          ),
        ),
      ),
      guestPanel(r),
      cardPanel(r),
      editForm(r),
      historyPanel(data),
    );
  }

  function guestPanel(r) {
    const g = r.guest;
    if (!g) return null;
    return h(
      'div',
      { class: 'guest-card' },
      h(
        'div',
        { class: 'row between' },
        h('b', {}, `${g.visits} visits · ${g.noShows} no-shows${g.spendCents ? ` · ${money(g.spendCents)} spent` : ''}${g.lastVisit ? ` · last ${fmtDate(g.lastVisit)}` : ''}`),
        h('button', { class: 'btn small', onclick: () => (m.close(), go('guests', g.id)) }, 'Guest profile'),
      ),
      g.tags.length ? h('div', { class: 'tagline', style: { marginTop: '6px' } }, g.tags.map((t) => h('span', { class: 'chip' }, t))) : null,
      g.notes ? h('p', { style: { margin: '6px 0 0' } }, g.notes) : null,
    );
  }

  function cardPanel(r) {
    if (!r.card) return null;
    const c = r.card;
    const fee = c.feeCents ? money(c.feeCents, { decimals: 2 }) : null;
    const label = { required: 'Card required', pending: 'Waiting for the guest to add a card', on_file: `Card on file${fee ? `, no-show fee ${fee}` : ''}`, charged: `No-show fee charged: ${money(c.chargedCents, { decimals: 2 })}`, failed: 'Charge failed' }[c.status];
    return h(
      'div',
      { class: `notice ${c.status === 'failed' ? 'danger' : c.status === 'charged' ? 'ok' : ''}` },
      h('div', { class: 'row between' }, h('span', {}, label || c.status), r.status === 'no_show' && ['on_file', 'failed'].includes(c.status) && can('manager') ? h('button', { class: 'btn small danger', onclick: charge }, `Charge ${fee || 'fee'}`) : null),
    );
    async function charge(e) {
      if (!(await confirmDialog(`Charge ${fee} to the card on file for ${r.name}?`, { title: 'Charge no-show fee', confirmLabel: 'Charge', danger: true }))) return;
      e.target.disabled = true;
      try {
        await rApi(`/reservations/${r.id}/charge`, { method: 'POST', body: {} });
        toast('Fee charged', 'ok');
        refresh();
      } catch (err) {
        toastError(err);
        refresh();
      }
    }
  }

  function editForm(r) {
    const editable = HOLDING.has(r.status);
    const tables = state.day?.tables.filter((t) => t.active) || [];
    const tableSelect = h(
      'select',
      { name: 'tables', multiple: true, size: Math.min(6, Math.max(3, tables.length)), disabled: !editable },
      tables.map((t) => h('option', { value: t.id, selected: r.tableIds.includes(t.id) }, `${t.name} (${t.min_covers}-${t.max_covers})${t.section ? ` · ${t.section}` : ''}`)),
    );
    const form = h(
      'form',
      { class: 'panel' },
      h('h3', {}, 'Details'),
      h(
        'div',
        { class: 'grid-3' },
        h('label', { class: 'field' }, h('span', {}, 'Date'), h('input', { type: 'date', name: 'date', value: r.date, disabled: !editable })),
        h('label', { class: 'field' }, h('span', {}, 'Time'), h('input', { type: 'time', name: 'time', value: fmtHHMM(r.time % 1440), step: 300, disabled: !editable })),
        h('label', { class: 'field' }, h('span', {}, 'Party'), h('input', { type: 'number', name: 'partySize', min: 1, max: 100, value: r.partySize, disabled: !editable })),
      ),
      h(
        'div',
        { class: 'grid-2' },
        h('label', { class: 'field' }, h('span', {}, 'Tables'), tableSelect, h('small', {}, 'Hold Ctrl/Cmd for more than one. Choosing tables pins them.')),
        h(
          'div',
          {},
          h('label', { class: 'field' }, h('span', {}, 'Duration (minutes)'), h('input', { type: 'number', name: 'duration', min: 15, max: 600, step: 15, value: r.duration, disabled: !editable })),
          h('label', { class: 'field' }, h('span', {}, 'Occasion'), h('select', { name: 'occasion' }, [...new Set([...OCCASIONS, r.occasion])].map((o) => h('option', { value: o, selected: o === r.occasion }, o || 'None')))),
        ),
      ),
      h(
        'div',
        { class: 'grid-3' },
        h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { name: 'name', value: r.name })),
        h('label', { class: 'field' }, h('span', {}, 'Phone'), h('input', { name: 'phone', type: 'tel', value: r.phone || '' })),
        h('label', { class: 'field' }, h('span', {}, 'Email'), h('input', { name: 'email', type: 'email', value: r.email || '' })),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Guest notes'), h('textarea', { name: 'notes', rows: 2 }, r.guestNotes || '')),
      h('label', { class: 'field' }, h('span', {}, 'Staff notes (never shown to the guest)'), h('textarea', { name: 'staffNotes', rows: 2 }, r.staffNotes || '')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'notify', checked: true }), h('span', {}, 'Tell the guest if the date, time or party size changes')),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'submit', class: 'btn primary' }, 'Save changes'),
        ['booked', 'confirmed'].includes(r.status) && (r.email || r.phone)
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn',
                onclick: async () => {
                  try {
                    await rApi(`/reservations/${r.id}/resend`, { method: 'POST', body: {} });
                    toast('Confirmation queued', 'ok');
                  } catch (err) {
                    toastError(err);
                  }
                },
              },
              'Resend confirmation',
            )
          : null,
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const patch = {
        name: f.name.value,
        phone: f.phone.value,
        email: f.email.value,
        notes: f.notes.value,
        staffNotes: f.staffNotes.value,
        occasion: f.occasion.value,
        notify: f.notify.checked,
      };
      if (editable) {
        const time = parseHHMM(f.time.value);
        if (f.date.value !== r.date) patch.date = f.date.value;
        if (time !== null && time !== r.time % 1440) patch.time = time;
        if (Number(f.partySize.value) !== r.partySize) patch.partySize = Number(f.partySize.value);
        if (Number(f.duration.value) !== r.duration) patch.duration = Number(f.duration.value);
        const chosen = [...tableSelect.selectedOptions].map((o) => Number(o.value)).sort((a, b) => a - b);
        if (chosen.join() !== [...r.tableIds].sort((a, b) => a - b).join()) patch.tableIds = chosen;
      }
      await save(r, patch);
    });
    return form;
  }

  async function save(r, patch) {
    try {
      await rApi(`/reservations/${r.id}`, { method: 'PATCH', body: patch });
      toast('Saved', 'ok');
      await loadDay();
      refresh();
    } catch (err) {
      if (err.code === 'table_conflict' && (await confirmDialog('Those tables are taken at that time. Double-book them anyway?', { title: 'Table conflict', confirmLabel: 'Double-book' }))) {
        return save(r, { ...patch, force: true });
      }
      if (err.code === 'unavailable' && (await confirmDialog(`${err.message} Save it without a table?`, { title: 'No table free', confirmLabel: 'Save without table' }))) {
        return save(r, { ...patch, allowUnassigned: true });
      }
      toastError(err);
    }
  }
}

function historyPanel(data) {
  const label = (a) =>
    ({
      'reservation.created': 'Booked',
      'reservation.updated': 'Edited',
      'reservation.reseated': 'Moved to another table automatically',
      'reservation.fee_charged': 'No-show fee charged',
      'reservation.fee_failed': 'No-show fee failed',
    })[a] || `Marked ${a.replace('reservation.', '').replace('_', '-')}`;
  return h(
    'div',
    { class: 'grid-2' },
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, 'History'),
      h('ul', { class: 'history' }, data.history.map((x) => h('li', {}, `${label(x.action)}${x.by ? ` by ${x.by}` : ''} · ${ago(x.at)}`))),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h3', {}, 'Messages and checks'),
      data.messages.length
        ? h('ul', { class: 'history' }, data.messages.map((x) => h('li', {}, `${x.kind.replace(/_/g, ' ')} by ${x.channel}: ${x.status}${x.error ? ` (${x.error})` : ''}`)))
        : h('p', { class: 'muted small' }, 'No messages sent.'),
      data.checks.map((c) => h('p', { class: 'small', style: { margin: '6px 0 0' } }, `${c.provider} check ${money(c.total_cents, { decimals: 2 })} · matched by ${c.match_method}`)),
    ),
  );
}

// New reservation (phone, walk-in, or from an empty timeline cell).
export function newReservation(prefill = {}) {
  const isToday = (prefill.date || state.date) === state.restaurant.today;
  const tables = state.day?.tables.filter((t) => t.active) || [];
  const slotsEl = h('div', { class: 'row', style: { gap: '6px', marginBottom: '12px' } });
  const guestEl = h('div');
  const form = h(
    'form',
    {},
    h(
      'div',
      { class: 'grid-3' },
      h('label', { class: 'field' }, h('span', {}, 'Date'), h('input', { type: 'date', name: 'date', value: prefill.date || state.date, required: true })),
      h('label', { class: 'field' }, h('span', {}, 'Party'), h('input', { type: 'number', name: 'partySize', min: 1, max: 100, value: prefill.partySize || 2, required: true })),
      h('label', { class: 'field' }, h('span', {}, 'Time'), h('input', { type: 'time', name: 'time', step: 300, value: prefill.time != null ? fmtHHMM(prefill.time % 1440) : '', required: true })),
    ),
    slotsEl,
    h(
      'div',
      { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Mobile phone'), h('input', { type: 'tel', name: 'phone', autocomplete: 'off' })),
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { name: 'name', required: true, autocomplete: 'off' })),
    ),
    guestEl,
    h(
      'div',
      { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Email'), h('input', { type: 'email', name: 'email', autocomplete: 'off' })),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Table'),
        h('select', { name: 'table' }, h('option', { value: '' }, 'Best fit (automatic)'), tables.map((t) => h('option', { value: t.id, selected: prefill.tableIds?.includes(t.id) }, `${t.name} (${t.min_covers}-${t.max_covers})`))),
      ),
    ),
    h(
      'div',
      { class: 'grid-3' },
      h('label', { class: 'field' }, h('span', {}, 'How they booked'), h('select', { name: 'source' }, ['phone', 'walkin', 'staff'].map((s) => h('option', { value: s, selected: s === (prefill.source || 'phone') }, SOURCE[s])))),
      h('label', { class: 'field' }, h('span', {}, 'Status'), h('select', { name: 'status' }, h('option', { value: 'booked' }, 'Booked'), h('option', { value: 'confirmed' }, 'Confirmed'), isToday ? h('option', { value: 'seated', selected: prefill.source === 'walkin' }, 'Seated now') : null)),
      h('label', { class: 'field' }, h('span', {}, 'Occasion'), h('select', { name: 'occasion' }, OCCASIONS.map((o) => h('option', { value: o }, o || 'None')))),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Guest notes'), h('textarea', { name: 'notes', rows: 2, placeholder: 'Allergies, high chair, celebrating…' })),
    h('label', { class: 'field' }, h('span', {}, 'Staff notes'), h('textarea', { name: 'staffNotes', rows: 2 })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'notify', checked: true }), h('span', {}, 'Send the guest a confirmation (email or text, per your settings)')),
    h('p', { class: 'notice danger', id: 'nr-err', hidden: true }),
  );
  const m = modal({
    title: 'New reservation',
    wide: true,
    initialFocus: 'input[name=phone]',
    body: form,
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      { label: 'Book it', primary: true, onClick: () => form.requestSubmit() },
    ],
  });
  const f = form.elements;

  const loadSlots = async () => {
    const date = f.date.value;
    const party = Number(f.partySize.value);
    if (!date || !party) return;
    try {
      const data = await rApi(`/availability?date=${date}&party=${party}`);
      const now = date === state.restaurant.today;
      clear(
        slotsEl,
        data.closed ? h('span', { class: 'chip warn' }, data.message || 'Closed: you can still book') : null,
        data.slots
          .filter((s) => !s.warnings.includes('past'))
          .slice(0, 40)
          .map((s) =>
            h(
              'button',
              {
                type: 'button',
                class: `btn small ${s.available ? '' : 'danger'}`,
                title: s.available ? `${s.warnings.includes('pacing') ? 'Over pacing limit. ' : ''}Table ${tableNames(s.tableIds || [])}` : 'No table free',
                onclick: () => (f.time.value = fmtHHMM(s.time % 1440)),
              },
              `${s.label}${s.warnings.includes('pacing') ? ' !' : ''}${s.available ? '' : ' ×'}`,
            ),
          ),
        now ? h('button', { type: 'button', class: 'btn small primary', onclick: () => setNow() }, 'Now (walk-in)') : null,
      );
    } catch (err) {
      clear(slotsEl, h('span', { class: 'muted small' }, err.message));
    }
  };
  const setNow = () => {
    const d = new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: state.restaurant.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
    const hh = parts.find((p) => p.type === 'hour').value;
    const mm = parts.find((p) => p.type === 'minute').value;
    f.time.value = `${hh}:${mm}`;
    f.source.value = 'walkin';
    if ([...f.status.options].some((o) => o.value === 'seated')) f.status.value = 'seated';
    f.notify.checked = false;
  };
  f.date.addEventListener('change', loadSlots);
  f.partySize.addEventListener('change', loadSlots);
  f.phone.addEventListener('blur', async () => {
    const digits = f.phone.value.replace(/\D/g, '');
    if (digits.length < 7) return clear(guestEl);
    try {
      const data = await rApi(`/guests?q=${digits}&limit=1`);
      const g = data.guests[0];
      if (!g) return clear(guestEl, h('p', { class: 'small muted', style: { marginTop: '-6px' } }, 'New guest.'));
      if (!f.name.value) f.name.value = g.name;
      if (!f.email.value && g.email) f.email.value = g.email;
      clear(
        guestEl,
        h('div', { class: 'guest-card' }, h('b', {}, `${g.name}: ${g.visit_count} visits, ${g.no_show_count} no-shows`), g.tags.length ? h('div', { class: 'tagline', style: { marginTop: '4px' } }, g.tags.map((t) => h('span', { class: 'chip' }, t))) : null, g.notes ? h('div', { class: 'small', style: { marginTop: '4px' } }, g.notes) : null),
      );
    } catch {
      clear(guestEl);
    }
  });
  if (prefill.source === 'walkin' && isToday) setNow();
  loadSlots();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#nr-err', form);
    err.hidden = true;
    const time = parseHHMM(f.time.value);
    if (time === null) return ((err.textContent = 'Pick a time.'), (err.hidden = false));
    if (!f.name.value.trim()) return ((err.textContent = 'Enter a name.'), (err.hidden = false));
    const body = {
      date: f.date.value,
      time,
      partySize: Number(f.partySize.value),
      name: f.name.value,
      phone: f.phone.value || undefined,
      email: f.email.value || undefined,
      source: f.source.value,
      status: f.status.value,
      occasion: f.occasion.value,
      notes: f.notes.value,
      staffNotes: f.staffNotes.value,
      notify: f.notify.checked,
      tableIds: f.table.value ? [Number(f.table.value)] : undefined,
    };
    const submit = async (extra = {}) => {
      try {
        const res = await rApi('/reservations', { method: 'POST', body: { ...body, ...extra } });
        m.close();
        toast(`Booked ${res.reservation.name} for ${res.reservation.partySize} at ${fmt12(res.reservation.time)}`, 'ok');
        if (res.warnings?.includes('pacing')) toast('Heads up: that slot is over your pacing limit.', 'info', 5000);
        if (body.date === state.date) loadDay();
      } catch (e2) {
        if (e2.code === 'table_conflict' && (await confirmDialog('That table is taken then. Double-book it anyway?', { title: 'Table conflict', confirmLabel: 'Double-book' }))) return submit({ ...extra, force: true });
        if (e2.code === 'unavailable' && (await confirmDialog(`${e2.message} Book it without a table and sort it out on the floor?`, { title: 'No table free', confirmLabel: 'Book without table' }))) return submit({ ...extra, allowUnassigned: true });
        err.textContent = e2.message;
        err.hidden = false;
      }
    };
    submit();
  });
}
