// Platform admin: restaurants, licenses, delivery and integration health.

import { $, ago, api, applyTheme, clear, confirmDialog, h, toast, toastError } from './lib.js';

applyTheme();
const app = $('#app');

async function load() {
  try {
    const [restaurants, health] = await Promise.all([api('/api/admin/restaurants'), api('/api/admin/health')]);
    render(restaurants, health);
  } catch (err) {
    if (err.status === 401) location.href = '/login?next=/admin';
    else clear(app, h('p', { class: 'notice danger' }, err.status === 404 ? 'This page is for platform administrators.' : err.message));
  }
}

function render(restaurants, health) {
  const sent = health.outbox.filter((o) => o.status === 'sent').reduce((a, o) => a + o.n, 0);
  const failed = health.outbox.filter((o) => o.status === 'failed').reduce((a, o) => a + o.n, 0);
  clear(
    app,
    h(
      'div',
      { class: 'kpis' },
      kpi(health.restaurants, 'restaurants'),
      kpi(health.lifetime, 'lifetime licenses'),
      kpi(health.reservations30d, 'bookings, last 30 days'),
      kpi(`${sent} / ${failed}`, 'messages sent / failed (7 days)'),
    ),
    health.integrationErrors.length
      ? h('div', { class: 'notice danger' }, h('b', {}, 'Integration errors'), h('ul', {}, health.integrationErrors.map((e) => h('li', {}, `Restaurant ${e.restaurant_id} · ${e.provider}: ${e.last_error}`))))
      : null,
    health.recentFailures.length
      ? h('details', { class: 'panel' }, h('summary', {}, `Recent delivery failures (${health.recentFailures.length})`), h('ul', { class: 'small' }, health.recentFailures.map((f) => h('li', {}, `${ago(f.created_at)} · restaurant ${f.restaurant_id} · ${f.kind} by ${f.channel}: ${f.error}`))))
      : null,
    h(
      'div',
      { class: 'panel', style: { padding: 0, overflowX: 'auto' } },
      h(
        'table',
        { class: 'data' },
        h('thead', {}, h('tr', {}, ['Restaurant', 'Owners', 'License', 'Bookings', 'Last booking', ''].map((c) => h('th', {}, c)))),
        h(
          'tbody',
          {},
          restaurants.map((r) =>
            h(
              'tr',
              {},
              h('td', {}, h('b', {}, r.name), h('div', { class: 'small muted' }, `/r/${r.slug} · since ${new Date(r.createdAt).toLocaleDateString()}`)),
              h('td', { class: 'small' }, r.owners || ''),
              h('td', {}, licenseChip(r.license), r.licenseRef ? h('div', { class: 'small muted' }, r.licenseRef) : null),
              h('td', {}, String(r.reservations)),
              h('td', { class: 'small' }, r.lastBookingAt ? ago(r.lastBookingAt) : 'Never'),
              h('td', {}, licenseMenu(r)),
            ),
          ),
        ),
      ),
    ),
  );
}

function kpi(v, k) {
  return h('div', { class: 'kpi' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k));
}

function licenseChip(l) {
  if (l.kind === 'lifetime') return h('span', { class: 'chip ok' }, 'Lifetime');
  if (l.kind === 'comped') return h('span', { class: 'chip ok' }, 'Comped');
  if (l.kind === 'suspended') return h('span', { class: 'chip danger' }, 'Suspended');
  return h('span', { class: `chip ${l.active ? 'info' : 'warn'}` }, l.active ? `Trial, ${l.daysLeft} d left` : 'Trial ended');
}

function licenseMenu(r) {
  const select = h(
    'select',
    { 'aria-label': `License for ${r.name}`, style: { width: 'auto', minHeight: '32px' } },
    h('option', { value: '' }, 'Change license…'),
    h('option', { value: 'lifetime' }, 'Mark lifetime (paid offline)'),
    h('option', { value: 'comped' }, 'Comp'),
    h('option', { value: 'trial' }, 'Extend trial 14 days'),
    h('option', { value: 'suspended' }, 'Suspend'),
  );
  select.addEventListener('change', async () => {
    const status = select.value;
    if (!status) return;
    let ref = null;
    if (status === 'lifetime') ref = prompt('Payment reference (check number, invoice):') || null;
    if (!(await confirmDialog(`Set ${r.name} to "${status}"?`, { confirmLabel: 'Apply', danger: status === 'suspended' }))) {
      select.value = '';
      return;
    }
    try {
      await api(`/api/admin/restaurants/${r.id}/license`, { method: 'POST', body: { status, ref, trialDays: 14 } });
      toast('License updated', 'ok');
      load();
    } catch (err) {
      toastError(err);
    }
  });
  return select;
}

load();
