// bot.js — "Pixel", the desk robot. Pure 2D canvas driven by springs, so every change of mood,
// pose or scene eases in naturally. Kept light enough for a budget tablet GPU (no blur/shadows).

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

class Spring {
  constructor(x = 0, k = 120, damp = 0.8) {
    this.x = this.t = x;
    this.v = 0;
    this.k = k;
    this.d = 2 * Math.sqrt(k) * damp;
  }
  step(dt) {
    this.v += (this.k * (this.t - this.x) - this.d * this.v) * dt;
    this.x += this.v * dt;
  }
  snap(x) {
    this.x = this.t = x;
    this.v = 0;
  }
}

const EYE = {
  cyan: [90, 235, 255], orange: [255, 166, 60], pink: [255, 112, 205], green: [96, 255, 168],
  purple: [186, 140, 255], yellow: [255, 214, 100], blue: [130, 165, 255], red: [255, 96, 96],
};

const MOOD_KEYS = ['open', 'eyeW', 'eyeH', 'happy', 'lid', 'lidAng', 'smile', 'mouthO', 'blush', 'glow'];
const MOODS = {
  neutral: { open: 1, eyeW: 1, eyeH: 1, happy: 0.12, lid: 0, lidAng: 0, smile: 0.35, mouthO: 0, blush: 0.3, glow: 1, color: 'cyan' },
  happy: { happy: 0.85, smile: 0.9, blush: 0.7 },
  surf: { happy: 0.55, smile: 0.9, mouthO: 0.18, blush: 0.5, color: 'cyan' },
  focus: { lid: 0.3, lidAng: 0.22, happy: 0, smile: 0.05, blush: 0, eyeW: 1.05, eyeH: 0.9, color: 'orange' },
  funtime: { happy: 0.7, smile: 1, mouthO: 0.42, blush: 0.85, color: 'pink' },
  code: { lid: 0.14, happy: 0.05, smile: 0.2, blush: 0.15, color: 'green' },
  music: { happy: 0.95, smile: 0.75, blush: 0.6, color: 'purple' },
  chat: { happy: 0.3, smile: 0.5, blush: 0.4, color: 'yellow' },
  sleep: { open: 0.07, happy: 0, lid: 0, lidAng: 0, smile: 0.05, mouthO: 0, blush: 0.2, glow: 0.35, color: 'blue' },
  bored: { lid: 0.48, lidAng: -0.12, happy: 0, smile: -0.05, mouthO: 0, blush: 0.1, glow: 0.75 },
  worried: { lidAng: -0.18, lid: 0.05, smile: -0.3, happy: 0 },
  stress: { lidAng: -0.2, lid: 0.08, smile: -0.35, happy: 0, mouthO: 0 },
  think: { lid: 0.18, happy: 0, smile: 0.1, mouthO: 0 },
  surprise: { open: 1, eyeW: 1.18, eyeH: 1.28, happy: 0, lid: 0, lidAng: 0, mouthO: 0.65, smile: 0 },
  love: { open: 1, happy: 1, smile: 1, mouthO: 0.3, blush: 1, lid: 0, lidAng: 0 },
};

// Per-scene defaults: mood, where the eyes rest, arm angles (+ = out, − = across body), belly glyph.
const SCENES = {
  default: { mood: 'neutral', look: [0, 0], arms: [0.22, 0.22], belly: '♥' },
  surf: { mood: 'surf', look: [0.35, -0.05], arms: [1.25, 0.95], belly: '~' },
  focus: { mood: 'focus', look: [0, 0.1], arms: [0.1, 0.1], belly: '!' },
  funtime: { mood: 'funtime', look: [0, -0.05], arms: [0.3, -0.75], belly: '★' },
  code: { mood: 'code', look: [0, 0.6], arms: [-0.55, -0.55], belly: '</>' },
  music: { mood: 'music', look: [0, 0], arms: [0.5, 0.5], belly: '♪' },
  chat: { mood: 'chat', look: [-0.2, 0], arms: [0.25, 0.6], belly: '…' },
  sleep: { mood: 'sleep', look: [0, 0.2], arms: [0.04, 0.04], belly: 'z' },
};

const GLYPHS = ['{', '}', ';', '</>', '=>', '()', '[]', '#', '++', '&&'];
const CONFETTI = ['#FF6FA8', '#FFD166', '#5CF2FF', '#7CFFB2', '#B98CFF', '#FF8A5C'];
const HEAD_Y = -70;
const BODY_Y = 82;

