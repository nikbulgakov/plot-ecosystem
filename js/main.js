/* Glue: UI, log, ticker, recorder, main loop. */
(function () {
  const $ = id => document.getElementById(id);
  const gate = $('gate'), log = $('log'), ticker = $('ticker');
  const wave = $('wave'), wctx = wave.getContext('2d');
  const av = $('avatar'), actx = av.getContext('2d');
  const bars = document.querySelectorAll('#player .bars i');
  let running = false, recStart = 0, recTimer = null;

  function addEvent(ev) {
    const t = Sim.clockText();
    const el = document.createElement('div');
    el.className = 'ev' + (ev.kind === 'hot' ? ' hot' : ev.kind === 'alarm' ? ' alarm' : '');
    el.innerHTML = `<span class="t">${t}</span><span class="m"></span>`;
    el.querySelector('.m').textContent = ev.text;
    log.prepend(el);
    while (log.children.length > 80) log.lastChild.remove();
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
    World.onFollow = c => { if (c) addEvent({ text: 'camera follows the ' + Sim.agents.find(a => a.mesh === c).species, kind: 'normal' }); };
    addEvent({ text: 'the plot wakes up. after rain, ' + Math.round(Sim.state.temp) + '°C', kind: 'hot' });
    loop();
    connectSky();
  }
  gate.addEventListener('click', start);

  /* ----- real sky ----- */
  function setPlaceLabel(name, live) {
    const el = $('ui-place');
    el.textContent = name;
    if (live) { const d = document.createElement('i'); d.className = 'live'; el.appendChild(d); }
  }
  function connectSky() {
    setPlaceLabel('looking up…', false);
    Weather.start({
      onPlace: p => setPlaceLabel(p.name, false),
      onData: d => { Sim.applyLive(d); setPlaceLabel(d.place.name, true); },
      onError: (e, stage) => {
        if (stage === 'weather') { addEvent({ text: 'no sky data. the plot dreams its own weather', kind: 'alarm' }); setPlaceLabel('simulated', false); }
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
