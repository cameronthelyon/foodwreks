// Guest book: search, tags, profiles, history, merge duplicates.

import { clear, confirmDialog, debounce, fmtDate, fmtPhone, h, modal, money, toast, toastError } from '../lib.js';
import { can, rApi, state } from './state.js';
import { go } from './nav.js';
import { openReservation, statusChip } from './reservation.js';

let query = { q: '', tag: '', sort: 'recent', offset: 0 };

export function render(root, route) {
  const results = h('div');
  const tagsEl = h('div', { class: 'tabs' });
  const search = h('input', { type: 'search', placeholder: 'Search guests by name, phone or email', value: query.q, 'aria-label': 'Search guests' });
  const sort = h(
    'select',
    { 'aria-label': 'Sort', style: { width: 'auto' } },
    [
      ['recent', 'Recent visits'],
      ['visits', 'Most visits'],
      ['spend', 'Highest spend'],
      ['noshows', 'Most no-shows'],
      ['name', 'Name'],
    ].map(([v, l]) => h('option', { value: v, selected: query.sort === v }, l)),
  );
  const load = async (append = false) => {
    try {
      const params = new URLSearchParams({ q: query.q, tag: query.tag, sort: query.sort, offset: String(query.offset), limit: '50' });
      const data = await rApi(`/guests?${params}`);
      paintTags(tagsEl, data.tags, load);
      paintResults(results, data, append, load);
    } catch (err) {
      toastError(err);
    }
  };
  search.addEventListener(
    'input',
    debounce(() => {
      query = { ...query, q: search.value.trim(), offset: 0 };
      load();
    }, 250),
  );
  sort.addEventListener('change', () => {
    query = { ...query, sort: sort.value, offset: 0 };
    load();
  });
  clear(root, h('div', { class: 'row', style: { marginBottom: '10px' } }, h('div', { style: { flex: 1, minWidth: '220px' } }, search), sort), tagsEl, results);
  load();
  if (route.arg) openGuest(Number(route.arg));
}

function paintTags(el, tags, reload) {
  clear(
    el,
    tags.length ? h('button', { 'aria-pressed': String(!query.tag), onclick: () => ((query = { ...query, tag: '', offset: 0 }), reload()) }, 'All guests') : null,
    tags.slice(0, 15).map((t) => h('button', { 'aria-pressed': String(query.tag === t), onclick: () => ((query = { ...query, tag: t, offset: 0 }), reload()) }, t)),
  );
}

function paintResults(el, data, append, reload) {
  const rows = data.guests.map((g) =>
    h(
      'tr',
      { class: 'clickable', onclick: () => go('guests', g.id) },
      h('td', {}, h('b', {}, g.name), h('div', { class: 'tagline' }, g.tags.slice(0, 4).map((t) => h('span', { class: 'chip' }, t)))),
      h('td', {}, fmtPhone(g.phone), h('div', { class: 'small muted' }, g.email || '')),
      h('td', {}, String(g.visit_count)),
      h('td', {}, g.no_show_count ? h('span', { class: 'chip danger' }, String(g.no_show_count)) : '0'),
      h('td', {}, g.total_spend_cents ? money(g.total_spend_cents) : ''),
      h('td', {}, g.last_visit_date ? fmtDate(g.last_visit_date) : ''),
    ),
  );
  if (append) {
    el.querySelector('tbody')?.append(...rows);
  } else {
    clear(
      el,
      h('p', { class: 'small muted' }, `${data.total} ${data.total === 1 ? 'guest' : 'guests'}`),
      data.total
        ? h(
            'div',
            { class: 'panel', style: { padding: 0, overflowX: 'auto' } },
            h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Guest', 'Contact', 'Visits', 'No-shows', 'Spend', 'Last visit'].map((c) => h('th', {}, c)))), h('tbody', {}, rows)),
          )
        : h('div', { class: 'empty' }, h('strong', {}, 'No guests found.'), 'Guests appear here as they book. You can also import a list in Settings.'),
    );
  }
  el.querySelector('.more')?.remove();
  const shown = el.querySelectorAll('tbody tr').length;
  if (shown < data.total) {
    el.append(h('p', { class: 'more' }, h('button', { class: 'btn', onclick: () => ((query.offset = shown), reload(true)) }, 'Show more')));
  }
}

