// Staff app shell: auth, routing, top bar, live updates, search, shortcuts.

import { $, addDays, api, applyTheme, clear, debounce, fmtDate, fmtPhone, h, modal, toastError } from '../lib.js';
import { can, emit, loadDay, loadRestaurant, on, rApi, state, STATUS, today } from './state.js';
import { icon } from './icons.js';
import { newReservation, openReservation } from './reservation.js';
import { DATED, go, setDate } from './nav.js';
import * as bookView from './book.js';
import * as floorView from './floor.js';
import * as waitlistView from './waitlist.js';
import * as guestsView from './guests.js';
import * as reportsView from './reports.js';
import * as settingsView from './settings.js';

applyTheme();

const VIEWS = {
  book: { label: 'Book', icon: 'book', mod: bookView, dated: true },
  floor: { label: 'Floor', icon: 'floor', mod: floorView, dated: true },
  waitlist: { label: 'Waitlist', icon: 'clock', mod: waitlistView },
  guests: { label: 'Guests', icon: 'users', mod: guestsView },
  reports: { label: 'Reports', icon: 'chart', mod: reportsView, role: 'manager' },
  settings: { label: 'Settings', icon: 'gear', mod: settingsView },
};

let cleanup = null;
let events = null;

async function boot() {
  try {
    state.me = await api('/api/auth/me');
  } catch {
    location.href = `/login?next=${encodeURIComponent(`/app${location.hash}`)}`;
    return;
  }
  window.addEventListener('unauthenticated', () => (location.href = `/login?next=${encodeURIComponent(`/app${location.hash}`)}`));
  if (!state.me.memberships.length) {
    clear(
      $('#root'),
      h('div', { class: 'page-center' }, h('div', { class: 'card narrow' }, h('h1', {}, 'No restaurant yet'), h('p', {}, 'This account is not on any restaurant team.'), state.me.user.isPlatformAdmin ? h('a', { class: 'btn primary', href: '/admin' }, 'Open admin') : h('a', { class: 'btn', href: '/signup' }, 'Create a restaurant'))),
    );
    return;
  }
  let saved = null;
  try {
    saved = Number(localStorage.getItem('rid'));
  } catch {
    /* no storage */
  }
  state.rid = state.me.memberships.some((m) => m.restaurantId === saved) ? saved : state.me.memberships[0].restaurantId;
  await loadRestaurant();
  state.date = today();
  renderShell();
  watchServiceDay();
  window.addEventListener('hashchange', route);
  route();
  connectEvents();
  on('restaurant', () => {
    renderBanner();
    $('#r-switch') && ($('#r-switch').value = String(state.rid));
  });
  on('waitlist-changed', (e) => (!e.detail || e.detail === today()) && updateCounts());
  on('date', updateTopbar);
  updateCounts();
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [view, arg] = (path || 'book').split('/');
  return { view: VIEWS[view] ? view : 'book', arg: arg ? decodeURIComponent(arg) : null, query: new URLSearchParams(qs || '') };
}

function route() {
  const r = parseHash();
  state.route = r;
  const def = VIEWS[r.view];
  if (def.role && !can(def.role)) return go('book');
  if (def.dated && r.arg && /^\d{4}-\d{2}-\d{2}$/.test(r.arg) && r.arg !== state.date) {
    state.date = r.arg;
    state.day = null;
  }
  for (const a of document.querySelectorAll('.nav a.item')) a.setAttribute('aria-current', a.dataset.view === r.view ? 'page' : 'false');
  updateTopbar();
  cleanup?.();
  const view = clear($('#view'));
  cleanup = def.mod.render(view, r) || null;
  if (def.dated && (!state.day || state.day.date !== state.date)) loadDay().catch(toastError);
  else if (!state.day) loadDay().catch(toastError);
}

