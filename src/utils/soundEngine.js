const audioCtxRef = { current: null };

function getAudioCtx() {
  if (!audioCtxRef.current) {
    try {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return null; }
  }
  if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
  return audioCtxRef.current;
}

// ── Helper: single organic bird note ─────────────────────────
// freq: base Hz, offset: seconds from ctx.currentTime, vol: gain peak,
// glide: [startFreq, endFreq] optional, dur: note sustain seconds
function birdNote(ctx, { freq, offset = 0, vol = 0.15, dur = 0.10, glideUp = 0, glideDown = 0, filterFreq = null }) {
  const t   = ctx.currentTime + offset;
  const osc = ctx.createOscillator();
  const gn  = ctx.createGain();
  const bpf = ctx.createBiquadFilter();

  bpf.type            = 'bandpass';
  bpf.frequency.value = filterFreq || freq * 1.4;
  bpf.Q.value         = 1.2;

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  if (glideUp)   osc.frequency.exponentialRampToValueAtTime(freq * glideUp,   t + dur * 0.6);
  if (glideDown) osc.frequency.exponentialRampToValueAtTime(freq * glideDown, t + dur);

  gn.gain.setValueAtTime(0, t);
  gn.gain.linearRampToValueAtTime(vol, t + 0.018);
  gn.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.06);

  osc.connect(bpf); bpf.connect(gn); gn.connect(ctx.destination);
  osc.start(t); osc.stop(t + dur + 0.10);
}

// ── Helper: two-note warble for a single "bird" ───────────────
function birdWarble(ctx, { freq1, freq2, offset = 0, vol = 0.15, gap = 0.10 }) {
  birdNote(ctx, { freq: freq1, offset,        vol, dur: 0.09, glideUp: freq2 / freq1 });
  birdNote(ctx, { freq: freq2, offset: offset + gap, vol, dur: 0.13, glideUp: 1.12, glideDown: 0.92 });
}

// ── Quiz correct (single-answer warble) ──────────────────────
function playQuizCorrect(ctx) {
  const notes = [523.25, 659.25, 783.99, 1046.50]; // C5 E5 G5 C6
  notes.forEach((freq, i) => {
    const t   = ctx.currentTime + i * 0.08;
    const osc = ctx.createOscillator();
    const gn  = ctx.createGain();
    const bpf = ctx.createBiquadFilter();

    osc.type      = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    if (i === notes.length - 1) {
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.linearRampToValueAtTime(freq * 1.03, t + 0.06);
      osc.frequency.linearRampToValueAtTime(freq,        t + 0.12);
      osc.frequency.linearRampToValueAtTime(freq * 1.03, t + 0.18);
      osc.frequency.linearRampToValueAtTime(freq,        t + 0.24);
    }

    bpf.type            = 'bandpass';
    bpf.frequency.value = freq * 1.5;
    bpf.Q.value         = 3;

    gn.gain.setValueAtTime(0, t);
    gn.gain.linearRampToValueAtTime(0.22, t + 0.015);
    gn.gain.exponentialRampToValueAtTime(0.001, t + (i === notes.length - 1 ? 0.42 : 0.14));

    osc.connect(bpf);
    bpf.connect(gn);
    gn.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (i === notes.length - 1 ? 0.45 : 0.16));
  });
}

function playQuizWrong(ctx) {
  const t   = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gn  = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(783.99, t);
  osc.frequency.linearRampToValueAtTime(587.33, t + 0.18);
  osc.frequency.linearRampToValueAtTime(622.25, t + 0.30);
  osc.frequency.linearRampToValueAtTime(587.33, t + 0.42);

  const osc2 = ctx.createOscillator();
  const gn2  = ctx.createGain();
  osc2.type  = 'sine';
  osc2.frequency.setValueAtTime(440, t + 0.32);
  osc2.frequency.linearRampToValueAtTime(493.88, t + 0.46);

  gn.gain.setValueAtTime(0, t);
  gn.gain.linearRampToValueAtTime(0.18, t + 0.02);
  gn.gain.exponentialRampToValueAtTime(0.001, t + 0.48);

  gn2.gain.setValueAtTime(0, t + 0.32);
  gn2.gain.linearRampToValueAtTime(0.10, t + 0.36);
  gn2.gain.exponentialRampToValueAtTime(0.001, t + 0.52);

  osc.connect(gn);   gn.connect(ctx.destination);
  osc2.connect(gn2); gn2.connect(ctx.destination);

  osc.start(t);          osc.stop(t + 0.50);
  osc2.start(t + 0.32);  osc2.stop(t + 0.54);
}

