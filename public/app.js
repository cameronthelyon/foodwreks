import { Wheel } from './wheel.js';

const $ = (sel) => document.querySelector(sel);
const PREFS_KEY = 'foodwreks:prefs';
const LOC_KEY = 'foodwreks:last-location';
const SOURCE_LABELS = { google: 'Google', yelp: 'Yelp', tripadvisor: 'Tripadvisor', osm: 'OSM', demo: 'Demo' };
const TAG_LABELS = {
  'top-pick': 'Top pick',
  'hidden-gem': 'Hidden gem',
  'crowd-favorite': 'Crowd favorite',
  'mixed-reviews': 'Mixed reviews',
};
const MAX_LIST = 120;

const DEFAULT_FILTERS = {
  radius: 3000,
  prices: [],
  includeUnpriced: true,
  minScore: 0,
  minReviews: 0,
  minSources: 0,
  includeUnrated: false,
  hideMixed: false,
  gemsOnly: false,
  openNow: false,
  cuisines: [],
  excludeMode: false,
  sort: 'score',
  wheelSize: 8,
  weighted: true,
};

const state = {
  origin: null,
  originLabel: '',
  data: null,
  filters: { ...DEFAULT_FILTERS, ...loadJson(PREFS_KEY) },
  pins: new Set(),
  vetoes: new Set(),
  wheelItems: [],
  requestId: 0,
};

const wheel = new Wheel($('#wheel'));

// ---------- storage ----------

function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}

// ---------- formatting ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const miles = (m) => {
  const mi = m / 1609.344;
  return mi < 0.1 ? `${Math.round(m * 3.281)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
};
const price$ = (p) => (p ? '$'.repeat(p) : '');
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function setStatus(msg, kind = '') {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

// ---------- data ----------

async function loadConfig() {
  try {
    const cfg = await (await fetch('api/config')).json();
    $('#demo-badge').hidden = !cfg.demo;
    renderSources(cfg.sources.map((s) => ({ ...s, ok: null })));
    return cfg;
  } catch {
    return { demo: false, sources: [] };
  }
}

function renderSources(sources) {
  $('#sources').innerHTML = sources
    .map((s) => {
      if (s.enabled === false) return `<span class="src-pill off" title="Add an API key to enable">${esc(s.label)}: off</span>`;
      if (s.ok === null || s.ok === undefined) return `<span class="src-pill">${esc(s.label)}</span>`;
      if (!s.ok) return `<span class="src-pill err" title="${esc(s.error)}">${esc(s.label)}: failed</span>`;
      return `<span class="src-pill ok">${esc(s.label)}: ${s.count}</span>`;
    })
    .join('');
}

async function search() {
  if (!state.origin) return;
  const id = ++state.requestId;
  const { lat, lng } = state.origin;
  setStatus(`Searching within ${miles(state.filters.radius)} of ${state.originLabel}…`);
  try {
    const res = await fetch(`api/restaurants?lat=${lat}&lng=${lng}&radius=${state.filters.radius}`);
    const body = await res.json();
    if (id !== state.requestId) return; // a newer search superseded this one
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.data = body;
    state.pins.clear();
    state.vetoes.clear();
    $('#demo-badge').hidden = !body.demo;
    const cfg = await loadConfig();
    const byId = new Map(body.sources.map((s) => [s.id, s]));
    renderSources(cfg.sources.map((s) => ({ ...s, ...(byId.get(s.id) || {}) })));
    const failed = body.sources.filter((s) => !s.ok);
    const failNote = failed.length ? ` ${failed.map((s) => s.label).join(', ')} failed; results exclude them.` : '';
    setStatus(
      `${body.restaurants.length} places near ${state.originLabel}. Local average: ${body.prior.toFixed(2)}★.${failNote}`,
      failed.length ? 'error' : '',
    );
    renderCuisineChips();
    render();
  } catch (err) {
    if (id !== state.requestId) return;
    setStatus(`Search failed: ${err.message}`, 'error');
  }
}

function setOrigin(lat, lng, label) {
  state.origin = { lat, lng };
  state.originLabel = label;
  saveJson(LOC_KEY, { lat, lng, label });
  search();
}

function locate() {
  if (!navigator.geolocation) {
    setStatus('Geolocation is not available in this browser. Type an address instead.', 'error');
    return;
  }
  setStatus('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => setOrigin(pos.coords.latitude, pos.coords.longitude, 'your location'),
    (err) => setStatus(`Couldn't get your location (${err.message}). Type an address instead.`, 'error'),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
  );
}