function renderShell() {
  const brand = document.body.dataset.brand;
  const nav = h(
    'aside',
    { class: 'nav' },
    h('a', { class: 'logo', href: '/app' }, logoSvg(), brand),
    state.me.memberships.length > 1
      ? h(
          'select',
          {
            id: 'r-switch',
            'aria-label': 'Restaurant',
            onchange: async (e) => {
              state.rid = Number(e.target.value);
              try {
                localStorage.setItem('rid', String(state.rid));
              } catch {
                /* ignore */
              }
              location.hash = '#/book';
              location.reload();
            },
          },
          state.me.memberships.map((m) => h('option', { value: m.restaurantId, selected: m.restaurantId === state.rid }, m.name)),
        )
      : h('div', { class: 'small muted r-name', style: { padding: '0 10px 10px', fontWeight: 600 } }, state.restaurant.name),
    Object.entries(VIEWS)
      .filter(([, v]) => !v.role || can(v.role))
      .map(([key, v]) =>
        h(
          'a',
          { class: 'item', href: `#/${key}${v.dated ? `/${state.date}` : ''}`, dataset: { view: key }, onclick: (e) => v.dated && ((e.currentTarget.href = `#/${key}/${state.date}`)) },
          icon(v.icon),
          v.label,
          key === 'waitlist' ? h('span', { class: 'count', id: 'wl-count' }) : null,
        ),
      ),
    h(
      'div',
      { class: 'foot' },
      h('div', { style: { padding: '0 10px 6px' } }, state.me.user.name || state.me.user.email, h('br'), h('span', { class: 'small' }, `${state.restaurant.role}`)),
      h('button', { class: 'btn ghost small', onclick: cycleTheme }, icon('moon'), 'Theme'),
      state.me.user.isPlatformAdmin ? h('a', { class: 'btn ghost small', href: '/admin', style: { justifyContent: 'flex-start', width: '100%' } }, icon('shield'), 'Admin') : null,
      h(
        'button',
        {
          class: 'btn ghost small',
          onclick: async () => {
            await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
            location.href = '/login';
          },
        },
        icon('out'),
        'Log out',
      ),
    ),
  );
  const top = h('header', { class: 'topbar', id: 'topbar' });
  clear($('#root'), h('div', { class: 'shell' }, nav, h('div', { class: 'main' }, top, h('div', { class: 'banner', id: 'banner' }), h('main', { class: 'view', id: 'view' }))));
  renderBanner();
  document.addEventListener('keydown', shortcuts);
}

function logoSvg() {
  const span = document.createElement('span');
  span.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true" width="26" height="26"><rect width="32" height="32" rx="7" fill="#1F4D3F"/><path d="M10 6h12v20l-6-4.6L10 26z" fill="#F6F2EA"/></svg>';
  return span.firstChild;
}

function updateTopbar() {
  const def = VIEWS[state.route.view];
  const top = $('#topbar');
  if (!top) return;
  const current = today();
  const isToday = state.date === current;
  const dateLabel = isToday ? 'Today' : fmtDate(state.date, { weekday: 'short', month: 'short', day: 'numeric' });
  clear(
    top,
    def.dated
      ? h(
          'div',
          { class: 'datenav' },
          h('button', { class: 'btn ghost small', 'aria-label': 'Previous day', onclick: () => setDate(addDays(state.date, -1)) }, icon('left')),
          h('span', { class: 'label' }, dateLabel),
          h('button', { class: 'btn ghost small', 'aria-label': 'Next day', onclick: () => setDate(addDays(state.date, 1)) }, icon('right')),
          isToday ? null : h('button', { class: 'btn small', onclick: () => setDate(current) }, 'Today'),
          h('input', { type: 'date', value: state.date, 'aria-label': 'Pick a date', onchange: (e) => e.target.value && setDate(e.target.value) }),
        )
      : h('h1', {}, def.label),
    h('div', { class: 'spacer' }),
    searchBox(),
    h('span', { class: `live ${events?.readyState === 1 ? 'on' : ''}`, id: 'live', title: 'Live updates' }),
    h('button', { class: 'btn primary', onclick: () => newReservation({ date: state.date }) }, icon('plus'), 'New'),
    h('button', { class: 'btn ghost small mobile-only', 'aria-label': 'Account menu', onclick: accountMenu }, '\u22ef'),
  );
}

