// Shared browser helpers. No framework: a tiny element builder, a fetch
// wrapper, formatting, toasts and dialogs.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// h('button', { class: 'btn', onclick: fn }, 'Save') -> element.
// Strings become text nodes, so user data is never parsed as HTML.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin', signal };
  if (body !== undefined || method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the server. Check the connection.');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = data?.error || {};
    const err = new ApiError(res.status, e.code || 'error', e.message || `Request failed (${res.status})`, e.details);
    if (res.status === 401) window.dispatchEvent(new CustomEvent('unauthenticated'));
    throw err;
  }
  return data;
}

// ---- Dates and numbers ------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

export function fmt12(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h24 % 12 || 12}:${pad(m)} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export function fmtHHMM(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const dateObj = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
};

export function addDays(date, n) {
  const d = dateObj(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function fmtDate(date, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(dateObj(date));
}

export function todayIn(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts.slice(0, 10);
}

// Same rule as the server: before 4 AM it is still the previous service day,
// at minutes past 24:00 (12:30 AM is minute 1470 of the night before).
export const SERVICE_DAY_START = 4 * 60;

export function serviceNowIn(tz) {
  const date = todayIn(tz);
  const minutes = nowMinutesIn(tz);
  return minutes < SERVICE_DAY_START ? { date: addDays(date, -1), minutes: minutes + 1440 } : { date, minutes };
}

// A clock time typed by staff ("00:30") -> service-day minutes (1470).
export function serviceMinutes(hhmm) {
  const m = parseHHMM(hhmm);
  if (m === null) return null;
  return m < SERVICE_DAY_START ? m + 1440 : m;
}

export function nowMinutesIn(tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const get = (t) => Number(p.find((x) => x.type === t)?.value || 0);
  return (get('hour') % 24) * 60 + get('minute');
}

export function money(cents, { decimals = 0 } = {}) {
  if (cents === null || cents === undefined) return '';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(cents / 100);
}

export function pct(x, digits = 0) {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(digits)}%`;
}

export function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// "+15105551016" -> "(510) 555-1016" for display; other countries stay as stored.
export function fmtPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164 || ''));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
}

// ---- Feedback ---------------------------------------------------------------

let toastHost;
export function toast(message, type = 'info', timeout = 4000) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: `toast ${type}` }, message);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

export function toastError(err) {
  toast(err?.message || 'Something went wrong.', 'error', 6000);
}

// Modal dialog with focus handling. Returns { close, el }.
// initialFocus: a selector inside the dialog. Without one the dialog itself
// takes focus, so opening a record never pops a keyboard or date picker.
const openDialogs = [];

export function modal({ title, body, actions = [], wide = false, onClose, initialFocus } = {}) {
  const previous = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    openDialogs.splice(openDialogs.indexOf(dialog), 1);
    previous?.focus?.();
    onClose?.();
  };
  // Stacked dialogs (a confirm over an editor): only the top one listens, so
  // one Escape never discards the editor underneath.
  const onKey = (e) => {
    if (openDialogs[openDialogs.length - 1] !== dialog) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
    if (e.key === 'Tab') {
      const items = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', dialog).filter((x) => !x.disabled && x.offsetParent);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  };
  const footer = actions.length
    ? h(
        'footer',
        {},
        actions.map((a) =>
          h('button', { type: a.submit ? 'submit' : 'button', class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger solid' : ''}`, onclick: a.submit ? null : () => a.onClick?.({ close }) }, a.label),
        ),
      )
    : null;
  const dialog = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'body' }, body),
    footer,
  );
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => e.target === backdrop && close() }, dialog);
  document.body.appendChild(backdrop);
  openDialogs.push(dialog);
  document.addEventListener('keydown', onKey);
  setTimeout(() => ((initialFocus && $(initialFocus, dialog)) || dialog).focus(), 0);
  return { close, el: dialog };
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title,
      initialFocus: 'footer .btn:last-child',
      body: h('p', { style: { margin: 0 } }, message),
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        { label: confirmLabel, primary: !danger, danger, onClick: ({ close }) => ((answered = true), close(), resolve(true)) },
      ],
      onClose: () => !answered && resolve(false),
    });
    return m;
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied', 'ok', 1500);
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Minimal field helpers used by forms across pages.
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
}

export function checkbox(name, label, checked, hint) {
  return h(
    'label',
    { class: 'check' },
    h('input', { type: 'checkbox', name, checked }),
    h('span', {}, label, hint ? h('div', { class: 'hint' }, hint) : null),
  );
}

export function busy(button, promise) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  return Promise.resolve(promise).finally(() => {
    button.disabled = false;
    button.textContent = label;
  });
}

export const LOGO_SVG =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#1F4D3F"/><path d="M10 6h12v20l-6-4.6L10 26z" fill="#F6F2EA"/></svg>';

export function applyTheme() {
  try {
    const t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  } catch {
    /* storage unavailable: follow the system */
  }
}
