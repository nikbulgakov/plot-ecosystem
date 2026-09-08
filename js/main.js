/* Glue: UI, log, island ticker, recorder, main loop. */
(function () {
  const $ = id => document.getElementById(id);
  const gate = $('gate'), log = $('log'), ticker = $('ticker'), tickerSub = $('ticker-sub');
  const wave = $('wave'), wctx = wave.getContext('2d');
  const av = $('avatar'), actx = av.getContext('2d');
  const bars = document.querySelectorAll('#player .bars i');
  let running = false, recStart = 0, recTimer = null;

  /* ----- block meters ----- */
  const BLOCKS = 24;
  function makeBlocks(el) { el.innerHTML = ''; for (let i = 0; i < BLOCKS; i++) el.appendChild(document.createElement('i')); return el.children; }
  const actBlocks = makeBlocks($('ui-act')), tenBlocks = makeBlocks($('ui-ten'));
  function fillBlocks(blocks, frac) {
    const n = Math.round(Math.max(0, Math.min(1, frac)) * BLOCKS);
    for (let i = 0; i < BLOCKS; i++) blocks[i].classList.toggle('on', i < n);
  }

  /* ----- log ----- */
  function renderEvent(t, text, kind) {
    const el = document.createElement('div');
    el.className = 'ev' + (kind === 'hot' ? ' hot' : kind === 'alarm' ? ' alarm' : '');
    el.innerHTML = `<span class="t"></span><span class="d"></span><span class="m"></span>`;
    el.querySelector('.t').textContent = t;
    el.querySelector('.m').textContent = text;
    log.prepend(el);
    while (log.children.length > 80) log.lastChild.remove();
    $('log-count').textContent = log.children.length;
  }
  function addEvent(ev) {
    const t = ev.t != null ? ev.t : Sim.clockText();
    renderEvent(t, ev.text, ev.kind);
    if (window.Life && Life.state()) Life.pushLog({ t, text: ev.text, kind: ev.kind || 'normal' });
    const line = ev.text.charAt(0).toUpperCase() + ev.text.slice(1) + '      ';
    ticker.textContent = line + line; // doubled so the -50% scroll loops seamlessly
    ticker.style.animationDuration = Math.max(8, line.length * 0.22) + 's';
    tickerSub.textContent = 'Now happening · ' + t;
  }

  function updatePanel() {
    const s = Sim.state;
    $('ui-time').textContent = Sim.clockText();
    $('ui-weather').textContent = s.weather;
    $('ui-temp').textContent = Math.round(s.temp) + '°C';
    $('ui-wind').textContent = s.live && Weather.last() ? Math.round(Weather.last().windKmh) + ' km/h' : Math.round(s.wind * 40) + ' km/h';
    if (Life.state()) {
      const p = Life.population();
      $('ui-age').textContent = 'Day ' + (Math.floor(Life.age()) + 1);
      $('ui-pop').innerHTML = `<span class="mono">${p.count}</span> <small>· ${p.species} species</small>`;
    }
    fillBlocks(actBlocks, s.activity); $('ui-act-n').textContent = Math.round(s.activity * 100) + '%';
    fillBlocks(tenBlocks, s.tension); $('ui-ten-n').textContent = s.tension.toFixed(2);
    $('sky-mode').textContent = s.live ? 'live sky' : 'simulated sky';
  }

  function drawWave() {
    const w = AudioEngine.waveform();
    const W = wave.width, H = wave.height;
    wctx.clearRect(0, 0, W, H);
    wctx.fillStyle = 'rgba(245,245,247,.55)';
    const cell = 5, gap = 2, n = Math.floor(W / (cell + gap)), step = Math.floor(w ? w.length / n : 1);
    for (let i = 0; i < n; i++) {
      let amp = 0.12;
      if (w) { let m = 0; for (let j = 0; j < step; j++) m = Math.max(m, Math.abs(w[i * step + j] - 128) / 128); amp = Math.max(0.1, Math.min(1, m * 2.2)); }
      const h = Math.max(4, Math.round(amp * H / 4) * 4), x = i * (cell + gap);
      wctx.fillRect(x, (H - h) / 2, cell, h);
    }
    const lvl = AudioEngine.level();
    bars.forEach((b, i) => { b.style.height = Math.max(3, Math.min(14, lvl * 70 * (0.6 + i * 0.25) + Math.sin(performance.now() / 150 + i) * 1.5)) + 'px'; });
  }

  // 8×8 pixel thumbnail of the plot: grass, a stone, a wandering red dot
  function drawAvatar(t) {
    actx.fillStyle = '#142012'; actx.fillRect(0, 0, 8, 8);
    actx.fillStyle = '#2f5a26'; actx.fillRect(1, 2, 6, 4);
    actx.fillStyle = '#4a8a34'; actx.fillRect(2, 3, 4, 2); actx.fillRect(3, 2, 2, 1); actx.fillRect(3, 5, 2, 1);
    actx.fillStyle = '#9a7a72'; actx.fillRect(4, 4, 2, 1);
    actx.fillStyle = '#ffe08a'; actx.fillRect(5, 3, 1, 1);
    actx.fillStyle = '#ff5a3c'; actx.fillRect(2 + Math.round(Math.cos(t * 0.9) * 1.5 + 1.5), 2 + Math.round(Math.sin(t * 0.7) * 1.5 + 1.5), 1, 1);
  }

  function loop() {
    const dt = World.update();
    Sim.tick(dt);
    Life.tick(dt, Sim.state);
    const s = Sim.state;
    World.setAtmosphere({ hour: s.hour, mood: s.mood, rainAmount: s.rainAmount, wind: s.wind, day: Sim.daylight(), dusk: Sim.twilight(), snow: s.weather === 'snow' });
    updatePanel();
    drawWave();
    drawAvatar(performance.now() / 1000);
    requestAnimationFrame(loop);
  }

  function start() {
    if (running) return; running = true;
    gate.classList.add('hide');
    AudioEngine.init(); AudioEngine.resume();
    AudioEngine.setMusicVolume($('vol-music').value / 100);
    AudioEngine.setWorldVolume($('vol-world').value / 100);
    World.init($('scene'));
    applyLook(); syncLookUI();
    Sim.init(World, AudioEngine, addEvent);
    Life.init({ sim: Sim, world: World, emit: addEvent });
    World.onFollow = c => { if (c) { const a = Sim.agents.find(x => x.mesh === c); addEvent({ text: 'camera follows ' + (a.meta.name ? a.meta.name + ' the ' : 'the ') + a.species, kind: 'normal' }); } };
    if (new URLSearchParams(location.search).get('reset') === '1') Life.reset();
    const saved = Life.load();
    if (saved) {
      for (const e of saved.log) renderEvent(e.t, e.text, e.kind);
      Life.spawnAll();
      World.setFlowerDensity(saved.flowers, true);
      addEvent({ text: `the verge wakes up. day ${Math.floor(Life.age()) + 1}, ${Life.population().count} creatures`, kind: 'hot' });
    } else {
      Life.seed(); Life.spawnAll(); World.setFlowerDensity(0.8, true);
      addEvent({ text: 'a new verge. no one has walked here before', kind: 'hot' });
    }
    loop();
    connectSky();
    document.addEventListener('visibilitychange', () => { if (document.hidden) Life.save(); });
    window.addEventListener('pagehide', () => Life.save());
  }
  gate.addEventListener('click', start);

  /* ----- what happened while you were away ----- */
  let caughtUp = false;
  async function catchUp() {
    if (caughtUp) return; caughtUp = true;
    const s = Life.state();
    const gapDays = (Date.now() - s.lastSeen) / 86400000;
    let history = null, off = 0;
    if (gapDays > 0.2) { try { const h = await Weather.history(Math.min(92, Math.ceil(gapDays) + 1)); history = h.days; off = h.utcOffset; } catch (e) {} }
    const r = Life.catchUp({ history, utcOffset: off });
    Life.spawnAll();
    World.setFlowerDensity(s.flowers);
    if (r.steps > 0 || r.events.length) {
      const shown = r.events.slice(-14);
      if (r.events.length > shown.length) addEvent({ text: `…and ${r.events.length - shown.length} smaller things before that`, kind: 'normal', t: '' });
      for (const e of shown) addEvent({ text: e.text, kind: e.kind, t: 'd+' + e.day });
      const d = r.daysAway, bits = [d >= 1 ? `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(d * 24))} hours`];
      if (r.rainHours > 0.5) bits.push(`${Math.round(r.rainHours)}h of rain`);
      if (r.coldest != null) bits.push(`coldest ${Math.round(r.coldest)}°C`);
      if (r.snowDays) bits.push(`${r.snowDays} snow day${r.snowDays > 1 ? 's' : ''}`);
      if (r.births) bits.push(`${r.births} born`);
      if (r.deaths) bits.push(`${r.deaths} died`);
      if (r.arrivals) bits.push(`${r.arrivals} arrived`);
      addEvent({ text: 'while you were away: ' + bits.join(', '), kind: 'hot', t: 'away' });
      showAway(bits.join(' · '), shown.length ? shown : [{ day: r.steps, text: 'nothing worth telling. the verge endured', kind: 'normal' }]);
    } else if (gapDays * 1440 >= 10) addEvent({ text: 'welcome back. the verge barely noticed', kind: 'normal' });
    Life.save();
  }
  // pinned notification card at the top of the log so the news isn't buried by the day's chatter
  function showAway(summary, events) {
    const box = $('away'), list = $('away-list');
    $('away-title').textContent = summary;
    list.innerHTML = '';
    for (const e of events) {
      const el = document.createElement('div');
      el.className = 'arow' + (e.kind === 'hot' ? ' hot' : e.kind === 'alarm' ? ' alarm' : '');
      el.innerHTML = '<span class="chip"></span><span class="m"></span>';
      el.querySelector('.chip').textContent = 'D+' + e.day;
      el.querySelector('.m').textContent = e.text.charAt(0).toUpperCase() + e.text.slice(1);
      list.appendChild(el);
    }
    box.hidden = false;
  }
  $('away-x').addEventListener('click', () => { $('away').hidden = true; });

  /* ----- real sky ----- */
  function setPlaceLabel(name, live) {
    const el = $('ui-place');
    el.textContent = name;
    if (live) { const d = document.createElement('i'); d.className = 'live'; d.style.display = 'inline-block'; d.style.marginLeft = '7px'; d.style.verticalAlign = 'middle'; el.appendChild(d); }
  }
  function connectSky() {
    setPlaceLabel('looking up…', false);
    Weather.start({
      onPlace: p => { setPlaceLabel(p.name, false); catchUp(); },
      onData: d => { Sim.applyLive(d); setPlaceLabel(d.place.name, true); },
      onError: (e, stage) => {
        if (stage === 'weather') { addEvent({ text: 'no sky data. the verge dreams its own weather', kind: 'alarm' }); setPlaceLabel('simulated', false); catchUp(); }
        else if (stage === 'geocode') addEvent({ text: 'that place is not on any map here', kind: 'alarm' });
      },
    });
  }
  $('ui-place').addEventListener('click', async () => {
    const name = prompt('Move the verge to a place (city name):', Weather.place() ? Weather.place().name.split(',')[0] : '');
    if (!name || !name.trim()) return;
    setPlaceLabel('looking up…', false);
    try {
      const p = await Weather.setPlace(name.trim());
      addEvent({ text: 'the verge moves to ' + p.name.toLowerCase(), kind: 'hot' });
    } catch (e) {
      addEvent({ text: 'that place is not on any map here', kind: 'alarm' });
      setPlaceLabel(Weather.place() ? Weather.place().name : 'simulated', Sim.state.live);
    }
  });

  /* ----- controls ----- */
  function setSlider(el, v, label, text) { el.value = v; $(label).textContent = text; el.style.setProperty('--p', ((v - el.min) / (el.max - el.min) * 100) + '%'); }
  function slider(id, label, setter, fmt) {
    const el = $(id);
    el.addEventListener('input', e => { const v = +e.target.value; setter(v); setSlider(el, v, label, fmt ? fmt(v) : v + '%'); });
  }
  slider('vol-music', 'vol-music-n', v => AudioEngine.setMusicVolume(v / 100));
  slider('vol-world', 'vol-world-n', v => AudioEngine.setWorldVolume(v / 100));

  /* ----- look: pixel size, dither, bloom, grass palette (kept in this browser) ----- */
  const LOOK_KEY = 'plot.look';
  const look = Object.assign({ pixel: 0, dither: 75, bloom: 35, palette: 'meadow' }, (() => { try { return JSON.parse(localStorage.getItem(LOOK_KEY)) || {}; } catch (e) { return {}; } })());
  function saveLook() { try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch (e) {} }
  function applyLook() {
    World.setPixelLook({ dither: look.dither / 100, bloom: look.bloom / 100 * 0.8, pixel: look.pixel || undefined, palette: look.palette });
    document.querySelectorAll('#lk-palette [data-palette]').forEach(b => b.classList.toggle('on', b.dataset.palette === look.palette));
  }
  function syncLookUI() {
    if (!look.pixel) look.pixel = World.getPixelLook().pixel;
    setSlider($('lk-pixel'), look.pixel, 'lk-pixel-n', look.pixel + ' px');
    setSlider($('lk-dither'), look.dither, 'lk-dither-n', look.dither + '%');
    setSlider($('lk-bloom'), look.bloom, 'lk-bloom-n', look.bloom + '%');
  }
  slider('lk-pixel', 'lk-pixel-n', v => { look.pixel = v; applyLook(); saveLook(); }, v => v + ' px');
  slider('lk-dither', 'lk-dither-n', v => { look.dither = v; applyLook(); saveLook(); });
  slider('lk-bloom', 'lk-bloom-n', v => { look.bloom = v; applyLook(); saveLook(); });
  document.querySelectorAll('#lk-palette [data-palette]').forEach(b => b.addEventListener('click', () => { look.palette = b.dataset.palette; applyLook(); saveLook(); }));
  $('mute').addEventListener('click', e => { const m = !AudioEngine.isMuted(); AudioEngine.setMuted(m); e.currentTarget.classList.toggle('off', m); });
  $('loopbtn').addEventListener('click', e => { const v = !World.getAutoOrbit(); World.setAutoOrbit(v); e.currentTarget.classList.toggle('off', !v); });
  document.querySelectorAll('.seg [data-mood]').forEach(d => d.addEventListener('click', () => {
    document.querySelectorAll('.seg [data-mood]').forEach(x => x.classList.remove('on')); d.classList.add('on');
    Sim.setMood(d.dataset.mood);
    addEvent({ text: { dusk: 'the verge tilts toward dusk', forest: 'the verge returns to the forest hour', night: 'the verge slips into night' }[d.dataset.mood], kind: 'hot' });
  }));
  $('hide').addEventListener('click', () => document.body.classList.add('nochrome'));
  $('close').addEventListener('click', () => document.body.classList.remove('nochrome'));
  document.querySelectorAll('.panel h2 .chev').forEach(c => c.addEventListener('click', () => c.closest('.panel').classList.toggle('collapsed')));

  /* ----- recorder ----- */
  const rec = $('rec'), recbtn = $('recbtn'), dl = $('dl');
  recbtn.addEventListener('click', async () => {
    if (!running) return;
    if (!rec.classList.contains('recording')) {
      if (!AudioEngine.startRecording()) return;
      rec.classList.add('recording'); $('reclabel').textContent = 'Stop'; dl.classList.remove('show');
      recStart = performance.now();
      recTimer = setInterval(() => { const s = Math.floor((performance.now() - recStart) / 1000); $('rectime').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }, 250);
      addEvent({ text: 'recording the verge', kind: 'alarm' });
    } else {
      clearInterval(recTimer);
      rec.classList.remove('recording'); $('reclabel').textContent = 'Record';
      const blob = await AudioEngine.stopRecording();
      if (blob) { dl.href = URL.createObjectURL(blob); dl.classList.add('show'); addEvent({ text: 'recording saved. ' + Math.round(blob.size / 1024) + ' kb of weather', kind: 'hot' }); }
    }
  });
})();