// ── Quiz complete: SAD (score <= 50) ─────────────────────────
// Sparse, wistful — 3 birds calling across long silences, descending minor phrases
function playQuizCompleteLow(ctx) {
  // Bird 1: slow drooping call, then silence
  birdNote(ctx, { freq: 880,  offset: 0.00, vol: 0.14, dur: 0.22, glideDown: 0.72 });
  birdNote(ctx, { freq: 740,  offset: 0.28, vol: 0.11, dur: 0.18, glideDown: 0.80 });

  // Long silence...

  // Bird 2: answers with its own falling phrase
  birdNote(ctx, { freq: 1046, offset: 0.90, vol: 0.13, dur: 0.16, glideDown: 0.68 });
  birdNote(ctx, { freq: 880,  offset: 1.12, vol: 0.10, dur: 0.20, glideDown: 0.75 });

  // More silence...

  // Bird 3: a single soft, trailing note
  birdNote(ctx, { freq: 698,  offset: 1.90, vol: 0.12, dur: 0.28, glideDown: 0.82 });

  // Bird 1 again, faint, trailing off
  birdNote(ctx, { freq: 622,  offset: 2.35, vol: 0.08, dur: 0.30, glideDown: 0.78 });
}

// ── Quiz complete: NEUTRAL (score 51–84) ─────────────────────
// A few birds chattering normally — overlapping, conversational, no drama
function playQuizCompleteMid(ctx) {
  // Bird A: two quick chirps
  birdNote(ctx, { freq: 1200, offset: 0.00, vol: 0.14, dur: 0.08, glideUp: 1.15 });
  birdNote(ctx, { freq: 1100, offset: 0.11, vol: 0.12, dur: 0.09, glideUp: 1.10, glideDown: 0.95 });

  // Bird B: overlapping warble
  birdWarble(ctx, { freq1: 980, freq2: 1320, offset: 0.08, vol: 0.13, gap: 0.10 });

  // Bird C: chirp after a short gap
  birdNote(ctx, { freq: 1450, offset: 0.36, vol: 0.11, dur: 0.07, glideUp: 1.18 });

  // Bird A again: responds
  birdNote(ctx, { freq: 1180, offset: 0.52, vol: 0.13, dur: 0.09, glideUp: 1.12 });
  birdNote(ctx, { freq: 1060, offset: 0.63, vol: 0.10, dur: 0.10, glideDown: 0.92 });

  // Bird B again: short closing warble
  birdWarble(ctx, { freq1: 1050, freq2: 1400, offset: 0.75, vol: 0.12, gap: 0.09 });

  // Bird D: brief single note to end
  birdNote(ctx, { freq: 1250, offset: 1.00, vol: 0.10, dur: 0.08, glideUp: 1.08 });
}

// ── Quiz complete: HIGH (score >= 85) ─────────────────────────
// Excited, triumphant — dense overlapping ascending calls from several birds
function playQuizCompleteHigh(ctx) {
  // Bird A: fast ascending triple chirp
  birdNote(ctx, { freq: 1050, offset: 0.00, vol: 0.16, dur: 0.07, glideUp: 1.22 });
  birdNote(ctx, { freq: 1280, offset: 0.09, vol: 0.17, dur: 0.07, glideUp: 1.20 });
  birdNote(ctx, { freq: 1560, offset: 0.18, vol: 0.18, dur: 0.09, glideUp: 1.18 });

  // Bird B: joins in with its own ascending warble, slightly offset
  birdWarble(ctx, { freq1: 880,  freq2: 1320, offset: 0.05, vol: 0.15, gap: 0.08 });
  birdWarble(ctx, { freq1: 1100, freq2: 1760, offset: 0.22, vol: 0.16, gap: 0.08 });

  // Bird C: rapid high trill
  birdNote(ctx, { freq: 1800, offset: 0.14, vol: 0.14, dur: 0.06, glideUp: 1.14 });
  birdNote(ctx, { freq: 2000, offset: 0.21, vol: 0.14, dur: 0.06, glideUp: 1.10 });
  birdNote(ctx, { freq: 2200, offset: 0.28, vol: 0.15, dur: 0.07, glideUp: 1.08 });

  // Bird D: full warble building to peak
  birdWarble(ctx, { freq1: 1320, freq2: 1980, offset: 0.32, vol: 0.16, gap: 0.09 });

  // All birds: brief celebratory chorus
  birdNote(ctx, { freq: 1560, offset: 0.52, vol: 0.17, dur: 0.10, glideUp: 1.20 });
  birdNote(ctx, { freq: 1200, offset: 0.54, vol: 0.15, dur: 0.10, glideUp: 1.15 });
  birdNote(ctx, { freq: 1980, offset: 0.56, vol: 0.14, dur: 0.09, glideUp: 1.12 });

  // Trailing high note — one bird singing over the rest
  birdNote(ctx, { freq: 2100, offset: 0.70, vol: 0.18, dur: 0.18, glideUp: 1.10, glideDown: 0.95 });
  birdNote(ctx, { freq: 1760, offset: 0.74, vol: 0.13, dur: 0.12, glideUp: 1.08 });

  // Final held high warble
  birdWarble(ctx, { freq1: 1760, freq2: 2350, offset: 0.92, vol: 0.16, gap: 0.10 });
  birdNote(ctx, { freq: 2350, offset: 1.12, vol: 0.15, dur: 0.22, glideDown: 0.90 });
}

