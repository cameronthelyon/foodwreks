// Reports: one date-range filter row scoping a KPI row and four charts.
// Charts are single-series (one validated hue), with per-bar hover/focus
// tooltips and a table view under each, so no value hides behind a hover.

import { addDays, clear, fmt12, fmtDate, h, money, pct, toastError } from '../lib.js';
import { rApi, SOURCE, state } from './state.js';

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

let range = null;

export function render(root) {
  const today = state.restaurant.today;
  range ||= { preset: '30', from: addDays(today, -29), to: today };
  const body = h('div', { class: 'reports-body' });
  const filters = h('div', { class: 'row', style: { marginBottom: '14px' } });
  const presets = [
    ['7', 'Last 7 days', addDays(today, -6), today],
    ['30', 'Last 30 days', addDays(today, -29), today],
    ['90', 'Last 90 days', addDays(today, -89), today],
    ['month', 'This month', `${today.slice(0, 8)}01`, today],
  ];
  const from = h('input', { type: 'date', value: range.from, 'aria-label': 'From', style: { width: 'auto' } });
  const to = h('input', { type: 'date', value: range.to, 'aria-label': 'To', style: { width: 'auto' } });
  const paintFilters = () =>
    clear(
      filters,
      h(
        'div',
        { class: 'tabs', style: { margin: 0 } },
        presets.map(([key, label, f, t]) => h('button', { 'aria-pressed': String(range.preset === key), onclick: () => ((range = { preset: key, from: f, to: t }), (from.value = f), (to.value = t), paintFilters(), load()) }, label)),
      ),
      h('span', { class: 'muted small' }, 'or'),
      from,
      h('span', { class: 'muted' }, '–'),
      to,
    );
  const onCustom = () => {
    if (!from.value || !to.value) return;
    range = { preset: 'custom', from: from.value, to: to.value };
    paintFilters();
    load();
  };
  from.addEventListener('change', onCustom);
  to.addEventListener('change', onCustom);

  const load = async () => {
    body.classList.add('loading');
    try {
      const data = await rApi(`/reports?from=${range.from}&to=${range.to}`);
      paint(body, data);
    } catch (err) {
      toastError(err);
    } finally {
      body.classList.remove('loading');
    }
  };
  paintFilters();
  clear(root, filters, clear(body, h('p', { class: 'muted small' }, 'Loading…')));
  load();
}

function tile(value, label, sub) {
  return h('div', { class: 'kpi' }, h('div', { class: 'v' }, value), h('div', { class: 'k' }, label), sub ? h('div', { class: 's' }, sub) : null);
}