async function geocode(q) {
  setStatus(`Looking up "${q}"…`);
  try {
    const res = await fetch(`api/geocode?q=${encodeURIComponent(q)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setOrigin(body.lat, body.lng, body.label.split(',').slice(0, 2).join(','));
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

// ---------- filtering ----------

function ratedSourceCount(r) {
  return r.sources.filter((s) => s.rating != null).length;
}

function applyFilters(list) {
  const f = state.filters;
  const prices = new Set(f.prices);
  const cuisines = new Set(f.cuisines);
  return list.filter((r) => {
    if (prices.size && !(r.price == null ? f.includeUnpriced : prices.has(r.price))) return false;
    if (r.score == null) {
      if (!f.includeUnrated) return false;
    } else if (r.score < f.minScore) return false;
    if (r.totalReviews < f.minReviews && r.score != null) return false;
    if (f.minSources && ratedSourceCount(r) < f.minSources && r.score != null) return false;
    if (f.hideMixed && r.tags.includes('mixed-reviews')) return false;
    if (f.gemsOnly && !r.tags.includes('hidden-gem')) return false;
    if (f.openNow && r.openNow !== true) return false;
    if (cuisines.size) {
      const hit = r.cuisines.some((c) => cuisines.has(c));
      if (f.excludeMode ? hit : !hit) return false;
    }
    return true;
  });
}

function sortList(list) {
  const out = [...list];
  const byScore = (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.totalReviews - a.totalReviews;
  switch (state.filters.sort) {
    case 'distance':
      return out.sort((a, b) => a.distance - b.distance);
    case 'reviews':
      return out.sort((a, b) => b.totalReviews - a.totalReviews || byScore(a, b));
    case 'price-asc':
      return out.sort((a, b) => (a.price ?? 9) - (b.price ?? 9) || byScore(a, b));
    default:
      return out.sort(byScore);
  }
}

// ---------- rendering ----------

function renderCuisineChips() {
  const counts = new Map();
  for (const r of state.data?.restaurants || []) for (const c of r.cuisines) counts.set(c, (counts.get(c) || 0) + 1);
  // Keep previously selected cuisines visible even if absent in this area.
  for (const c of state.filters.cuisines) if (!counts.has(c)) counts.set(c, 0);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const selected = new Set(state.filters.cuisines);
  $('#cuisines').innerHTML = sorted.length
    ? sorted
        .map(
          ([c, n]) =>
            `<button type="button" class="chip" data-cuisine="${esc(c)}" aria-pressed="${selected.has(c)}">${esc(c)}<span class="n">${n}</span></button>`,
        )
        .join('')
    : '<span class="hint">Cuisines appear after a search.</span>';
}

function sourceBadges(r) {
  return r.sources
    .map((s) => {
      const label = SOURCE_LABELS[s.source] || s.source;
      const body =
        s.rating != null
          ? `${label} <b>${s.rating.toFixed(1)}</b> (${compact(s.reviewCount)})`
          : `${label} <span class="muted">no rating</span>`;
      return s.url
        ? `<a class="src" data-source="${esc(s.source)}" href="${esc(s.url)}" target="_blank" rel="noopener">${body}</a>`
        : `<span class="src" data-source="${esc(s.source)}">${body}</span>`;
    })
    .join('');
}

function metaLine(r) {
  const parts = [];
  if (r.price) parts.push(`<span>${price$(r.price)}</span>`);
  if (r.cuisines.length) parts.push(`<span>${esc(r.cuisines.slice(0, 3).join(' · '))}</span>`);
  parts.push(`<span>${miles(r.distance)}</span>`);
  if (r.openNow === true) parts.push('<span class="open">Open now</span>');
  if (r.openNow === false) parts.push('<span class="closed">Closed now</span>');
  if (r.score != null) parts.push(`<span>${compact(r.totalReviews)} reviews</span>`);
  return parts.join('');
}

function render() {
  const all = state.data?.restaurants || [];
  const filtered = sortList(applyFilters(all));
  const onWheel = computeWheel(filtered);
  const wheelIds = new Set(onWheel.map((r) => r.id));

  $('#results-count').textContent = state.data
    ? `${filtered.length} of ${all.length} match${filtered.length > MAX_LIST ? ` (showing ${MAX_LIST})` : ''}`
    : '';

  $('#list').innerHTML = filtered
    .slice(0, MAX_LIST)
    .map((r, i) => {
      const vetoed = state.vetoes.has(r.id);
      const pinned = state.pins.has(r.id);
      const scoreCls = r.score == null ? 'none' : r.score >= state.data.prior + 0.3 ? 'hi' : '';
      const scoreHtml = r.score == null ? 'n/a' : `${r.score.toFixed(1)}<small>#${i + 1}</small>`;
      return `<li class="card${vetoed ? ' vetoed' : ''}${wheelIds.has(r.id) ? ' on-wheel' : ''}" data-id="${esc(r.id)}">
        <div class="score ${scoreCls}" title="${r.score == null ? 'No ratings from any source' : `Blended rating ${r.rating} across ${compact(r.totalReviews)} reviews`}">${scoreHtml}</div>
        <div>
          <h3>${esc(r.name)}</h3>
          <div class="meta">${metaLine(r)}</div>
          ${r.tags.length ? `<div class="tags">${r.tags.map((t) => `<span class="tag ${t}">${TAG_LABELS[t] || t}</span>`).join('')}</div>` : ''}
          <div class="src-row">${sourceBadges(r)}</div>
        </div>
        <div class="card-actions">
          <button type="button" class="icon-btn" data-action="pin" aria-pressed="${pinned}" title="${pinned ? 'Unpin from wheel' : 'Pin to wheel'}">★</button>
          <button type="button" class="icon-btn" data-action="veto" aria-pressed="${vetoed}" title="${vetoed ? 'Restore' : 'Veto (remove from wheel)'}">✕</button>
        </div>
      </li>`;
    })
    .join('');

  const empty = $('#empty');
  if (!state.data) {
    empty.hidden = false;
    empty.textContent = 'Share your location or type an address to find places nearby.';
  } else if (!filtered.length && all.length && all.every((r) => r.score == null) && !state.filters.includeUnrated) {
    empty.hidden = false;
    empty.textContent = `Found ${all.length} places, but none of the enabled sources provide ratings (OpenStreetMap has none). Turn on "Include unrated places", or add a Google, Yelp or Tripadvisor key to .env.`;
  } else if (!filtered.length) {
    empty.hidden = false;
    empty.textContent = all.length
      ? 'Nothing matches these filters. Loosen something or widen the distance.'
      : 'No restaurants found here. Try a wider distance.';
  } else {
    empty.hidden = true;
  }

  renderWheel(onWheel);
  $('#clear-pins').hidden = !state.pins.size;
  $('#clear-vetoes').hidden = !state.vetoes.size;
}

