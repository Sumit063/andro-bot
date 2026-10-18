// viz.js — the equalizer. Fed ~47 spectrum frames/s from the Mac; rendered at 60 fps with
// fast-attack / slow-release smoothing. Falls back to a synthetic groove when no live audio.

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round);

export class Viz {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.n = 40;
    this.tgt = new Float32Array(this.n);
    this.cur = new Float32Array(this.n);
    this.pk = new Float32Array(this.n);
    this.pv = new Float32Array(this.n);
    this.level = 0;
    this.lvl = 0;
    this.beat = 0;
    this.lastFeed = -1e9;
    this.synthBeat = 0;
    this.onBeat = null;
    this.styles = ['bars', 'wave', 'ring'];
    this.style = 'bars';
    this.acc = [92, 242, 255];
    this.acc2 = [255, 110, 200];
    this.W = this.H = 1;
    this.dpr = 1;
  }

  resize(dpr) {
    const r = this.c.getBoundingClientRect();
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.dpr = dpr;
    this.c.width = Math.round(this.W * dpr);
    this.c.height = Math.round(this.H * dpr);
  }

  setColors(acc, acc2) {
    this.acc = acc;
    this.acc2 = acc2;
  }

  cycle() {
    this.style = this.styles[(this.styles.indexOf(this.style) + 1) % this.styles.length];
    return this.style;
  }

  feed(u8) {
    this.level = u8[0] / 255;
    const n = Math.min(this.n, u8.length - 2);
    for (let i = 0; i < n; i++) this.tgt[i] = u8[i + 2] / 255;
    this.lastFeed = performance.now();
    if (u8[1]) this.hitBeat();
  }

  get live() {
    return performance.now() - this.lastFeed < 700;
  }

  hitBeat() {
    this.beat = 1;
    if (this.onBeat) this.onBeat(this.level);
  }

  synth(t) {
    if (t - this.synthBeat > 0.48) {
      this.synthBeat = t;
      this.level = 0.6;
      this.hitBeat();
    }
    const b = Math.exp(-(t - this.synthBeat) * 7);
    for (let i = 0; i < this.n; i++) {
      const f = i / this.n;
      const env = 0.62 * Math.exp(-f * 1.6) + 0.12;
      const wob = 0.5 + 0.5 * Math.sin(t * (2.1 + f * 5) + i * 1.7) * Math.sin(t * (1.3 + f * 3.1) + i * 0.9);
      this.tgt[i] = clamp(env * (0.45 + 0.55 * wob) + b * 0.35 * Math.exp(-f * 4), 0, 1);
    }
  }

  update(dt, t, playing) {
    if (!this.live) {
      if (playing) this.synth(t);
      else {
        this.tgt.fill(0);
        this.level = 0;
      }
    }
    const up = 1 - Math.exp(-dt * 35), down = 1 - Math.exp(-dt * 8);
    const { cur, tgt, pk, pv } = this;
    for (let i = 0; i < this.n; i++) {
      cur[i] += (tgt[i] - cur[i]) * (tgt[i] > cur[i] ? up : down);
      if (cur[i] >= pk[i]) {
        pk[i] = cur[i];
        pv[i] = 0;
      } else {
        pv[i] += dt * 1.6;
        pk[i] = Math.max(0, pk[i] - pv[i] * dt);
      }
    }
    this.lvl += (this.level - this.lvl) * (1 - Math.exp(-dt * 12));
    this.beat *= Math.exp(-dt * 5);
  }

  draw(t) {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    this[this.style](t);
  }

  bars() {
    const { ctx, W, H, n, cur, pk } = this;
    const padX = W * 0.05, base = H * 0.64, maxH = H * 0.52;
    const bw = (W - padX * 2) / n, w = bw * 0.62, boost = 1 + this.beat * 0.08;
    const g = ctx.createLinearGradient(0, base - maxH, 0, base);
    g.addColorStop(0, rgba(this.acc2, 1));
    g.addColorStop(1, rgba(this.acc, 1));
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const h = Math.max(4, cur[i] * maxH * boost);
      ctx.roundRect(padX + i * bw + (bw - w) / 2, base - h, w, h, w / 2);
    }
    ctx.fill();
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const h = Math.max(2, cur[i] * maxH * 0.32);
      ctx.roundRect(padX + i * bw + (bw - w) / 2, base + 8, w, h, w / 2);
    }
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (pk[i] < 0.02) continue;
      ctx.roundRect(padX + i * bw + (bw - w) / 2, base - pk[i] * maxH * boost - 9, w, 3.5, 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  wave() {
    const { ctx, W, H, n, cur } = this;
    const mid = H * 0.5, amp = H * 0.36 * (1 + this.beat * 0.06), padX = W * 0.04;
    const xs = (i) => padX + ((W - padX * 2) * i) / (n - 1);
    const trace = (sign, k) => {
      ctx.moveTo(xs(0), mid);
      for (let i = 0; i < n - 1; i++) {
        const x0 = xs(i), x1 = xs(i + 1);
        const y0 = mid + sign * cur[i] * amp * k, y1 = mid + sign * cur[i + 1] * amp * k;
        ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      }
      ctx.lineTo(xs(n - 1), mid);
    };
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, rgba(this.acc, 0.55));
    g.addColorStop(1, rgba(this.acc2, 0.55));
    ctx.fillStyle = g;
    ctx.beginPath();
    trace(-1, 1);
    trace(1, 0.55);
    ctx.fill();
    const s = ctx.createLinearGradient(0, 0, W, 0);
    s.addColorStop(0, rgba(this.acc, 1));
    s.addColorStop(1, rgba(this.acc2, 1));
    ctx.strokeStyle = s;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    trace(-1, 1);
    ctx.stroke();
  }

  ring(t) {
    const { ctx, W, H, n, cur } = this;
    const cx = W / 2, cy = H / 2, m = Math.min(W, H);
    const R = m * 0.2 * (1 + this.beat * 0.07), L = m * 0.26;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5);
    core.addColorStop(0, rgba(this.acc, 0.18 + this.lvl * 0.35));
    core.addColorStop(1, rgba(this.acc, 0));
    ctx.fillStyle = core;
    ctx.fillRect(cx - R * 1.5, cy - R * 1.5, R * 3, R * 3);
    const total = n * 2;
    ctx.lineWidth = ((TAU * R) / total) * 0.55;
    ctx.lineCap = 'round';
    for (let j = 0; j < total; j++) {
      const i = j < n ? j : total - 1 - j;
      const a = (j / total) * TAU - Math.PI / 2 + t * 0.15;
      const len = 6 + cur[i] * L;
      const c = mix(this.acc, this.acc2, i / n);
      ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(this.acc, 0.5);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R - 8, 0, TAU);
    ctx.stroke();
  }
}