export class Bot {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = this.H = 1;
    this.dpr = 1;
    this.view = 'bot';
    this.state = { scene: 'default' };
    const S = (x, k, d) => new Spring(x, k, d);
    this.sp = {
      open: S(1, 300), eyeW: S(1, 260, 0.6), eyeH: S(1, 260, 0.6), happy: S(0.1, 160), lid: S(0, 160),
      lidAng: S(0, 140), smile: S(0.3, 140), mouthO: S(0, 240, 0.6), blush: S(0.3, 60), glow: S(1, 60),
      lookX: S(0, 420, 0.85), lookY: S(0, 420, 0.85),
      r: S(90, 40, 1), g: S(235, 40, 1), b: S(255, 40, 1),
      headY: S(0, 180, 0.35), headTilt: S(0, 90, 0.5), tilt: S(0, 70, 0.6), sq: S(0, 260, 0.3),
      hop: S(0, 160, 0.45), armL: S(0.2, 120, 0.5), armR: S(0.2, 120, 0.5), ant: S(0, 70, 0.12),
      X: S(0, 60, 0.95), Y: S(0, 60, 0.95), Sc: S(1, 60, 0.95), vb: S(1, 40, 1),
    };
    this.pres = {};
    for (const k of [...Object.keys(SCENES), 'think', 'attention', 'stress']) this.pres[k] = new Spring(0, 50, 1);
    this.pres.default.snap(1);
    this.parts = [];
    this.t = 0;
    this.nextBlink = 1.5;
    this.blinkAt = -9;
    this.nextLook = 0.5;
    this.lookOff = [0, 0];
    this.expr = null;
    this.exprUntil = 0;
    this.exprQueue = [];
    this.waveUntil = 0;
    this.cheerUntil = 0;
    this.spinAt = -9;
    this.chompAt = -9;
    this.pokes = [];
    this.timers = {};
    this.typeSide = 1;
    this.placed = false;
    this.hitBox = null;
  }

  // ------------------------------------------------------------------ public API

  resize(W, H, dpr) {
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    this.c.width = Math.round(W * dpr);
    this.c.height = Math.round(H * dpr);
    const L = this.layout();
    if (!this.placed) {
      this.sp.X.snap(L.x);
      this.sp.Y.snap(L.y);
      this.sp.Sc.snap(L.s);
      this.placed = true;
    }
  }

  setView(v, instant) {
    this.view = v;
    if (instant) {
      const L = this.layout();
      this.sp.X.snap(L.x);
      this.sp.Y.snap(L.y);
      this.sp.Sc.snap(L.s);
      this.sp.vb.snap(v === 'bot' ? 1 : 0);
    }
  }

  setState(st) {
    const prev = this.state.scene;
    this.state = st;
    if (prev !== st.scene && prev !== 'sleep' && st.scene !== 'sleep') this.react('switch');
  }

  onKey() {
    const sp = this.sp;
    sp.headY.v += 70;
    sp.sq.v += 1.2;
    sp.ant.v += (Math.random() - 0.5) * 3;
    if (this.state.scene === 'code') {
      this.typeSide *= -1;
      (this.typeSide < 0 ? sp.armL : sp.armR).v -= 7;
      if (Math.random() < 0.35) {
        this.spawn('glyph', rand(-80, 80), 40, rand(-25, 25), rand(-95, -60), 1.4, { ch: pick(GLYPHS) });
      }
    }
  }

  onBeat(level) {
    const sc = this.state.scene;
    if (!(sc === 'music' || (sc === 'funtime' && this.state.playing))) return;
    const sp = this.sp;
    sp.headY.v += 110 + level * 140;
    sp.sq.v += 0.8 + level * 1.5;
    sp.ant.v += pick([-1, 1]) * 2.5;
    if (sc === 'music') {
      sp.armL.v += pick([-1, 1]) * 4;
      sp.armR.v += pick([-1, 1]) * 4;
    }
  }

  poke() {
    const sp = this.sp, t = this.t;
    this.pokes = this.pokes.filter((p) => t - p < 1.6);
    this.pokes.push(t);
    sp.sq.v += 5;
    sp.hop.v += 260;
    sp.ant.v += 6;
    if (this.pokes.length >= 4) {
      this.pokes = [];
      this.spinAt = t;
      this.express('surprise', 0.9);
      this.exprQueue = [['love', 1.4]];
    } else {
      this.express('love', 1.3);
    }
    for (let i = 0; i < 3; i++) this.spawn('heart', rand(-60, 60), -150, rand(-40, 40), rand(-110, -70), 1.5, { size: rand(18, 28) });
  }

  react(kind) {
    const sp = this.sp, t = this.t;
    if (kind === 'switch') {
      sp.hop.v += 220;
      sp.ant.v += 4;
      this.express('surprise', 0.32);
    } else if (kind === 'wake') {
      sp.hop.v += 320;
      sp.ant.v += 6;
      this.express('surprise', 0.7);
      this.exprQueue = [['happy', 1.8]];
      this.waveUntil = t + 2.6;
    } else if (kind === 'celebrate') {
      sp.hop.v += 320;
      this.cheerUntil = t + 2.2;
      this.express('happy', 2.6);
      for (let i = 0; i < 40; i++) {
        this.spawn('confetti', rand(-220, 220), rand(-330, -240), rand(-60, 60), rand(-40, 60), rand(2, 3), {
          g: 220, color: pick(CONFETTI), vr: rand(-8, 8),
        });
      }
    } else if (kind === 'charge') {
      this.express('happy', 1.5);
      sp.hop.v += 180;
      for (let i = 0; i < 8; i++) this.spawn('spark', rand(-150, 150), rand(-220, 60), 0, -20, 1.2, { size: rand(10, 18) });
    } else if (kind === 'greet') {
      this.waveUntil = t + 2.4;
      this.express('happy', 2);
    }
  }

  express(name, dur) {
    this.expr = name;
    this.exprUntil = this.t + dur;
  }

  hit(x, y) {
    const b = this.hitBox;
    return !!b && Math.hypot(x - b.x, y - b.y) < b.r;
  }

  // ------------------------------------------------------------------ simulation

  layout() {
    const { W, H } = this;
    if (this.view === 'media') {
      const s = Math.min(H * 0.24, W * 0.16) / 350;
      return { x: W - 140 * s - W * 0.025, y: 215 * s + H * 0.03, s };
    }
    if (this.view === 'clock') {
      const s = (H * 0.34) / 350;
      return { x: W * 0.85, y: H - 195 * s - H * 0.04, s };
    }
    const s = Math.min(H * 0.6, W * 0.42) / 350;
    return { x: W * 0.5, y: H * 0.56 + 35 * s, s };
  }

  frame(dt) {
    dt = Math.min(dt, 0.05);
    this.t += dt;
    const t = this.t, st = this.state, sp = this.sp;
    const scene = SCENES[st.scene] ? st.scene : 'default';
    const sc = SCENES[scene];

    for (const k in SCENES) this.pres[k].t = k === scene ? 1 : 0;
    this.pres.think.t = st.claude === 'thinking' && scene !== 'sleep' ? 1 : 0;
    this.pres.attention.t = st.claude === 'attention' ? 1 : 0;
    this.pres.stress.t = st.stress && scene !== 'sleep' ? 1 : 0;

    // ---- expression = scene mood + overlays + a transient reaction on top
    if (this.expr && t >= this.exprUntil) {
      const next = this.exprQueue.shift();
      if (next) this.express(next[0], next[1]);
      else this.expr = null;
    }
    const m = Object.assign({}, MOODS.neutral, MOODS[sc.mood]);
    if (st.bored && scene !== 'sleep') Object.assign(m, MOODS.bored);
    if (st.lowBatt && scene !== 'sleep') Object.assign(m, MOODS.worried);
    if (this.pres.stress.t) Object.assign(m, MOODS.stress);
    if (this.pres.think.t) Object.assign(m, MOODS.think);
    if (this.expr) Object.assign(m, MOODS[this.expr]);
    for (const k of MOOD_KEYS) sp[k].t = m[k];
    if (scene === 'chat' && !this.expr) {
      const talking = Math.sin(t * 0.9) > -0.2 ? 1 : 0;
      sp.mouthO.t = talking * (0.12 + 0.3 * (0.5 + 0.5 * Math.sin(t * 15)));
    }
    if (t - this.chompAt < 0.28) sp.mouthO.t = 0.85;
    const col = EYE[m.color] || EYE.cyan;
    sp.r.t = col[0];
    sp.g.t = col[1];
    sp.b.t = col[2];

    // ---- eyes wander
    if (t > this.nextLook) {
      const r = scene === 'focus' ? 0.12 : scene === 'sleep' ? 0 : 0.38;
      this.lookOff = [rand(-r, r), rand(-r, r) * 0.6];
      if (scene === 'code' && Math.random() < 0.25) this.lookOff = [rand(-0.2, 0.2), -0.75];
      if (st.bored && Math.random() < 0.5) this.lookOff = [pick([-0.85, 0.85]), rand(-0.2, 0.3)];
      this.nextLook = t + (scene === 'focus' ? rand(3, 6) : rand(1.1, 3.4));
    }
    let lx = sc.look[0] + this.lookOff[0], ly = sc.look[1] + this.lookOff[1];
    if (this.pres.think.t) {
      lx = 0.55;
      ly = -0.6;
    }
    sp.lookX.t = clamp(lx, -1, 1);
    sp.lookY.t = clamp(ly, -1, 1);

    // ---- blink
    if (t > this.nextBlink && scene !== 'sleep') {
      this.blinkAt = t;
      this.nextBlink = t + (Math.random() < 0.18 ? 0.28 : rand(2.2, 5.5) * (scene === 'focus' ? 1.6 : 1));
    }

    // ---- arms
    let [aL, aR] = sc.arms;
    if (scene === 'surf') {
      aL += Math.sin(t * 1.4) * 0.15;
      aR += Math.sin(t * 1.4 + 1.2) * 0.15;
    }
    if (scene === 'default' || st.bored) {
      aL += Math.sin(t * 1.3) * 0.05;
      aR += Math.sin(t * 1.3 + 0.5) * 0.05;
    }
    if (scene === 'chat') aR = 0.6 + Math.sin(t * 3.2) * 0.35;
    if (t < this.waveUntil || this.pres.attention.t > 0.5) aR = 2.55 + Math.sin(t * 13) * 0.35;
    if (t < this.cheerUntil) {
      aL = 2.3 + Math.sin(t * 10) * 0.2;
      aR = 2.3 + Math.sin(t * 10 + 1) * 0.2;
    }
    sp.armL.t = aL;
    sp.armR.t = aR;

    // ---- body
    const sleepy = scene === 'sleep';
    sp.headY.t = Math.sin(t * (sleepy ? 1.1 : 2)) * (sleepy ? 4 : 2) + (scene === 'code' ? 6 : 0);
    let tilt = 0;
    if (scene === 'music') tilt = Math.sin(t * 2.4) * 0.07;
    if (st.bored) tilt = 0.07 + Math.sin(t * 0.5) * 0.03;
    if (sleepy) tilt = 0.1;
    sp.tilt.t = tilt;
    sp.headTilt.t = sp.lookX.x * 0.06 + (st.bored ? 0.1 : 0) + (sleepy ? 0.12 : 0) + (this.pres.think.t ? 0.1 : 0);

    // ---- placement for the current view
    const L = this.layout();
    sp.X.t = L.x;
    sp.Y.t = L.y;
    sp.Sc.t = L.s;
    sp.vb.t = this.view === 'bot' ? 1 : 0;

    this.emitters(dt, scene);

    // ---- integrate (fixed sub-steps keep stiff springs stable when frames drop)
    let left = dt;
    while (left > 1e-4) {
      const h = Math.min(left, 1 / 120);
      for (const k in sp) sp[k].step(h);
      for (const k in this.pres) this.pres[k].step(h);
      left -= h;
    }
    this.updateParticles(dt);
  }

  every(name, interval, dt) {
    this.timers[name] = (this.timers[name] || 0) + dt;
    if (this.timers[name] < interval) return false;
    this.timers[name] = 0;
    return true;
  }

  emitters(dt, scene) {
    const p = (k) => this.pres[k].x;
    if (p('sleep') > 0.5 && this.every('z', 1.3, dt)) {
      this.spawn('z', 70, -160, 22, -38, 2.6, { size: 1 });
    }
    if (p('music') > 0.5 && this.every('note', 0.75, dt)) {
      const side = pick([-1, 1]);
      this.spawn('note', side * rand(110, 150), -110, side * rand(10, 30), rand(-70, -45), 2, { ch: pick(['♪', '♫']) });
    }
    if (p('surf') * this.sp.vb.x > 0.4 && this.every('spray', 0.05, dt)) {
      this.spawn('spray', rand(-180, -150), 150, rand(-150, -60), rand(-130, -40), 0.7, { g: 320, size: rand(2.5, 5) });
    }
    if (p('chat') > 0.5 && this.every('bubble', 1.7, dt)) {
      this.chatSide = -(this.chatSide || 1);
      this.spawn('bubble', this.chatSide * 160, -120, this.chatSide * 8, -28, 2.4, {});
    }
    if (p('funtime') > 0.5 && this.every('pop', this.popEvery || 3, dt)) {
      this.popEvery = rand(2.4, 4.2);
      // popcorn arcs from the bucket into the mouth, then chomp
      const T = 0.62, g = 760, x0 = 48, y0 = 64, x1 = 0, y1 = HEAD_Y + 50;
      this.spawn('pop', x0, y0, (x1 - x0) / T, (y1 - y0 - 0.5 * g * T * T) / T, T, { g, onEnd: () => (this.chompAt = this.t) });
    }
  }

  spawn(type, x, y, vx, vy, life, extra) {
    if (this.parts.length > 120) return;
    this.parts.push(Object.assign({ type, x, y, vx, vy, life, age: 0, g: 0, rot: rand(0, TAU), vr: 0, alpha: 1 }, extra));
  }

  updateParticles(dt) {
    const out = [];
    for (const q of this.parts) {
      q.age += dt;
      if (q.age >= q.life) {
        if (q.onEnd) q.onEnd();
        continue;
      }
      q.vy += q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.vr * dt;
      out.push(q);
    }
    this.parts = out;
  }

  // ------------------------------------------------------------------ rendering

  waveY(x, layer) {
    const { H, t } = this;
    const base = H * [0.7, 0.79, 0.835][layer];
    const a = H * [0.02, 0.028, 0.016][layer];
    return base + Math.sin(x * 0.0062 + t * (1.2 + layer * 0.2) + layer * 2.1) * a
      + Math.sin(x * 0.0145 - t * 0.85 + layer) * a * 0.45;
  }

  draw() {
    const { ctx, W, H, sp, t } = this;
    const p = (k) => this.pres[k].x;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const vb = sp.vb.x;
    const surf = p('surf') * vb;

    let X = sp.X.x, Y = sp.Y.x, s = sp.Sc.x, rot = sp.tilt.x;
    if (surf > 0.01) {
      const sv = s * 0.88;
      const wy = this.waveY(X, 1);
      const slope = (this.waveY(X + 30, 1) - this.waveY(X - 30, 1)) / 60;
      Y = lerp(Y, wy - 150 * sv, surf);
      s = lerp(s, sv, surf);
      rot += (Math.atan(slope) * 0.9 + Math.sin(t * 2.1) * 0.03) * surf;
      this.drawWave(0, surf);
      this.drawWave(1, surf);
    }
    const fun = p('funtime') * vb;
    if (fun > 0.01) this.drawMarquee(fun);

    const spin = t - this.spinAt < 0.9 ? ease((t - this.spinAt) / 0.9) * TAU : 0;
    ctx.save();
    ctx.translate(X, Y - sp.hop.x * s + (1 - surf) * Math.sin(t * 1.7) * 5 * s);
    ctx.scale(s, s);
    ctx.rotate(rot + spin);
    const sq = clamp(sp.sq.x, -0.6, 0.6) * 0.25;
    ctx.translate(0, 130);
    ctx.scale(1 + sq, 1 - sq);
    ctx.translate(0, -130);
    this.drawFigure();
    ctx.restore();

    if (surf > 0.01) this.drawWave(2, surf);
    this.hitBox = { x: X, y: Y - 35 * s, r: 190 * s };
  }

  drawWave(layer, alpha) {
    const { ctx, W, H } = this;
    const fills = [
      ['rgba(46,116,176,.55)', 'rgba(10,40,80,.6)'],
      ['#1f7fb8', '#0b3a66'],
      ['rgba(64,190,232,.85)', 'rgba(14,80,130,.95)'],
    ][layer];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W + 24; x += 24) ctx.lineTo(x, this.waveY(x, layer));
    ctx.lineTo(W + 24, H);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, H * 0.66, 0, H);
    g.addColorStop(0, fills[0]);
    g.addColorStop(1, fills[1]);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    for (let x = 0; x <= W + 24; x += 24) ctx.lineTo(x, this.waveY(x, layer));
    ctx.strokeStyle = layer === 2 ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.22)';
    ctx.lineWidth = layer === 2 ? 3 : 2;
    ctx.stroke();
    ctx.restore();
  }

  drawMarquee(a) {
    const { ctx, W, H, t } = this;
    const m = 16, gap = 34, phase = Math.floor(t * 7);
    let i = 0;
    ctx.save();
    ctx.globalAlpha = a;
    const bulb = (x, y) => {
      const on = (i++ + phase) % 3 === 0;
      if (on) {
        ctx.fillStyle = 'rgba(255,214,107,.22)';
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = on ? '#FFD66B' : 'rgba(255,214,107,.16)';
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, TAU);
      ctx.fill();
    };
    for (let x = m; x <= W - m; x += gap) bulb(x, m);
    for (let y = m + gap; y <= H - m; y += gap) bulb(W - m, y);
    for (let x = W - m - gap; x >= m; x -= gap) bulb(x, H - m);
    for (let y = H - m - gap; y > m; y -= gap) bulb(m, y);
    ctx.restore();
  }

  drawFigure() {
    const { ctx, sp } = this;
    const p = (k) => this.pres[k].x;
    const col = `${sp.r.x | 0},${sp.g.x | 0},${sp.b.x | 0}`;

    const shadow = 1 - p('surf');
    if (shadow > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${0.28 * shadow})`;
      ctx.beginPath();
      ctx.ellipse(0, 196, Math.max(40, 92 - sp.hop.x * 0.15), 13, 0, 0, TAU);
      ctx.fill();
    }
    if (p('focus') > 0.01) this.drawAura(p('focus'), col);
    if (p('surf') > 0.01) this.drawBoard(p('surf'));

    // neck + body
    ctx.fillStyle = '#9AA5BE';
    ctx.beginPath();
    ctx.roundRect(-30, 14, 60, 26, 10);
    ctx.fill();
    ctx.fillStyle = this.shell(BODY_Y - 50, BODY_Y + 50);
    ctx.beginPath();
    ctx.roundRect(-75, BODY_Y - 50, 150, 100, 46);
    ctx.fill();
    this.drawBelly(col);
    this.drawArm(-1, sp.armL.x);
    this.drawArm(1, sp.armR.x);

    // head
    ctx.save();
    ctx.translate(0, HEAD_Y + sp.headY.x);
    ctx.rotate(sp.headTilt.x);
    this.drawHead(col);
    ctx.restore();

    if (p('code') > 0.01) this.drawLaptop(p('code'), col);
    if (p('funtime') > 0.01) this.drawPopcorn(p('funtime'));
    if (p('think') > 0.01) this.drawBubble(p('think'), 'think');
    if (p('attention') > 0.01) this.drawBubble(p('attention'), 'attention');
    this.drawParticles(col);
  }

  shell(y0, y1) {
    const g = this.ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#FFFFFF');
    g.addColorStop(1, '#D3DBEA');
    return g;
  }

  drawBelly(col) {
    const { ctx, t } = this;
    const glyph = (SCENES[this.state.scene] || SCENES.default).belly;
    ctx.fillStyle = '#0E1324';
    ctx.beginPath();
    ctx.roundRect(-28, BODY_Y - 14, 56, 32, 11);
    ctx.fill();
    ctx.fillStyle = `rgba(${col},${0.65 + 0.35 * Math.sin(t * 3)})`;
    ctx.font = `700 ${glyph.length > 1 ? 15 : 20}px Outfit, system-ui, sans-serif`;
    ctx.fillText(glyph, 0, BODY_Y + 2);
  }

  drawArm(side, ang) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(side * 66, BODY_Y - 28);
    ctx.rotate(-side * ang);
    ctx.fillStyle = '#E4E9F3';
    ctx.beginPath();
    ctx.roundRect(-12, -6, 24, 62, 12);
    ctx.fill();
    ctx.fillStyle = '#F8FAFD';
    ctx.beginPath();
    ctx.arc(0, 56, 13, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawHead(col) {
    const { ctx, sp, t } = this;
    const p = (k) => this.pres[k].x;

    // ears
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#C3CCDD';
      ctx.beginPath();
      ctx.roundRect(side * 120 - 11, -32, 22, 64, 10);
      ctx.fill();
      ctx.fillStyle = `rgb(${col})`;
      ctx.beginPath();
      ctx.arc(side * 127, 0, 4, 0, TAU);
      ctx.fill();
    }

    // antenna
    ctx.save();
    ctx.translate(0, -93);
    ctx.rotate(clamp(sp.ant.x, -0.9, 0.9));
    ctx.fillStyle = '#A9B4CB';
    ctx.fillRect(-3, -32, 6, 34);
    ctx.fillStyle = `rgba(${col},.22)`;
    ctx.beginPath();
    ctx.arc(0, -38, 19, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgb(${col})`;
    ctx.beginPath();
    ctx.arc(0, -38, 10, 0, TAU);
    ctx.fill();
    ctx.restore();

    // shell
    ctx.fillStyle = this.shell(-95, 95);
    ctx.beginPath();
    ctx.roundRect(-120, -95, 240, 190, 74);
    ctx.fill();
    if (p('focus') > 0.01) this.drawHeadband(p('focus'));

    // visor + face
    const vg = ctx.createLinearGradient(0, -62, 0, 74);
    vg.addColorStop(0, '#161D35');
    vg.addColorStop(1, '#080C17');
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-98, -62, 196, 136, 52);
    ctx.clip();
    ctx.fillStyle = vg;
    ctx.fill();
    this.drawFace(col, vg);
    ctx.restore();

    // visor gloss
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.beginPath();
    ctx.ellipse(-36, -46, 48, 11, -0.12, 0, TAU);
    ctx.fill();

    if (p('funtime') > 0.01) this.drawGlasses(p('funtime'));
    if (p('music') > 0.01) this.drawHeadphones(p('music'), col);
    if (p('stress') > 0.01) {
      const k = (t * 0.6) % 1;
      ctx.save();
      ctx.globalAlpha = p('stress') * (1 - k * 0.6);
      ctx.translate(104, -58 + k * 44);
      ctx.fillStyle = '#8FD3FF';
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.quadraticCurveTo(10, 2, 0, 9);
      ctx.quadraticCurveTo(-10, 2, 0, -14);
      ctx.fill();
      ctx.restore();
    }
  }

  drawFace(col, vg) {
    const { ctx, sp, t } = this;
    const bt = t - this.blinkAt;
    const blink = bt < 0.15 ? Math.sin((Math.PI * bt) / 0.15) : 0;
    const open = clamp(sp.open.x, 0.04, 1.4) * (1 - blink * 0.94);
    const lx = sp.lookX.x, ly = sp.lookY.x;
    const glow = sp.glow.x;
    const eyes = [];

    for (const side of [-1, 1]) {
      const persp = 1 + side * lx * 0.09;
      const w = 54 * sp.eyeW.x * persp * (1 + (1 - Math.min(open, 1)) * 0.12);
      const h = Math.max(5, 72 * sp.eyeH.x * open * persp);
      const cx = side * 46 + lx * 22, cy = 2 + ly * 15;
      eyes.push([cx, cy]);
      ctx.fillStyle = `rgb(${col})`;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - h / 2, w, h, Math.min(24, w / 2, h / 2));
      ctx.fill();
      if (h > 16) {
        ctx.fillStyle = `rgba(255,255,255,${0.85 * Math.min(1, (h - 16) / 30)})`;
        ctx.beginPath();
        ctx.arc(cx - w * 0.2, cy - h * 0.22, Math.min(w, h) * 0.11, 0, TAU);
        ctx.fill();
      }
      const hp = clamp(sp.happy.x, 0, 1);
      if (hp > 0.02) {
        // a visor-coloured ellipse rising from below turns the eye into a smiling arch
        const ry = h * 0.62;
        ctx.fillStyle = vg;
        ctx.beginPath();
        ctx.ellipse(cx, cy + h * 0.5 + ry * 0.98 - hp * h * 0.66, w * 0.85, ry, 0, 0, TAU);
        ctx.fill();
      }
      const lid = sp.lid.x, la = sp.lidAng.x;
      if (lid > 0.01 || Math.abs(la) > 0.01) {
        ctx.save();
        ctx.translate(cx, cy - h / 2 + lid * h);
        ctx.rotate(-side * la);
        ctx.fillStyle = vg;
        ctx.fillRect(-w, -h * 2, w * 2, h * 2);
        ctx.restore();
      }
    }

    ctx.globalCompositeOperation = 'lighter';
    const ga = 0.2 * glow * Math.min(1, open + 0.25);
    for (const [cx, cy] of eyes) {
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 64);
      g.addColorStop(0, `rgba(${col},${ga})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - 64, cy - 64, 128, 128);
    }
    ctx.globalCompositeOperation = 'source-over';

    // blush
    const bl = clamp(sp.blush.x, 0, 1);
    if (bl > 0.02) {
      ctx.fillStyle = `rgba(255,110,170,${0.45 * bl})`;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(side * 72 + lx * 10, 42, 15, 8, 0, 0, TAU);
        ctx.fill();
      }
    }

    // mouth
    const mo = clamp(sp.mouthO.x, 0, 1), sm = sp.smile.x;
    const mx = lx * 10, my = 50 + ly * 6, mw = 15;
    ctx.strokeStyle = ctx.fillStyle = `rgb(${col})`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (mo < 0.06) {
      ctx.moveTo(mx - mw, my - sm * 3);
      ctx.quadraticCurveTo(mx, my + sm * 13, mx + mw, my - sm * 3);
      ctx.stroke();
    } else {
      const oh = mo * 22;
      ctx.moveTo(mx - mw, my - sm * 2);
      ctx.quadraticCurveTo(mx, my + sm * 5, mx + mw, my - sm * 2);
      ctx.quadraticCurveTo(mx, my + oh + sm * 9, mx - mw, my - sm * 2);
      ctx.fill();
      if (oh > 8) {
        ctx.fillStyle = 'rgba(255,120,165,.95)';
        ctx.beginPath();
        ctx.ellipse(mx, my + oh * 0.55 + sm * 3, mw * 0.42, oh * 0.2, 0, 0, TAU);
        ctx.fill();
      }
    }
  }

  drawHeadband(a) {
    const { ctx, t } = this;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-120, -95, 240, 190, 74);
    ctx.clip();
    ctx.fillStyle = '#E8384F';
    ctx.fillRect(-130, -92 - (1 - a) * 20, 260, 24);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect(-130, -86 - (1 - a) * 20, 260, 3);
    ctx.restore();
    const kx = 112, ky = -80;
    ctx.strokeStyle = '#D72F45';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      const w = Math.sin(t * 9 + i * 1.3) * 8;
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.quadraticCurveTo(kx + 30, ky + 6 + i * 10 + w, kx + 58, ky + 18 + i * 16 - w);
      ctx.stroke();
    }
    ctx.fillStyle = '#F04A60';
    ctx.beginPath();
    ctx.arc(kx, ky, 9, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawGlasses(a) {
    const { ctx } = this;
    const y = 2 - (1 - a) * 30;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#F5F7FF';
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.fillStyle = side < 0 ? 'rgba(255,60,95,.45)' : 'rgba(60,200,255,.45)';
      ctx.beginPath();
      ctx.roundRect(side * 46 - 35, y - 29, 70, 58, 15);
      ctx.fill();
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(side * 81, y - 14);
      ctx.lineTo(side * 119, y - 22);
      ctx.stroke();
    }
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-11, y - 6);
    ctx.lineTo(11, y - 6);
    ctx.stroke();
    ctx.restore();
  }

  drawHeadphones(a, col) {
    const { ctx } = this;
    const lift = -(1 - a) * 40;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#5B4B8A';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, -8 + lift, 132, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    for (const side of [-1, 1]) {
      ctx.fillStyle = '#6E5BA8';
      ctx.beginPath();
      ctx.roundRect(side * 126 - 18, -36 + lift, 36, 76, 16);
      ctx.fill();
      ctx.strokeStyle = `rgba(${col},.9)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(side * 126 - 10, -24 + lift, 20, 52, 9);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawAura(a, col) {
    const { ctx, t } = this;
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.35 + i / 3) % 1;
      ctx.strokeStyle = `rgba(${col},${(1 - ph) * 0.22 * a})`;
      ctx.beginPath();
      ctx.arc(0, -35, 170 + ph * 170, 0, TAU);
      ctx.stroke();
    }
  }

  drawBoard(a) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = '#E85A4F';
    ctx.beginPath();
    ctx.moveTo(-128, 160);
    ctx.lineTo(-104, 160);
    ctx.lineTo(-122, 184);
    ctx.closePath();
    ctx.fill();
    const g = ctx.createLinearGradient(-175, 0, 175, 0);
    g.addColorStop(0, '#FF6F61');
    g.addColorStop(1, '#FFC15E');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 150, 175, 15, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-140, 150);
    ctx.lineTo(140, 150);
    ctx.stroke();
    ctx.restore();
  }

  drawLaptop(a, col) {
    const { ctx, t } = this;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(0, (1 - a) * 40);
    ctx.fillStyle = '#3A4256';
    ctx.beginPath();
    ctx.moveTo(-100, 150);
    ctx.lineTo(100, 150);
    ctx.lineTo(118, 164);
    ctx.lineTo(-118, 164);
    ctx.closePath();
    ctx.fill();
    const g = ctx.createLinearGradient(0, 58, 0, 152);
    g.addColorStop(0, '#4D5875');
    g.addColorStop(1, '#2A3144');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(-92, 58, 184, 94, 10);
    ctx.fill();
    ctx.fillStyle = `rgba(${col},.22)`;
    ctx.beginPath();
    ctx.arc(0, 104, 20, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(${col},${0.75 + 0.25 * Math.sin(t * 4)})`;
    ctx.beginPath();
    ctx.arc(0, 104, 8, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawPopcorn(a) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(48, 96 + (1 - a) * 40);
    ctx.fillStyle = '#FFF4D6';
    ctx.strokeStyle = '#EED29A';
    ctx.lineWidth = 2;
    for (const [x, y] of [[-22, -30], [-8, -38], [8, -35], [22, -29], [0, -27], [-14, -24], [14, -23]]) {
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-32, -24);
    ctx.lineTo(32, -24);
    ctx.lineTo(24, 40);
    ctx.lineTo(-24, 40);
    ctx.closePath();
    ctx.clip();
    for (let i = -4; i <= 4; i++) {
      ctx.fillStyle = i % 2 ? '#E8384F' : '#FFFFFF';
      ctx.fillRect(i * 12 - 6, -30, 12, 80);
    }
    ctx.restore();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(-35, -28, 70, 8, 4);
    ctx.fill();
    ctx.restore();
  }

  drawBubble(a, kind) {
    const { ctx, t } = this;
    const side = this.view === 'media' ? -1 : 1; // keep it on-screen when tucked in the corner
    const bob = Math.sin(t * 2) * 5;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    for (const [x, y, r] of [[92, -152, 6], [116, -180, 9]]) {
      ctx.beginPath();
      ctx.arc(side * x, y + bob * 0.5, r, 0, TAU);
      ctx.fill();
    }
    const cx = side * 168, cy = -226 + bob;
    ctx.beginPath();
    ctx.roundRect(cx - 52, cy - 30, 104, 60, 30);
    ctx.fill();
    if (kind === 'think') {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 2.4);
      ctx.strokeStyle = '#D97757';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(-15, 0);
        ctx.lineTo(15, 0);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.fillStyle = '#E8384F';
      ctx.font = '800 38px Outfit, system-ui, sans-serif';
      ctx.fillText('!', cx, cy + 2 - Math.abs(Math.sin(t * 6)) * 5);
    }
    ctx.restore();
  }

  drawParticles(col) {
    const { ctx } = this;
    for (const q of this.parts) {
      const k = q.age / q.life;
      ctx.globalAlpha = clamp(k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85, 0, 1) * q.alpha;
      switch (q.type) {
        case 'z':
          ctx.fillStyle = '#B9C8FF';
          ctx.font = `700 ${18 + k * 24}px Outfit, system-ui, sans-serif`;
          ctx.fillText('z', q.x, q.y);
          break;
        case 'note':
          ctx.fillStyle = `rgb(${col})`;
          ctx.font = '700 32px system-ui, sans-serif';
          ctx.fillText(q.ch, q.x, q.y);
          break;
        case 'glyph':
          ctx.fillStyle = `rgb(${col})`;
          ctx.font = '700 22px ui-monospace, monospace';
          ctx.fillText(q.ch, q.x, q.y);
          break;
        case 'heart': {
          const s = q.size * (0.7 + k * 0.5);
          ctx.fillStyle = '#FF6FA8';
          ctx.beginPath();
          ctx.moveTo(q.x, q.y + s * 0.35);
          ctx.bezierCurveTo(q.x - s * 0.6, q.y - s * 0.15, q.x - s * 0.25, q.y - s * 0.65, q.x, q.y - s * 0.3);
          ctx.bezierCurveTo(q.x + s * 0.25, q.y - s * 0.65, q.x + s * 0.6, q.y - s * 0.15, q.x, q.y + s * 0.35);
          ctx.fill();
          break;
        }
        case 'spray':
          ctx.fillStyle = 'rgba(225,246,255,.95)';
          ctx.beginPath();
          ctx.arc(q.x, q.y, q.size, 0, TAU);
          ctx.fill();
          break;
        case 'pop':
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#FFF4D6';
          ctx.beginPath();
          ctx.arc(q.x, q.y, 9, 0, TAU);
          ctx.fill();
          break;
        case 'confetti':
          ctx.save();
          ctx.translate(q.x, q.y);
          ctx.rotate(q.rot);
          ctx.fillStyle = q.color;
          ctx.fillRect(-6, -3.5, 12, 7);
          ctx.restore();
          break;
        case 'bubble': {
          ctx.fillStyle = 'rgba(255,255,255,.9)';
          ctx.beginPath();
          ctx.roundRect(q.x - 36, q.y - 21, 72, 42, 20);
          ctx.fill();
          ctx.fillStyle = '#7A86A8';
          for (let i = 0; i < 3; i++) {
            const b = Math.max(0, Math.sin(q.age * 8 - i * 0.8)) * 4;
            ctx.beginPath();
            ctx.arc(q.x - 14 + i * 14, q.y - b, 4.5, 0, TAU);
            ctx.fill();
          }
          break;
        }
        case 'spark': {
          const s = q.size * (1 - Math.abs(k - 0.5));
          ctx.fillStyle = '#FFE27A';
          ctx.beginPath();
          ctx.moveTo(q.x, q.y - s);
          ctx.quadraticCurveTo(q.x, q.y, q.x + s, q.y);
          ctx.quadraticCurveTo(q.x, q.y, q.x, q.y + s);
          ctx.quadraticCurveTo(q.x, q.y, q.x - s, q.y);
          ctx.quadraticCurveTo(q.x, q.y, q.x, q.y - s);
          ctx.fill();
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}