function paint(root, d) {
  const t = d.totals;
  const r = d.rates;
  const days = [];
  for (let x = d.from; x <= d.to; x = addDays(x, 1)) days.push(x);
  const byDay = new Map(d.byDay.map((x) => [x.date, x]));
  const hours = Object.keys(d.byHour).map(Number).sort((a, b) => a - b);
  const sizes = Object.keys(d.bySize).map(Number).sort((a, b) => a - b);
  const sources = Object.entries(d.bySource).sort((a, b) => b[1].covers - a[1].covers);
  const maxSource = Math.max(1, ...sources.map(([, v]) => v.covers));

  clear(
    root,
    h(
      'div',
      { class: 'kpis' },
      tile(t.seatedCovers.toLocaleString(), 'Covers seated', `${t.seatedParties.toLocaleString()} parties`),
      tile(pct(r.noShowRate, 1), 'No-show rate', `${t.noShows} parties, ${t.noShowCovers} covers`),
      tile(t.cancelled.toLocaleString(), 'Cancellations', `${t.cancelledByGuest} by guests`),
      tile(pct(r.returningShare), 'Returning guests', 'of seated parties'),
      tile(r.avgPartySize ? r.avgPartySize.toFixed(1) : 'n/a', 'Average party'),
      r.avgSpendPerCoverCents ? tile(money(r.avgSpendPerCoverCents, { decimals: 2 }), 'Spend per cover', 'from your POS') : null,
      t.walkIns ? tile(t.walkIns.toLocaleString(), 'Walk-in parties') : null,
    ),
    t.unresolved
      ? h('p', { class: 'notice warn' }, `${t.unresolved} past ${t.unresolved === 1 ? 'reservation was' : 'reservations were'} never marked seated or no-show. They are left out of the rates above rather than guessed. Close them out on the Book view to keep numbers honest.`)
      : null,
    h(
      'div',
      { class: 'charts' },
      h(
        'div',
        { class: 'panel chart', style: { gridColumn: '1 / -1' } },
        h('h3', {}, 'Covers seated per day'),
        columnChart(
          days.map((x) => ({ label: fmtDate(x, { month: 'short', day: 'numeric' }), long: fmtDate(x, { weekday: 'short', month: 'short', day: 'numeric' }), value: byDay.get(x)?.covers || 0 })),
          { height: 220, unit: 'covers', wide: true },
        ),
      ),
      h(
        'div',
        { class: 'panel chart' },
        h('h3', {}, 'Where bookings came from'),
        h('p', { class: 'small muted', style: { marginTop: '-4px' } }, 'Covers booked, by channel (cancellations excluded)'),
        sources.length
          ? sources.map(([s, v]) =>
              h(
                'div',
                { class: 'hbar' },
                h('span', {}, SOURCE[s] || s),
                h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(v.covers / maxSource) * 100}%` } })),
                h('span', { class: 'num' }, `${v.covers.toLocaleString()}`),
              ),
            )
          : h('p', { class: 'muted' }, 'No bookings in this range.'),
        h(
          'div',
          { class: 'notice', style: { marginTop: '12px', marginBottom: 0 } },
          h('b', {}, `${money(d.feesAvoided.estimatedCents)} in per-cover fees avoided`),
          h('div', { class: 'small' }, `${d.feesAvoided.networkRateCovers} covers came from Google or Instagram, which OpenTable bills at its network rate. Estimated at ${money(d.feesAvoided.perCoverCents, { decimals: 2 })} per cover (change in Settings). Subscription savings not included.`),
        ),
      ),
      h(
        'div',
        { class: 'panel chart' },
        h('h3', {}, 'When parties sat down'),
        h('p', { class: 'small muted', style: { marginTop: '-4px' } }, 'Covers seated, by starting hour'),
        hours.length ? columnChart(hours.map((x) => ({ label: fmt12(x * 60).replace(':00', ''), long: `${fmt12(x * 60)} hour`, value: d.byHour[x] })), { height: 160, unit: 'covers' }) : h('p', { class: 'muted' }, 'No seated parties yet.'),
      ),
      h(
        'div',
        { class: 'panel chart' },
        h('h3', {}, 'Party sizes'),
        h('p', { class: 'small muted', style: { marginTop: '-4px' } }, 'Seated parties by number of guests'),
        sizes.length ? columnChart(sizes.map((x) => ({ label: String(x), long: `Party of ${x}`, value: d.bySize[x] })), { height: 160, unit: 'parties' }) : h('p', { class: 'muted' }, 'No seated parties yet.'),
      ),
    ),
  );
}

// Clean ticks: a 1-2-5 step giving about four intervals, max rounded up to a step.
function niceScale(v) {
  const raw = Math.max(v, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const steps = p >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  const step = Math.max(1, steps.map((m) => m * p).find((x) => x >= raw)); // counts: whole-number ticks
  const max = Math.max(step, Math.ceil(v / step) * step);
  const ticks = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return { max, ticks };
}

function columnChart(items, { height = 180, unit = '', wide = false } = {}) {
  // Canvas width close to the rendered width keeps text near 11px.
  const W = wide ? 880 : 430;
  const H = height;
  const m = { l: 38, r: 8, t: 18, b: 24 };
  const plotW = W - m.l - m.r;
  const plotH = H - m.t - m.b;
  const { max, ticks } = niceScale(Math.max(0, ...items.map((i) => i.value)));
  const band = plotW / Math.max(1, items.length);
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (v) => m.t + plotH - (v / max) * plotH;
  const base = m.t + plotH;
  const every = Math.max(1, Math.ceil(items.length / 8));
  const peakIndex = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);

  const tip = h('div', { class: 'chart-tip', hidden: true });
  const root = h('div', { style: { position: 'relative' } });
  const show = (i, bar) => {
    const it = items[i];
    clear(tip, h('b', {}, `${it.value.toLocaleString()} ${unit}`), it.long || it.label);
    const rect = root.getBoundingClientRect();
    const scale = rect.width / W;
    tip.style.left = `${(m.l + band * i + band / 2) * scale}px`;
    tip.style.top = `${(y(it.value) - 6) * scale}px`;
    tip.hidden = false;
    bar.classList.add('hover');
  };
  const hide = (bar) => {
    tip.hidden = true;
    bar.classList.remove('hover');
  };

  const chart = svg(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Bar chart of ${unit} by category; table view below` },
    ticks.map((v) =>
      svg('g', {}, svg('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), 'stroke-width': 1 }), svg('text', { class: 'axis', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, v.toLocaleString())),
    ),
    items.map((it, i) => {
      const x = m.l + band * i + (band - barW) / 2;
      const top = y(it.value);
      const hgt = base - top;
      const rr = Math.min(4, hgt, barW / 2);
      const bar = svg('path', {
        class: 'barfill',
        d: hgt <= 0 ? '' : `M${x},${base} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + barW - rr} Q${x + barW},${top} ${x + barW},${top + rr} V${base} Z`,
      });
      const hit = svg('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: plotH, tabindex: 0, 'aria-label': `${it.long || it.label}: ${it.value} ${unit}` });
      hit.addEventListener('pointerenter', () => show(i, bar));
      hit.addEventListener('pointerleave', () => hide(bar));
      hit.addEventListener('focus', () => show(i, bar));
      hit.addEventListener('blur', () => hide(bar));
      return svg(
        'g',
        {},
        bar,
        i === peakIndex && it.value > 0 ? svg('text', { class: 'peak', x: x + barW / 2, y: top - 5, 'text-anchor': 'middle' }, it.value.toLocaleString()) : null,
        i % every === 0 ? svg('text', { class: 'axis', x: m.l + band * i + band / 2, y: H - 6, 'text-anchor': 'middle' }, it.label) : null,
        hit,
      );
    }),
  );
  root.append(chart, tip);
  return h(
    'div',
    {},
    root,
    h(
      'details',
      {},
      h('summary', {}, 'Table view'),
      h('table', { class: 'data' }, h('tbody', {}, items.map((it) => h('tr', {}, h('td', {}, it.long || it.label), h('td', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, it.value.toLocaleString()))))),
    ),
  );
}
