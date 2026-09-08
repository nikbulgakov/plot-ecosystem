/* Generative audio for the plot: a music layer and a world (foley) layer. */
(function () {
  const A = {};
  let ctx, master, musicBus, worldBus, analyser, recDest, recorder, chunks = [];
  let started = false;
  let rainGain, streamGain, windGain, padGains = [], padOscs = [], padFilter;
  let scaleRoot = 220; // A3
  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19];
  let moodChord = [0, 7, 12, 16]; // intervals in semitones
  let muted = false;

  function st(semi) { return scaleRoot * Math.pow(2, semi / 12); }
  function noiseBuffer(seconds, color) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else if (color === 'pink') { last = 0.98 * last + 0.02 * w; d[i] = (w * 0.3 + last * 2.5); }
      else d[i] = w;
    }
    return buf;
  }
  function loopNoise(color, filterType, freq, q, dest) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(4, color); src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(dest); src.start();
    return { src, f, g };
  }

  A.init = function () {
    if (started) return;
    started = true;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4; comp.knee.value = 12;
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.7;
    recDest = ctx.createMediaStreamDestination();
    master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination); comp.connect(recDest);

    musicBus = ctx.createGain(); musicBus.gain.value = 0.7; musicBus.connect(master);
    worldBus = ctx.createGain(); worldBus.gain.value = 0.9; worldBus.connect(master);

    // reverb-ish: feedback delay for space
    const dl = ctx.createDelay(1.0); dl.delayTime.value = 0.31;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const dlf = ctx.createBiquadFilter(); dlf.type = 'lowpass'; dlf.frequency.value = 1800;
    const dlWet = ctx.createGain(); dlWet.gain.value = 0.35;
    musicBus.connect(dl); dl.connect(dlf); dlf.connect(fb); fb.connect(dl); dlf.connect(dlWet); dlWet.connect(master);
    A._delaySend = dl;

    // ambient beds
    const rain = loopNoise('white', 'bandpass', 2600, 0.6, worldBus); rainGain = rain.g;
    const stream = loopNoise('brown', 'lowpass', 900, 0.8, worldBus); streamGain = stream.g;
    const wind = loopNoise('pink', 'lowpass', 400, 0.5, worldBus); windGain = wind.g;
    // slow LFOs on stream / wind for movement
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain(); lfoG.gain.value = 350; lfo.connect(lfoG); lfoG.connect(stream.f.frequency); lfo.start();
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.07;
    const lfo2G = ctx.createGain(); lfo2G.gain.value = 220; lfo2.connect(lfo2G); lfo2G.connect(wind.f.frequency); lfo2.start();

    // pads
    padFilter = ctx.createBiquadFilter(); padFilter.type = 'lowpass'; padFilter.frequency.value = 900; padFilter.Q.value = 0.7;
    padFilter.connect(musicBus);
    for (let i = 0; i < 4; i++) {
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      o1.type = 'triangle'; o2.type = 'sine'; o2.detune.value = 7 + i * 3;
      const g = ctx.createGain(); g.gain.value = 0;
      o1.connect(g); o2.connect(g); g.connect(padFilter); o1.start(); o2.start();
      padOscs.push([o1, o2]); padGains.push(g);
    }
    A.setChord(moodChord, 3);
  };

  A.resume = function () { if (ctx && ctx.state !== 'running') ctx.resume(); };
  A.time = () => ctx ? ctx.currentTime : 0;

  A.setChord = function (intervals, glide) {
    if (!ctx) return;
    moodChord = intervals;
    const t = ctx.currentTime;
    intervals.forEach((semi, i) => {
      const [o1, o2] = padOscs[i];
      const f = st(semi - 12);
      o1.frequency.setTargetAtTime(f, t, glide || 1.5);
      o2.frequency.setTargetAtTime(f * 2.005, t, glide || 1.5);
      padGains[i].gain.setTargetAtTime(0.055 - i * 0.008, t, 2);
    });
  };

  // weather → beds
  A.setWeather = function (w) {
    if (!ctx) return;
    const t = ctx.currentTime, k = 4;
    const map = {
      clear:     { rain: 0,    stream: .09, wind: .02, cut: 1400, chord: [0, 4, 7, 11] },
      overcast:  { rain: 0,    stream: .10, wind: .05, cut: 900,  chord: [0, 3, 7, 10] },
      drizzle:   { rain: .05,  stream: .12, wind: .04, cut: 800,  chord: [0, 5, 7, 12] },
      rain:      { rain: .14,  stream: .16, wind: .07, cut: 650,  chord: [0, 3, 7, 14] },
      'after rain': { rain: .015, stream: .14, wind: .02, cut: 1100, chord: [0, 7, 12, 16] },
      fog:       { rain: 0,    stream: .07, wind: .015, cut: 500, chord: [0, 2, 7, 9] },
      wind:      { rain: 0,    stream: .08, wind: .16, cut: 1000, chord: [0, 5, 10, 12] },
      snow:      { rain: 0,    stream: .04, wind: .06, cut: 450,  chord: [0, 3, 7, 12] },
    };
    const m = map[w] || map.clear;
    rainGain.gain.setTargetAtTime(m.rain, t, k);
    streamGain.gain.setTargetAtTime(m.stream, t, k);
    windGain.gain.setTargetAtTime(m.wind, t, k);
    padFilter.frequency.setTargetAtTime(m.cut, t, k);
    A.setChord(m.chord, 4);
  };

  A.setMood = function (mood) {
    if (!ctx) return;
    scaleRoot = mood === 'night' ? 164.8 : mood === 'dusk' ? 196 : 220;
    A.setChord(moodChord, 3);
  };

  A.setMusicVolume = v => { if (musicBus) musicBus.gain.setTargetAtTime(0.7 * v, ctx.currentTime, 0.05); };
  A.setWorldVolume = v => { if (worldBus) worldBus.gain.setTargetAtTime(0.9 * v, ctx.currentTime, 0.05); };
  A.setMuted = m => { muted = m; if (master) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.05); };
  A.isMuted = () => muted;

  /* ---------- one-shot world sounds ---------- */
  function env(g, t, a, d, peak) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function panner(x) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, x)); return p; }

  const SFX = {
    drip(p) { // sine ping with pitch drop
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), pn = panner(p.pan);
      const f = 1800 + Math.random() * 1600;
      o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.09);
      env(g, t, 0.004, 0.16, 0.18 * (p.dist || 1));
      o.connect(g); g.connect(pn); pn.connect(worldBus); o.start(t); o.stop(t + 0.3);
    },
    trickle(p) {
      const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = noiseBuffer(1.2, 'white');
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6;
      f.frequency.setValueAtTime(3200, t); f.frequency.linearRampToValueAtTime(1900, t + 1);
      const g = ctx.createGain(); env(g, t, 0.3, 0.8, 0.05); const pn = panner(p.pan);
      s.connect(f); f.connect(g); g.connect(pn); pn.connect(worldBus); s.start(t);
    },
    croak(p) { // amplitude-modulated saw
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), am = ctx.createOscillator(), amg = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(95 + Math.random() * 20, t); o.frequency.linearRampToValueAtTime(70, t + 0.35);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
      am.frequency.value = 28; amg.gain.value = 0.5; am.connect(amg); amg.connect(g.gain);
      env(g, t, 0.03, 0.4, 0.22); const pn = panner(p.pan);
      o.connect(lp); lp.connect(g); g.connect(pn); pn.connect(worldBus); o.start(t); am.start(t); o.stop(t + 0.5); am.stop(t + 0.5);
      if (p.repeat) setTimeout(() => SFX.croak({ pan: p.pan }), 420 + Math.random() * 120);
    },
    scrape(p) {
      const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.5, 'pink');
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 3; f.frequency.setValueAtTime(700, t); f.frequency.linearRampToValueAtTime(1500, t + 0.25);
      const g = ctx.createGain(); env(g, t, 0.02, 0.28, 0.12); const pn = panner(p.pan);
      s.connect(f); f.connect(g); g.connect(pn); pn.connect(worldBus); s.start(t);
    },
    acorn(p) { // knock + bounces
      const pn = panner(p.pan); pn.connect(worldBus);
      let delay = 0, vol = 0.25;
      for (let i = 0; i < 4; i++) {
        const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(420 - i * 40, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.06);
        env(g, t, 0.002, 0.07, vol); o.connect(g); g.connect(pn); o.start(t); o.stop(t + 0.1);
        delay += 0.12 + i * 0.07; vol *= 0.55;
      }
    },
    chirp(p) { // FM sweep bird
      const t = ctx.currentTime, pn = panner(p.pan); pn.connect(worldBus);
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain(), t0 = t + i * 0.13;
        const f = 2600 + Math.random() * 1200;
        o.frequency.setValueAtTime(f, t0); o.frequency.exponentialRampToValueAtTime(f * 1.5, t0 + 0.05); o.frequency.exponentialRampToValueAtTime(f * 0.9, t0 + 0.1);
        env(g, t0, 0.01, 0.1, 0.07); o.connect(g); g.connect(pn); o.start(t0); o.stop(t0 + 0.15);
      }
    },
    step(p) {
      const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.2, 'brown');
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
      const g = ctx.createGain(); env(g, t, 0.005, 0.08, 0.2); const pn = panner(p.pan);
      s.connect(f); f.connect(g); g.connect(pn); pn.connect(worldBus); s.start(t);
    },
    rustle(p) {
      const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.6, 'white');
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3000;
      const g = ctx.createGain(); env(g, t, 0.05, 0.4, 0.05); const pn = panner(p.pan);
      s.connect(f); f.connect(g); g.connect(pn); pn.connect(worldBus); s.start(t);
    },
    flutter(p) { // moth / wing beats
      const t = ctx.currentTime, pn = panner(p.pan); pn.connect(worldBus);
      for (let i = 0; i < 6; i++) {
        const s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.05, 'pink');
        const g = ctx.createGain(); const t0 = t + i * 0.045; env(g, t0, 0.005, 0.03, 0.06);
        s.connect(g); g.connect(pn); s.start(t0);
      }
    },
    thunder(p) {
      const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = noiseBuffer(3, 'brown');
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(120, t); f.frequency.linearRampToValueAtTime(60, t + 2.5);
      const g = ctx.createGain(); env(g, t, 0.15, 2.6, 0.5);
      s.connect(f); f.connect(g); g.connect(worldBus); s.start(t);
    },
  };

  A.sfx = function (name, p) {
    if (!ctx || muted) return;
    const fn = SFX[name]; if (fn) fn(p || {});
  };

  // music: plucked pentatonic note tied to an event
  A.pluck = function (opts) {
    if (!ctx) return;
    const o = opts || {};
    const t = ctx.currentTime;
    const deg = o.degree != null ? o.degree : Math.floor(Math.random() * PENTA.length);
    const f = st(PENTA[deg % PENTA.length] + (o.octave || 0) * 12);
    const osc = ctx.createOscillator(); osc.type = o.wave || 'triangle'; osc.frequency.value = f;
    const osc2 = ctx.createOscillator(); osc2.type = 'sine'; osc2.frequency.value = f * 2;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(3200, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.8);
    const g = ctx.createGain(); env(g, t, 0.006, o.len || 1.2, (o.vol || 0.12));
    const pn = panner(o.pan || 0);
    osc.connect(lp); osc2.connect(lp); lp.connect(g); g.connect(pn); pn.connect(musicBus);
    osc.start(t); osc2.start(t); osc.stop(t + 2); osc2.stop(t + 2);
  };

  /* ---------- analysis + recording ---------- */
  const wave = new Uint8Array(512);
  A.waveform = function () { if (!analyser) return null; analyser.getByteTimeDomainData(wave); return wave; };
  A.level = function () {
    const w = A.waveform(); if (!w) return 0;
    let s = 0; for (let i = 0; i < w.length; i += 8) { const v = (w[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / (w.length / 8));
  };

  A.startRecording = function () {
    if (!ctx) return false;
    chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    recorder = new MediaRecorder(recDest.stream, { mimeType: mime });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start(250);
    return true;
  };
  A.stopRecording = function () {
    return new Promise(res => {
      if (!recorder) return res(null);
      recorder.onstop = () => res(new Blob(chunks, { type: 'audio/webm' }));
      recorder.stop(); recorder = null;
    });
  };

  window.AudioEngine = A;
})();
