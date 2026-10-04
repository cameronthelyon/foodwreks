// Guest-facing waitlist status. Refreshes itself every 30 seconds.

import { $, api, applyTheme, clear, confirmDialog, h, toastError } from './lib.js';

applyTheme();
const id = location.pathname.split('/').pop();
const params = new URLSearchParams(location.search);
const token = params.get('t');
if (params.get('embed') === '1') document.body.classList.add('embed');
const app = $('#app');
let timer;

async function load() {
  try {
    render(await api(`/api/public/w/${encodeURIComponent(id)}?t=${encodeURIComponent(token || '')}`));
  } catch (err) {
    clearInterval(timer);
    clear(app, h('div', { class: 'empty-state' }, h('strong', {}, 'We could not find your spot.'), h('p', {}, err.message)));
  }
}

function render(s) {
  $('#r-name').textContent = s.restaurant.name;
  const open = ['waiting', 'notified'].includes(s.status);
  if (!open) clearInterval(timer);
  const message = {
    waiting: 'You are on the list. We will text you when your table is ready.',
    notified: 'Your table is ready! Please head to the host stand.',
    seated: 'Enjoy your meal.',
    left: 'You are no longer on the list.',
    cancelled: 'You left the list. Come back any time.',
  }[s.status];
  clear(
    app,
    h(
      'div',
      { class: 'confirm' },
      open && s.status === 'waiting' ? [h('p', { class: 'muted', style: { margin: 0 } }, 'Your place in line'), h('div', { class: 'big-number' }, String(s.position))] : null,
      s.status === 'notified' ? h('div', { class: 'tick' }, '✓') : null,
      h('h2', { style: { marginTop: '10px' } }, `${s.name}, party of ${s.partySize}`),
      h('p', {}, message),
      open && s.quotedMin ? h('p', { class: 'muted' }, `Quoted wait about ${s.quotedMin} min · waiting ${s.waitedMin} min`) : null,
      open
        ? h(
            'button',
            {
              class: 'btn danger',
              onclick: async () => {
                if (!(await confirmDialog('Leave the waitlist?', { confirmLabel: 'Leave', danger: true }))) return;
                try {
                  render(await api(`/api/public/w/${encodeURIComponent(id)}/leave?t=${encodeURIComponent(token)}`, { method: 'POST', body: {} }));
                } catch (err) {
                  toastError(err);
                }
              },
            },
            'Leave the list',
          )
        : null,
      s.restaurant.phone ? h('p', { class: 'small muted', style: { marginTop: '14px' } }, 'Questions? ', h('a', { href: `tel:${s.restaurant.phone}` }, s.restaurant.phone)) : null,
    ),
  );
}

load();
timer = setInterval(load, 30_000);
