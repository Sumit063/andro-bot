// ears.js — listens to the room through the tablet mic and reports sustained shouting.
// Audio is only measured in memory (loudness + how voice-like it is): nothing is recorded,
// stored, played back or sent anywhere.

export class Ears {
  constructor(sound) {
    this.sound = sound;
    this.stream = null;
    this.starting = false;
    this.error = null;          // 'insecure' | 'denied' | 'failed'
    this.level = -100;          // current loudness, dBFS
    this.floor = -60;           // learned room noise level
    this.threshold = -20;       // what counts as shouting right now
    this.sensitivity = 0.5;     // 0 = only very loud, 1 = easily annoyed
    this.strict = false;        // raised bar while the Mac is playing media near the tablet
    this.score = 0;
    this.lastShout = -1e9;
    this.cooldown = 40000;
    this.onShout = null;
  }

  get active() {
    return !!this.stream;
  }

  async start() {
    if (this.stream || this.starting) return;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      this.error = 'insecure'; // Chrome only exposes the mic on https:// or flagged origins
      return;
    }
    this.starting = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = this.sound.ensure();
      this.an = ctx.createAnalyser();
      this.an.fftSize = 2048;
      this.an.smoothingTimeConstant = 0;
      ctx.createMediaStreamSource(this.stream).connect(this.an); // analysed only, never routed to the speaker
      this.td = new Float32Array(this.an.fftSize);
      this.fd = new Float32Array(this.an.frequencyBinCount);
      this.timer = setInterval(() => this.tick(), 50);
      this.error = null;
    } catch (e) {
      this.error = e && e.name === 'NotAllowedError' ? 'denied' : 'failed';
      this.stop();
    }
    this.starting = false;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.level = -100;
    this.score = 0;
  }

  tick() {
    if (!this.sound.ready) return;
    this.an.getFloatTimeDomainData(this.td);
    let sum = 0;
    for (let i = 0; i < this.td.length; i++) sum += this.td[i] * this.td[i];
    const db = 10 * Math.log10(sum / this.td.length + 1e-12);
    this.level = db;

    // Shouting is voice: most of its energy sits between ~250 Hz and 3.5 kHz.
    this.an.getFloatFrequencyData(this.fd);
    const binHz = this.sound.ctx.sampleRate / this.an.fftSize;
    let voice = 0, total = 0;
    for (let i = 1; i < this.fd.length; i++) {
      const f = i * binHz;
      if (f > 8000) break;
      const p = Math.pow(10, this.fd[i] / 10);
      total += p;
      if (f >= 250 && f <= 3500) voice += p;
    }
    const voiceRatio = total > 0 ? voice / total : 0;

    // Room noise floor: drops quickly to quiet moments, creeps up slowly (fans, AC, traffic).
    if (db < this.floor) this.floor += (db - this.floor) * 0.2;
    else this.floor += 0.02;

    const s = this.sensitivity;
    this.threshold = Math.max(this.floor + (32 - 20 * s), -12 - 20 * s) + (this.strict ? 9 : 0);
    const hearingItself = performance.now() < this.sound.busyUntil;
    const loud = !hearingItself && db > this.threshold && voiceRatio > 0.5;

    // Must stay loud for ~0.5 s (door slams and claps are too short), brief dips allowed.
    this.score = loud ? this.score + 1 : Math.max(0, this.score - 0.5);
    if (this.score >= 9 && performance.now() - this.lastShout > this.cooldown) {
      this.lastShout = performance.now();
      this.score = 0;
      if (this.onShout) this.onShout(db);
    }
  }
}