async function openGuest(id) {
  let data;
  try {
    data = await rApi(`/guests/${id}`);
  } catch (err) {
    toastError(err);
    return go('guests');
  }
  const body = h('div');
  const m = modal({ title: data.guest.name, wide: true, body, onClose: () => location.hash.startsWith(`#/guests/${id}`) && history.replaceState(null, '', '#/guests') });
  const paint = () => {
    const g = data.guest;
    const form = h(
      'form',
      { class: 'panel' },
      h(
        'div',
        { class: 'grid-2' },
        h('label', { class: 'field' }, h('span', {}, 'First name'), h('input', { name: 'firstName', value: g.first_name })),
        h('label', { class: 'field' }, h('span', {}, 'Last name'), h('input', { name: 'lastName', value: g.last_name })),
        h('label', { class: 'field' }, h('span', {}, 'Phone'), h('input', { name: 'phone', type: 'tel', value: g.phone || '' })),
        h('label', { class: 'field' }, h('span', {}, 'Email'), h('input', { name: 'email', type: 'email', value: g.email || '' })),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Tags'), h('input', { name: 'tags', value: g.tags.join(', '), placeholder: 'VIP, Allergy: nuts, Regular' }), h('small', {}, 'Comma separated. Tags show on every reservation.')),
      h('label', { class: 'field' }, h('span', {}, 'Notes'), h('textarea', { name: 'notes', rows: 3 }, g.notes || '')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'marketingOptIn', checked: g.marketing_opt_in }), h('span', {}, 'Agreed to marketing messages')),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save guest'), can('manager') ? h('button', { type: 'button', class: 'btn', onclick: () => merge(g) }, 'Merge a duplicate into this guest') : null),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      try {
        data.guest = await rApi(`/guests/${g.id}`, {
          method: 'PATCH',
          body: { firstName: f.firstName.value, lastName: f.lastName.value, phone: f.phone.value, email: f.email.value, notes: f.notes.value, tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean), marketingOptIn: f.marketingOptIn.checked },
        });
        toast('Guest saved', 'ok');
        paint();
      } catch (err) {
        toastError(err);
      }
    });
    clear(
      body,
      h(
        'div',
        { class: 'kpis' },
        kpi(g.visit_count, 'visits'),
        kpi(g.no_show_count, 'no-shows'),
        kpi(g.cancel_count, 'late cancels'),
        kpi(g.total_spend_cents ? money(g.total_spend_cents) : 'None', 'spend (POS)'),
        kpi(g.last_visit_date ? fmtDate(g.last_visit_date) : 'Never', 'last visit'),
      ),
      form,
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'History'),
        data.reservations.length
          ? h(
              'table',
              { class: 'data' },
              h('tbody', {}, data.reservations.map((r) => h('tr', { class: 'clickable', onclick: () => (m.close(), openReservation(r.id)) }, h('td', {}, fmtDate(r.date, { year: 'numeric', month: 'short', day: 'numeric' })), h('td', {}, r.timeLabel), h('td', {}, `${r.partySize} guests`), h('td', {}, statusChip(r.status)), h('td', { class: 'small muted' }, r.guestNotes || '')))),
            )
          : h('p', { class: 'muted' }, 'No reservations yet.'),
      ),
    );
  };
  const merge = (g) => {
    const results = h('div');
    const input = h('input', { type: 'search', placeholder: 'Find the duplicate by name, phone or email' });
    input.addEventListener(
      'input',
      debounce(async () => {
        const q = input.value.trim();
        if (q.length < 2) return clear(results);
        const found = (await rApi(`/guests?q=${encodeURIComponent(q)}&limit=8`)).guests.filter((x) => x.id !== g.id);
        clear(
          results,
          found.map((x) =>
            h(
              'button',
              {
                class: 'btn block',
                style: { justifyContent: 'flex-start', marginBottom: '6px' },
                onclick: async () => {
                  if (!(await confirmDialog(`Merge ${x.name} (${x.visit_count} visits) into ${g.name}? History moves over and ${x.name} is removed.`, { confirmLabel: 'Merge' }))) return;
                  try {
                    data.guest = await rApi(`/guests/${g.id}/merge`, { method: 'POST', body: { otherId: x.id } });
                    data = await rApi(`/guests/${g.id}`);
                    pick.close();
                    toast('Guests merged', 'ok');
                    paint();
                  } catch (err) {
                    toastError(err);
                  }
                },
              },
              `${x.name} · ${[x.phone, x.email].filter(Boolean).join(' · ')} · ${x.visit_count} visits`,
            ),
          ),
        );
      }, 250),
    );
    const pick = modal({ title: `Merge into ${g.name}`, initialFocus: 'input', body: h('div', {}, input, h('div', { style: { marginTop: '10px' } }, results)) });
  };
  paint();
}

function kpi(v, k) {
  return h('div', { class: 'kpi' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k));
}