// ── Route by score ────────────────────────────────────────────
function playQuizComplete(ctx, score = 75) {
  if (score <= 50) playQuizCompleteLow(ctx);
  else if (score >= 85) playQuizCompleteHigh(ctx);
  else playQuizCompleteMid(ctx);
}

const SOUNDS = {
  chirp: (ctx) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 1.2;
    o.connect(f); f.connect(g); g.connect(ctx.destination);
    o.type = 'sine';
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(2100, t + 0.09);
    o.frequency.exponentialRampToValueAtTime(1600, t + 0.14);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.start(t); o.stop(t + 0.22);
  },
  warble: (ctx) => {
    const o1 = ctx.createOscillator(), g1 = ctx.createGain(), f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 1400; f1.Q.value = 1.0;
    o1.connect(f1); f1.connect(g1); g1.connect(ctx.destination);
    o1.type = 'sine';
    o1.frequency.setValueAtTime(1050, ctx.currentTime);
    o1.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.08);
    g1.gain.setValueAtTime(0, ctx.currentTime);
    g1.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.13);
    o1.start(ctx.currentTime); o1.stop(ctx.currentTime + 0.15);
    const o2 = ctx.createOscillator(), g2 = ctx.createGain(), f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 2000; f2.Q.value = 1.0;
    o2.connect(f2); f2.connect(g2); g2.connect(ctx.destination);
    o2.type = 'sine';
    const t2 = ctx.currentTime + 0.11;
    o2.frequency.setValueAtTime(1500, t2);
    o2.frequency.exponentialRampToValueAtTime(2400, t2 + 0.1);
    o2.frequency.exponentialRampToValueAtTime(2000, t2 + 0.16);
    g2.gain.setValueAtTime(0, t2);
    g2.gain.linearRampToValueAtTime(0.20, t2 + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.22);
    o2.start(t2); o2.stop(t2 + 0.24);
  },
  click_tone: (ctx) => {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.02, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++)
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
    const src = ctx.createBufferSource(), cg = ctx.createGain();
    src.buffer = buf; src.connect(cg); cg.connect(ctx.destination);
    cg.gain.value = 0.15; src.start();
    const o = ctx.createOscillator(), tg = ctx.createGain();
    o.connect(tg); tg.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 698.46;
    tg.gain.setValueAtTime(0, ctx.currentTime + 0.02);
    tg.gain.linearRampToValueAtTime(0.14, ctx.currentTime + 0.05);
    tg.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.start(ctx.currentTime + 0.02); o.stop(ctx.currentTime + 0.42);
  },
  mouse_click: (ctx) => {
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(1, Math.floor(sr * 0.025), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const env = i < sr * 0.003
        ? i / (sr * 0.003)
        : Math.pow(1 - (i - sr * 0.003) / (d.length - sr * 0.003), 2.5);
      d[i] = (Math.random() * 2 - 1) * env * 0.9;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 800;
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass';  lpf.frequency.value = 6000;
    const g = ctx.createGain(); g.gain.value = 0.55;
    src.connect(hpf); hpf.connect(lpf); lpf.connect(g); g.connect(ctx.destination);
    src.start();
  },
  none:          () => {},
  quiz_correct:  (ctx) => playQuizCorrect(ctx),
  quiz_wrong:    (ctx) => playQuizWrong(ctx),
  quiz_complete: (ctx) => playQuizComplete(ctx),
};

export function playSound(profile = 'chirp') {
  const ctx = getAudioCtx();
  if (!ctx || profile === 'none') return;
  try { SOUNDS[profile]?.(ctx); } catch {}
}

// Score-aware completion sound — call this from QuizzesPage instead of playSound('quiz_complete')
export function playQuizCompleteSound(score) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try { playQuizComplete(ctx, score); } catch {}
}