function computeWheel(filtered) {
  const all = state.data?.restaurants || [];
  if (state.pins.size) return all.filter((r) => state.pins.has(r.id) && !state.vetoes.has(r.id));
  return filtered.filter((r) => !state.vetoes.has(r.id)).slice(0, state.filters.wheelSize);
}

function wheelWeight(r, items) {
  if (!state.filters.weighted) return 1;
  const scores = items.map((x) => x.score ?? state.data.prior - 0.3);
  const floor = Math.min(...scores) - 0.5;
  return Math.max(0.1, (r.score ?? state.data.prior - 0.3) - floor);
}

function renderWheel(items) {
  state.wheelItems = items;
  if (!wheel.spinning) wheel.setItems(items.map((r) => ({ label: r.name, weight: wheelWeight(r, items) })));
  $('#spin').disabled = items.length < 2 || wheel.spinning;
  $('#wheel-hint').textContent = state.pins.size
    ? `${items.length} pinned place${items.length === 1 ? '' : 's'} on the wheel.${items.length < 2 ? ' Pin at least 2.' : ''}`
    : 'Uses the top results from your filters. Pin restaurants with ★ to hand-pick instead.';
}

async function spin() {
  if (state.wheelItems.length < 2) return;
  const items = state.wheelItems;
  $('#spin').disabled = true;
  const idx = await wheel.spin();
  $('#spin').disabled = false;
  if (idx == null) return;
  showWinner(items[idx]);
}

function showWinner(r) {
  state.winner = r;
  $('#winner-name').textContent = r.name;
  const bits = [r.score != null ? `${r.score.toFixed(1)} score` : 'Unrated', price$(r.price), r.cuisines.slice(0, 2).join(', '), miles(r.distance), r.address]
    .filter(Boolean)
    .join(' · ');
  $('#winner-meta').textContent = bits;
  $('#winner-sources').innerHTML = sourceBadges(r);
  const dest = r.address ? `${r.name}, ${r.address}` : `${r.lat},${r.lng}`;
  $('#winner-directions').href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  $('#winner').showModal();
}

// ---------- controls ----------

function persist() {
  saveJson(PREFS_KEY, state.filters);
}

function update(patch, { refetch = false } = {}) {
  Object.assign(state.filters, patch);
  persist();
  if (refetch) search();
  else render();
}