// Phones and portrait tablets hide the sidebar footer; same actions here.
function accountMenu() {
  const m = modal({
    title: state.me.user.name || state.me.user.email,
    body: h(
      'div',
      { class: 'stack' },
      state.me.memberships.length > 1
        ? h(
            'label',
            { class: 'field' },
            h('span', {}, 'Restaurant'),
            h(
              'select',
              {
                onchange: (e) => {
                  try {
                    localStorage.setItem('rid', e.target.value);
                  } catch {
                    /* ignore */
                  }
                  location.hash = '#/book';
                  location.reload();
                },
              },
              state.me.memberships.map((x) => h('option', { value: x.restaurantId, selected: x.restaurantId === state.rid }, x.name)),
            ),
          )
        : h('p', { class: 'muted small', style: { margin: 0 } }, state.restaurant.name),
      h('button', { class: 'btn block', onclick: () => (cycleTheme(), m.close()) }, 'Switch theme'),
      state.me.user.isPlatformAdmin ? h('a', { class: 'btn block', href: '/admin' }, 'Admin') : null,
      h(
        'button',
        {
          class: 'btn block danger',
          onclick: async () => {
            await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
            location.href = '/login';
          },
        },
        'Log out',
      ),
    ),
  });
}

function searchBox() {
  const results = h('div', { class: 'search-results', hidden: true });
  const input = h('input', { type: 'search', placeholder: 'Search name, phone, code', id: 'search', 'aria-label': 'Search' });
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return (results.hidden = true);
    try {
      const data = await rApi(`/search?q=${encodeURIComponent(q)}`);
      clear(
        results,
        data.reservations.length ? h('h4', {}, 'Reservations') : null,
        data.reservations.map((r) =>
          h(
            'button',
            {
              onclick: () => {
                results.hidden = true;
                input.value = '';
                // The book and floor follow it to its day; other screens stay
                // put (the dialog loads its own floor), so a quick lookup
                // from the waitlist lands back on the waitlist.
                if (DATED.has(state.route.view) && r.date !== state.date) go(state.route.view, r.date);
                openReservation(r.id);
              },
            },
            h('b', {}, `${r.name} · ${r.partySize}`),
            h('div', { class: 'small muted' }, `${fmtDate(r.date)} ${r.timeLabel} · ${STATUS[r.status]?.label} · ${r.code}`),
          ),
        ),
        data.guests.length ? h('h4', {}, 'Guests') : null,
        data.guests.map((g) =>
          h(
            'button',
            { onclick: () => ((results.hidden = true), (input.value = ''), go('guests', g.id)) },
            h('b', {}, g.name),
            h('div', { class: 'small muted' }, [fmtPhone(g.phone), g.email, `${g.visit_count} visits`].filter(Boolean).join(' · ')),
          ),
        ),
        !data.reservations.length && !data.guests.length ? h('p', { class: 'muted small', style: { padding: '10px 12px', margin: 0 } }, 'No matches.') : null,
      );
      results.hidden = false;
    } catch (err) {
      toastError(err);
    }
  }, 220);
  input.addEventListener('input', run);
  const wrap = h('div', { class: 'search' }, icon('search'), input, results);
  const items = () => [...results.querySelectorAll('button')];
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      results.hidden = true;
      input.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = items();
      if (!list.length || results.hidden) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : i <= 0 ? -1 : i - 1;
      (next < 0 ? input : list[next]).focus();
    }
  });
  // Hide only when focus leaves the whole search box, so Tab and arrows can
  // reach the results.
  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) setTimeout(() => !wrap.contains(document.activeElement) && (results.hidden = true), 150);
  });
  return wrap;
}

