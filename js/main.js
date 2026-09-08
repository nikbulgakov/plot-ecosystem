/* Glue: UI, log, ticker, recorder, main loop. */
(function () {
  const $ = id => document.getElementById(id);
  const gate = $('gate'), log = $('log'), ticker = $('ticker');
  const wave = $('wave'), wctx = wave.getContext('2d');
  const av = $('avatar'), actx = av.getContext('2d');
  const bars = document.querySelectorAll('#player .bars i');
  let running = false, recStart = 0, recTimer = null;

  function renderEvent(t, text, kind) {
    const el = document.createElement('div');
    el.className = 'ev' + (kind === 'hot' ? ' hot' : kind === 'alarm' ? ' alarm' : '');
    el.innerHTML = `<span class="t"></span><span class="m"></span>`;
    el.querySelector('.t').textContent = t;
    el.querySelector('.m').textContent = text;
    log.prepend(el);
    while (log.children.length > 80) log.lastChild.remove();
  }
  function addEvent(ev) {
    const t = ev.t != null ? ev.t : Sim.clockText();
    renderEvent(t, ev.text, ev.kind);
    if (window.Life && Life.state()) Life.pushLog({ t, text: ev.text, kind: ev.kind || 'normal' });
    const line = ev.text.toUpperCase() + '  ·  ' + t + '  ·  ';
    ticker.textContent = line + line; // doubled so the -50% scroll loops seamlessly
    ticker.style.animationDuration = Math.max(8, line.length * 0.22) + 's';
  }

  function updatePanel() {
    const s = Sim.state;
    $('ui-time').textContent = Sim.clockText();
    $('ui-weather').textContent = s.weather;
    $('ui-temp').textContent = Math.round(s.temp) + '°C';
    $('ui-wind').textContent = s.live && Weather.last() ? Math.round(Weather.last().windKmh) + ' km/h' : Math.round(s.wind * 40) + ' km/h';
    if (Life.state()) {
      const p = Life.population();
      $('ui-age').textContent = 'day ' + (Math.floor(Life.age()) + 1);
      $('ui-pop').textContent = p.count + ' · ' + p.species + ' species';
    }
    const act = Math.round(s.activity * 100);
    $('ui-act').style.width = act + '%'; $('ui-act-n').textContent = act + '%';
    $('ui-ten').style.width = Math.round(s.tension * 100) + '%'; $('ui-ten-n').textContent = s.tension.toFixed(2);
  }

  function drawWave() {
    const w = AudioEngine.waveform();
    const W = wave.width, H = wave.height;
    wctx.clearRect(0, 0, W, H);
    wctx.fillStyle = '#c9e59a';
    const n = 56, step = Math.floor(w ? w.length / n : 1);
    for (let i = 0; i < n; i++) {
      let amp = 0.08;
      if (w) { let m = 0; for (let j = 0; j < step; j++) m = Math.max(m, Math.abs(w[i * step + j] - 128) / 128); amp = Math.max(0.06, Math.min(1, m * 2.2)); }
      const h = amp * H * 0.9, x = i * (W / n);
      wctx.fillRect(x, (H - h) / 2, W / n * 0.5, h);
    }
    const lvl = AudioEngine.level();
    bars.forEach((b, i) => { b.style.height = Math.max(2, Math.min(12, lvl * 60 * (0.6 + i * 0.25) + Math.sin(performance.now() / 150 + i) * 1.5)) + 'px'; });
  }

  function drawAvatar(t) {
    // a tiny green plot with a wandering red dot
    actx.fillStyle = '#1e2e12'; actx.fillRect(0, 0, 26, 26);
    actx.fillStyle = '#3f6a22'; actx.beginPath(); actx.arc(13, 13, 10, 0, 6.28); actx.fill();
    actx.fillStyle = '#6b9a3a';
    for (let i = 0; i < 8; i++) { const a = i * 0.8 + t * 0.2, r = 4 + (i % 3) * 2; actx.fillRect(13 + Math.cos(a) * r, 13 + Math.sin(a) * r, 1.5, 1.5); }
    actx.fillStyle = '#ff3f5f'; actx.beginPath(); actx.arc(13 + Math.cos(t * 0.9) * 5, 13 + Math.sin(t * 0.7) * 5, 1.6, 0, 6.28); actx.fill();
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
    Sim.init(World, AudioEngine, addEvent);
    Life.init({ sim: Sim, world: World, emit: addEvent });
    World.onFollow = c => { if (c) { const a = Sim.agents.find(x => x.mesh === c); addEvent({ text: 'camera follows ' + (a.meta.name ? a.meta.name + ' the ' : 'the ') + a.species, kind: 'normal' }); } };
    if (new URLSearchParams(location.search).get('reset') === '1') Life.reset();
    const saved = Life.load();
    if (saved) {
      for (const e of saved.log) renderEvent(e.t, e.text, e.kind);
      Life.spawnAll();
      World.setFlowerDensity(saved.flowers, true);
      addEvent({ text: `the plot wakes up. day ${Math.floor(Life.age()) + 1}, ${Life.population().count} creatures`, kind: 'hot' });
    } else {
      Life.seed(); Life.spawnAll(); World.setFlowerDensity(0.8, true);
      addEvent({ text: 'a new plot. no one has walked here before', kind: 'hot' });
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
      showAway(bits.join(', '), shown.length ? shown : [{ day: r.steps, text: 'nothing worth telling. the plot endured', kind: 'normal' }]);
    } else if (gapDays * 1440 >= 10) addEvent({ text: 'welcome back. the plot barely noticed', kind: 'normal' });
    Life.save();
  }
  // pinned block at the top of the log so the news isn't buried by the day's chatter
  function showAway(summary, events) {
    const box = $('away'), list = $('away-list');
    $('away-title').textContent = 'while you were away · ' + summary;
    list.innerHTML = '';
    for (const e of events) {
      const el = document.createElement('div');
      el.className = 'ev' + (e.kind === 'hot' ? ' hot' : e.kind === 'alarm' ? ' alarm' : '');
      el.innerHTML = '<span class="t"></span><span class="m"></span>';
      el.querySelector('.t').textContent = 'd+' + e.day; el.querySelector('.m').textContent = e.text;
      list.appendChild(el);
    }
    box.hidden = false;
  }
  $('away-x').addEventListener('click', () => { $('away').hidden = true; });

  /* ----- real sky ----- */
  function setPlaceLabel(name, live) {
    const el = $('ui-place');
    el.textContent = name;
    if (live) { const d = document.createElement('i'); d.className = 'live'; el.appendChild(d); }
  }
  function connectSky() {
    setPlaceLabel('looking up…', false);
    Weather.start({
      onPlace: p => { setPlaceLabel(p.name, false); catchUp(); },
      onData: d => { Sim.applyLive(d); setPlaceLabel(d.place.name, true); },
      onError: (e, stage) => {
        if (stage === 'weather') { addEvent({ text: 'no sky data. the plot dreams its own weather', kind: 'alarm' }); setPlaceLabel('simulated', false); catchUp(); }
        else if (stage === 'geocode') addEvent({ text: 'that place is not on any map here', kind: 'alarm' });
      },
    });
  }
  $('ui-place').addEventListener('click', async () => {
    const name = prompt('Move the plot to a place (city name):', Weather.place() ? Weather.place().name.split(',')[0] : '');
    if (!name || !name.trim()) return;
    setPlaceLabel('looking up…', false);
    try {
      const p = await Weather.setPlace(name.trim());
      addEvent({ text: 'the plot moves to ' + p.name.toLowerCase(), kind: 'hot' });
    } catch (e) {
      addEvent({ text: 'that place is not on any map here', kind: 'alarm' });
      setPlaceLabel(Weather.place() ? Weather.place().name : 'simulated', Sim.state.live);
    }
  });

  /* ----- controls ----- */
  $('vol-music').addEventListener('input', e => { AudioEngine.setMusicVolume(e.target.value / 100); $('vol-music-n').textContent = e.target.value + '%'; });
  $('vol-world').addEventListener('input', e => { AudioEngine.setWorldVolume(e.target.value / 100); $('vol-world-n').textContent = e.target.value + '%'; });
  $('mute').addEventListener('click', e => { const m = !AudioEngine.isMuted(); AudioEngine.setMuted(m); e.currentTarget.textContent = m ? '🔇' : '🔊'; });
  $('loopbtn').addEventListener('click', e => { const v = !World.getAutoOrbit(); World.setAutoOrbit(v); e.currentTarget.classList.toggle('off', !v); });
  document.querySelectorAll('.dot').forEach(d => d.addEventListener('click', () => {
    document.querySelectorAll('.dot').forEach(x => x.classList.remove('on')); d.classList.add('on');
    Sim.setMood(d.dataset.mood);
    addEvent({ text: { dusk: 'the plot tilts toward dusk', forest: 'the plot returns to the forest hour', night: 'the plot slips into night' }[d.dataset.mood], kind: 'hot' });
  }));
  let chrome = true;
  $('close').addEventListener('click', e => { chrome = !chrome; document.body.classList.toggle('nochrome', !chrome); e.currentTarget.textContent = chrome ? 'CLOSE' : 'OPEN'; });
  document.querySelectorAll('.panel h2 .chev').forEach(c => c.addEventListener('click', () => { const p = c.closest('.panel'); p.classList.toggle('collapsed'); c.textContent = p.classList.contains('collapsed') ? '›' : '⌄'; }));

  /* ----- recorder ----- */
  const rec = $('rec'), recbtn = $('recbtn'), dl = $('dl');
  recbtn.addEventListener('click', async () => {
    if (!running) return;
    if (!rec.classList.contains('recording')) {
      if (!AudioEngine.startRecording()) return;
      rec.classList.add('recording'); $('reclabel').textContent = 'stop'; dl.classList.remove('show');
      recStart = performance.now();
      recTimer = setInterval(() => { const s = Math.floor((performance.now() - recStart) / 1000); $('rectime').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }, 250);
      addEvent({ text: 'recording the plot', kind: 'alarm' });
    } else {
      clearInterval(recTimer);
      rec.classList.remove('recording'); $('reclabel').textContent = 'record';
      const blob = await AudioEngine.stopRecording();
      if (blob) { dl.href = URL.createObjectURL(blob); dl.classList.add('show'); addEvent({ text: 'recording saved. ' + Math.round(blob.size / 1024) + ' kb of weather', kind: 'hot' }); }
    }
  });
})();
