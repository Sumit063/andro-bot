// sound.js — tiny synthesized sound effects and a robot voice, played on the tablet.
// No audio files: every effect is a few oscillators, so it starts instantly and weighs nothing.
// Browsers keep audio locked until the first tap; unlock() is called from that tap.

export function inQuietHours(q) {
  if (!Array.isArray(q) || q.length !== 2) return false;
  const h = new Date().getHours();
  const [from, to] = q;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

const FX = {
  tap: (s, t) => { s.tone(1600, 1200, t, 0.04, { gain: 0.07 }); return 0.05; },
  blip: (s, t) => { s.tone(880, 1320, t, 0.09, { gain: 0.12 }); return 0.1; },
  giggle: (s, t) => {
    [700, 950, 820, 1100].forEach((f, i) => s.tone(f, f * 1.15, t + i * 0.075, 0.07, { type: 'triangle', gain: 0.16 }));
    return 0.35;
  },
  wake: (s, t) => {
    s.tone(420, 1100, t, 0.18, { type: 'triangle', gain: 0.18 });
    s.tone(700, 1600, t + 0.16, 0.2, { type: 'triangle', gain: 0.16 });
    return 0.4;
  },
  yawn: (s, t) => { s.tone(520, 240, t, 0.9, { type: 'sawtooth', gain: 0.06, attack: 0.15, lowpass: 900, vibrato: 5 }); return 0.9; },
  gong: (s, t) => {
    [196, 392, 589, 784].forEach((f, i) => s.tone(f, f * 0.995, t, 2.2 - i * 0.35, { gain: 0.18 / (i + 1), attack: 0.004 }));
    return 1.5;
  },
  tada: (s, t) => {
    [523, 659, 784].forEach((f, i) => s.tone(f, f, t + i * 0.09, 0.16, { type: 'triangle', gain: 0.16 }));
    s.tone(1047, 1047, t + 0.27, 0.55, { type: 'triangle', gain: 0.18 });
    return 0.8;
  },
  ping: (s, t) => {
    s.tone(1319, 1319, t, 0.25, { gain: 0.15 });
    s.tone(1760, 1760, t + 0.13, 0.35, { gain: 0.13 });
    return 0.5;
  },
  chime: (s, t) => {
    s.tone(1047, 1047, t, 1.2, { gain: 0.14 });
    s.tone(1568, 1568, t + 0.02, 1, { gain: 0.08 });
    s.tone(2093, 2093, t + 0.04, 0.7, { gain: 0.05 });
    return 1;
  },
  zap: (s, t) => {
    s.tone(180, 1400, t, 0.16, { type: 'square', gain: 0.07, lowpass: 3000 });
    s.tone(1400, 2200, t + 0.15, 0.12, { type: 'triangle', gain: 0.1 });
    return 0.3;
  },
  buzz: (s, t) => { s.tone(150, 110, t, 0.45, { type: 'square', gain: 0.1, lowpass: 1200, vibrato: 18 }); return 0.5; },
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.6;
    this.quietHours = null;
    this.busyUntil = 0; // the mic ignores the room while the bot itself is making noise
    this.voiceUnlocked = false;
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  unlock() {
    const ctx = this.ensure();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (!this.voiceUnlocked && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      speechSynthesis.speak(u);
      this.voiceUnlocked = true;
    }
  }

  muted() {
    return !this.enabled || inQuietHours(this.quietHours);
  }

  tone(f0, f1, t, dur, o = {}) {
    const c = this.ctx;
    const { type = 'sine', gain = 0.25, attack = 0.006 } = o;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (o.lowpass) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lowpass;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    if (o.vibrato) {
      const lfo = c.createOscillator(), depth = c.createGain();
      lfo.frequency.value = o.vibrato;
      depth.gain.value = f0 * 0.06;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
  }

  play(name) {
    const fx = FX[name];
    if (!fx || this.muted() || !this.ready) return;
    this.master.gain.value = this.volume;
    const len = fx(this, this.ctx.currentTime + 0.01);
    this.busyUntil = Math.max(this.busyUntil, performance.now() + len * 1000 + 300);
  }

  speak(text) {
    if (this.muted() || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = 1.7; // small-robot voice
    u.rate = 1.05;
    u.volume = Math.min(1, this.volume + 0.3);
    const voice = speechSynthesis.getVoices().find((v) => /^en/i.test(v.lang));
    if (voice) u.voice = voice;
    this.busyUntil = performance.now() + 3000;
    u.onend = () => (this.busyUntil = performance.now() + 400);
    speechSynthesis.speak(u);
  }
}