function renderBanner() {
  const el = $('#banner');
  if (!el) return;
  const l = state.restaurant.license;
  const owner = can('owner');
  const activate = h('a', { class: 'btn small primary', href: '#/settings/license' }, 'Activate lifetime license');
  if (l.kind === 'trial' && l.active) {
    clear(el, l.daysLeft <= 14 ? h('div', { class: 'notice' }, h('span', {}, `Free trial: ${l.daysLeft} ${l.daysLeft === 1 ? 'day' : 'days'} left.`), owner ? activate : null) : null);
  } else if (!l.active) {
    clear(
      el,
      h('div', { class: 'notice warn' }, h('span', {}, l.kind === 'suspended' ? 'This account is suspended. Online booking is paused.' : 'Your trial has ended. Online booking is paused; everything else still works, including exports.'), owner ? activate : null),
    );
  } else clear(el);
  if (!state.restaurant.onlineBooking && l.active) el.appendChild(h('div', { class: 'notice warn', style: { marginTop: '8px' } }, 'Online booking is switched off in Settings.'));
}

// The Waitlist badge counts today's open parties, whatever day the book shows.
const updateCounts = debounce(async () => {
  try {
    const list = await rApi(`/waitlist?date=${today()}`);
    const n = list.filter((w) => ['waiting', 'notified'].includes(w.status)).length;
    const el = $('#wl-count');
    if (el) el.textContent = n ? String(n) : '';
  } catch {
    /* keep the last count */
  }
}, 300);

function connectEvents() {
  events?.close();
  events = new EventSource(`/api/r/${state.rid}/events`);
  const live = (on) => $('#live')?.classList.toggle('on', on);
  const refresh = debounce(() => loadDay().catch(() => {}), 300);
  // Events missed while disconnected are not replayed, so every (re)connect
  // reloads what is on screen.
  events.onopen = () => {
    live(true);
    refresh();
    emit('waitlist-changed');
  };
  events.onerror = () => live(false);
  for (const type of ['reservations', 'waitlist']) {
    events.addEventListener(type, (e) => {
      const data = JSON.parse(e.data || '{}');
      if (!data.date || data.date === state.date) refresh();
      if (type === 'waitlist') emit('waitlist-changed', data.date);
    });
  }
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && (refresh(), emit('waitlist-changed')));
  setInterval(() => document.visibilityState === 'visible' && refresh(), 120_000);
  events.addEventListener('config', () => {
    loadRestaurant().catch(() => {});
    refresh();
  });
}

// At the 4 AM turnover, a host still looking at "today" moves to the new day.
function watchServiceDay() {
  let last = today();
  setInterval(() => {
    const now = today();
    if (now === last) return;
    const wasToday = state.date === last;
    last = now;
    if (wasToday) setDate(now);
    else updateTopbar();
    emit('waitlist-changed', now);
  }, 60_000);
}

function cycleTheme() {
  const order = ['system', 'dark', 'light'];
  let current = 'system';
  try {
    current = localStorage.getItem('theme') || 'system';
  } catch {
    /* ignore */
  }
  const next = order[(order.indexOf(current) + 1) % order.length];
  try {
    if (next === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', next);
  } catch {
    /* ignore */
  }
  if (next === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
}

function shortcuts(e) {
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('.backdrop')) return;
  if (e.key === 'n') {
    e.preventDefault();
    newReservation({ date: state.date });
  } else if (e.key === '/') {
    e.preventDefault();
    $('#search')?.focus();
  } else if (VIEWS[state.route.view].dated && e.key === 'ArrowLeft') setDate(addDays(state.date, -1));
  else if (VIEWS[state.route.view].dated && e.key === 'ArrowRight') setDate(addDays(state.date, 1));
  else if (e.key === 't') setDate(today());
}

boot().catch((err) => {
  clear($('#root'), h('div', { class: 'page-center' }, h('div', { class: 'card narrow' }, h('h1', {}, 'Could not load'), h('p', {}, err.message))));
});
