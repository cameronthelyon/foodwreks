// Canvas prize wheel. Slices can be weighted; the winner is drawn by weighted
// random before the animation starts, then the wheel is steered to land on it.

const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#f08c00', '#ae3ec9', '#0ca678', '#e03131', '#4263eb', '#d6336c', '#5c940d', '#1098ad', '#7048e8'];
const TAU = Math.PI * 2;
const POINTER_ANGLE = -Math.PI / 2; // 12 o'clock

const easeOutQuart = (t) => 1 - (1 - t) ** 4;

export class Wheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];
    this.rotation = 0;
    this.spinning = false;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(this.canvas.clientWidth * dpr) || 520;
    if (this.canvas.width !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    this.draw();
  }

  // items: [{ label, weight }]
  setItems(items) {
    this.items = items;
    const total = items.reduce((s, it) => s + it.weight, 0) || 1;
    let acc = 0;
    this.slices = items.map((it, i) => {
      const start = acc;
      acc += (it.weight / total) * TAU;
      return { ...it, start, end: acc, color: PALETTE[i % PALETTE.length] };
    });
    this.draw();
  }

  pickIndex() {
    const total = this.items.reduce((s, it) => s + it.weight, 0);
    let r = Math.random() * total;
    for (let i = 0; i < this.items.length; i++) {
      r -= this.items[i].weight;
      if (r <= 0) return i;
    }
    return this.items.length - 1;
  }

  spin() {
    if (this.spinning || this.items.length < 2) return Promise.resolve(null);
    const winner = this.pickIndex();
    const slice = this.slices[winner];
    // Land somewhere inside the slice, away from its edges.
    const inset = (slice.end - slice.start) * 0.15;
    const landAt = slice.start + inset + Math.random() * (slice.end - slice.start - 2 * inset);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const turns = reduced ? 1 : 5 + Math.floor(Math.random() * 3);
    const current = ((this.rotation % TAU) + TAU) % TAU;
    let delta = POINTER_ANGLE - landAt - current;
    delta = ((delta % TAU) + TAU) % TAU;
    const from = this.rotation;
    const to = this.rotation + delta + turns * TAU;
    const duration = reduced ? 600 : 4800 + Math.random() * 1200;

    this.spinning = true;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / duration);
        this.rotation = from + (to - from) * easeOutQuart(t);
        this.draw();
        if (t < 1) requestAnimationFrame(frame);
        else {
          this.spinning = false;
          resolve(winner);
        }
      };
      requestAnimationFrame(frame);
    });
  }

  draw() {
    const { ctx, canvas } = this;
    const size = canvas.width;
    const c = size / 2;
    const r = c - size * 0.02;
    ctx.clearRect(0, 0, size, size);

    if (!this.slices?.length) {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, TAU);
      ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--surface-2') || '#eee';
      ctx.fill();
      ctx.fillStyle = '#888';
      ctx.font = `${Math.round(size * 0.035)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Search to load the wheel', c, c + size * 0.18);
      return;
    }

    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(this.rotation);
    for (const s of this.slices) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, s.start, s.end);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = size * 0.004;
      ctx.stroke();

      const sweep = s.end - s.start;
      const mid = s.start + sweep / 2;
      const fontSize = Math.max(10, Math.min(size * 0.034, sweep * r * 0.42));
      ctx.save();
      ctx.rotate(mid);
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const maxW = r * 0.62;
      ctx.fillText(fit(ctx, s.label, maxW), r * 0.93, 0);
      ctx.restore();
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(c, c, r, 0, TAU);
    ctx.lineWidth = size * 0.012;
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.stroke();
  }
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}