function syncControls() {
  const f = state.filters;
  $('#radius').value = f.radius;
  $('#radius-out').textContent = miles(f.radius);
  document.querySelectorAll('#price button').forEach((b) => b.setAttribute('aria-pressed', f.prices.includes(Number(b.dataset.price))));
  $('#include-unpriced').checked = f.includeUnpriced;
  $('#min-score').value = String(f.minScore);
  $('#min-reviews').value = String(f.minReviews);
  $('#min-sources').value = String(f.minSources);
  $('#include-unrated').checked = f.includeUnrated;
  $('#hide-mixed').checked = f.hideMixed;
  $('#gems-only').checked = f.gemsOnly;
  $('#open-now').checked = f.openNow;
  $('#exclude-mode').checked = f.excludeMode;
  $('#cuisines').classList.toggle('exclude', f.excludeMode);
  $('#sort').value = f.sort;
  $('#wheel-size').value = f.wheelSize;
  $('#weighted').checked = f.weighted;
}

function bind() {
  $('#locate-btn').addEventListener('click', locate);
  $('#location-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#address-input').value.trim();
    if (q) geocode(q);
  });

  let radiusTimer;
  $('#radius').addEventListener('input', (e) => {
    const radius = Number(e.target.value);
    $('#radius-out').textContent = miles(radius);
    clearTimeout(radiusTimer);
    radiusTimer = setTimeout(() => update({ radius }, { refetch: true }), 400);
  });

  $('#price').addEventListener('click', (e) => {
    const p = Number(e.target.dataset.price);
    if (!p) return;
    const prices = state.filters.prices.includes(p) ? state.filters.prices.filter((x) => x !== p) : [...state.filters.prices, p];
    e.target.setAttribute('aria-pressed', prices.includes(p));
    update({ prices });
  });

  const checks = {
    '#include-unpriced': 'includeUnpriced',
    '#include-unrated': 'includeUnrated',
    '#hide-mixed': 'hideMixed',
    '#gems-only': 'gemsOnly',
    '#open-now': 'openNow',
    '#weighted': 'weighted',
  };
  for (const [sel, key] of Object.entries(checks)) {
    $(sel).addEventListener('change', (e) => update({ [key]: e.target.checked }));
  }
  $('#exclude-mode').addEventListener('change', (e) => {
    $('#cuisines').classList.toggle('exclude', e.target.checked);
    update({ excludeMode: e.target.checked });
  });

  const selects = { '#min-score': 'minScore', '#min-reviews': 'minReviews', '#min-sources': 'minSources' };
  for (const [sel, key] of Object.entries(selects)) {
    $(sel).addEventListener('change', (e) => update({ [key]: Number(e.target.value) }));
  }
  $('#sort').addEventListener('change', (e) => update({ sort: e.target.value }));
  $('#wheel-size').addEventListener('change', (e) => {
    const n = Math.min(16, Math.max(2, Math.round(Number(e.target.value)) || 8));
    e.target.value = n;
    update({ wheelSize: n });
  });

  $('#cuisines').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const c = chip.dataset.cuisine;
    const cuisines = state.filters.cuisines.includes(c) ? state.filters.cuisines.filter((x) => x !== c) : [...state.filters.cuisines, c];
    chip.setAttribute('aria-pressed', cuisines.includes(c));
    update({ cuisines });
  });
  $('#clear-cuisines').addEventListener('click', () => {
    update({ cuisines: [] });
    renderCuisineChips();
  });

  $('#reset').addEventListener('click', () => {
    const { radius, wheelSize, weighted } = state.filters;
    state.filters = { ...DEFAULT_FILTERS, radius, wheelSize, weighted };
    persist();
    syncControls();
    renderCuisineChips();
    render();
  });

  $('#list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || wheel.spinning) return;
    const id = btn.closest('.card').dataset.id;
    const set = btn.dataset.action === 'pin' ? state.pins : state.vetoes;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    if (btn.dataset.action === 'veto') state.pins.delete(id);
    render();
  });
  $('#clear-pins').addEventListener('click', () => {
    state.pins.clear();
    render();
  });
  $('#clear-vetoes').addEventListener('click', () => {
    state.vetoes.clear();
    render();
  });

  $('#spin').addEventListener('click', spin);
  $('#winner-veto').addEventListener('click', () => {
    $('#winner').close();
    state.vetoes.add(state.winner.id);
    state.pins.delete(state.winner.id);
    render();
    spin();
  });
}

// ---------- boot ----------

async function boot() {
  if (window.matchMedia('(max-width: 760px)').matches) $('#filters-box').open = false;
  syncControls();
  bind();
  render();
  const cfg = await loadConfig();
  const last = loadJson(LOC_KEY);
  if (Number.isFinite(last.lat)) {
    state.origin = { lat: last.lat, lng: last.lng };
    state.originLabel = last.label;
    search();
    return;
  }
  if (cfg.demo) {
    setOrigin(38.5767, -121.4934, 'Sacramento, CA (demo)');
    return;
  }
  // Only auto-locate when the browser already granted permission; otherwise wait for a click.
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' });
    if (perm?.state === 'granted') locate();
  } catch {
    /* permissions API unsupported */
  }
}

boot();
