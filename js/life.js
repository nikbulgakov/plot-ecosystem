/* Life: the plot remembers. Creatures age, are born, die and wander in; the world keeps living between visits. */
(function () {
  const L = {};
  const KEY = 'plot.world.v1';
  const DAY = 86400000;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let Sim, emit, World, state = null, saveTimer = null;

  // lifespan in days, population cap, daily birth chance, frost sensitivity, daily arrival chance when extinct
  const TABLE = {
    nuthatch: { lifespan: 300, cap: 2, birth: 0.012, frost: 0.2, migrate: 0.05, rainLove: 0, born: 'in a hole in the oak' },
    badger:   { lifespan: 900, cap: 1, birth: 0.004, frost: 0.05, migrate: 0.02, rainLove: 0, born: 'deep in the sett' },
    toad:     { lifespan: 400, cap: 3, birth: 0.02, frost: 0.3, migrate: 0.05, rainLove: 1.2, born: 'at the edge of the ravine' },
    vole:     { lifespan: 60,  cap: 4, birth: 0.07, frost: 0.4, migrate: 0.1, rainLove: 0, born: 'under the big rock' },
    beetle:   { lifespan: 25,  cap: 4, birth: 0.09, frost: 0.9, migrate: 0.15, rainLove: 0.3, born: 'in the leaf litter' },
    moth:     { lifespan: 12,  cap: 3, birth: 0.12, frost: 0.9, migrate: 0.15, rainLove: -0.5, born: 'on the underside of a leaf' },
    wren:     { lifespan: 200, cap: 2, birth: 0.012, frost: 0.3, migrate: 0.06, rainLove: 0, born: 'in the branch pile' },
    slug:     { lifespan: 40,  cap: 3, birth: 0.06, frost: 0.7, migrate: 0.1, rainLove: 1.5, born: 'in the wet shade of the fallen branch' },
  };
  const SEED = ['nuthatch', 'badger', 'toad', 'vole', 'vole', 'beetle', 'beetle', 'moth', 'moth', 'wren', 'slug'];
  // warmth of the season by month (northern hemisphere; flipped south of the equator)
  const WARM = [0.05, 0.05, 0.2, 0.6, 0.9, 1, 1, 0.9, 0.6, 0.3, 0.1, 0.05];
  const FLOWER_SEASON = [0.12, 0.12, 0.3, 0.7, 0.9, 1, 0.85, 0.7, 0.5, 0.3, 0.15, 0.1];
  const SYL = ['mo', 'ri', 'tu', 'ka', 'ne', 'so', 'il', 'ba', 'du', 'vi', 'ol', 'em', 'ash', 'ur', 'fen', 'lo', 'wick', 'ta', 'ni', 'osh'];
  function name() { let n = ''; const k = 2 + (Math.random() < 0.3 ? 1 : 0); for (let i = 0; i < k; i++) n += pick(SYL); return n[0].toUpperCase() + n.slice(1); }
  let nextId = 1;
  function record(species, extra) {
    const t = TABLE[species];
    return Object.assign({ id: 'c' + (nextId++) + Math.random().toString(36).slice(2, 6), species, name: name(), bornAt: Date.now(), ageDays: 0, lifespan: t.lifespan * rnd(0.75, 1.3) }, extra || {});
  }

  /* ---------- storage ---------- */
  L.load = function () {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (!s || s.v !== 1 || !Array.isArray(s.creatures)) return null;
      state = s; return s;
    } catch (e) { return null; }
  };
  L.seed = function () {
    state = { v: 1, born: Date.now(), lastSeen: Date.now(), visits: 1, creatures: SEED.map(sp => record(sp)), flowers: 0.8,
      stats: { births: 0, deaths: 0, arrivals: 0 }, log: [], today: null };
    return state;
  };
  L.save = function () {
    if (!state) return;
    for (const c of state.creatures) if (c.agent) { c.x = c.agent.pos.x; c.z = c.agent.pos.z; }
    state.lastSeen = Date.now();
    const plain = Object.assign({}, state, { creatures: state.creatures.map(c => { const o = Object.assign({}, c); delete o.agent; return o; }) });
    try { localStorage.setItem(KEY, JSON.stringify(plain)); } catch (e) {}
  };
  L.reset = function () { try { localStorage.removeItem(KEY); } catch (e) {} state = null; };
  L.state = () => state;
  L.pushLog = function (entry) { if (!state) return; state.log.push(entry); if (state.log.length > 40) state.log.splice(0, state.log.length - 40); };

  /* ---------- link to the simulation ---------- */
  L.init = function (o) { Sim = o.sim; World = o.world; emit = o.emit; };
  function spawn(c) {
    const a = Sim.spawn(c.species, c);
    if (a) { c.agent = a; a.meta = c; }
    return a;
  }
  L.spawnAll = function () { for (const c of state.creatures) if (!c.agent) spawn(c); };
  function kill(c, why) {
    const i = state.creatures.indexOf(c); if (i >= 0) state.creatures.splice(i, 1);
    if (c.agent) { Sim.remove(c.agent); c.agent = null; }
    state.stats.deaths++;
    const sp = c.species, n = c.name;
    return why === 'age' ? pick([`the old ${sp} ${n} died in its sleep`, `${n} the ${sp} grew still and did not wake. it was old`])
      : why === 'cold' ? pick([`the frost took the ${sp} ${n}`, `${n} the ${sp} did not survive the cold night`])
      : why === 'storm' ? `${n} the ${sp} did not come back after the storm`
      : `the ${sp} ${n} is gone. no one saw it leave`;
  }
  function birth(sp, live) {
    const parent = state.creatures.find(c => c.species === sp);
    const c = record(sp, parent && parent.agent ? { x: parent.agent.pos.x + rnd(-0.6, 0.6), z: parent.agent.pos.z + rnd(-0.6, 0.6) } : (parent && parent.x != null ? { x: parent.x + rnd(-0.6, 0.6), z: parent.z + rnd(-0.6, 0.6) } : {}));
    state.creatures.push(c); state.stats.births++;
    if (live) spawn(c);
    return `a ${sp} was born ${TABLE[sp].born}. it is called ${c.name}`;
  }
  function arrival(sp, live) {
    const c = record(sp, { ageDays: TABLE[sp].lifespan * rnd(0.1, 0.4) });
    state.creatures.push(c); state.stats.arrivals++;
    if (live) spawn(c);
    return pick([`a ${sp} wandered in from the ravine. it is called ${c.name}`, `a new ${sp} has taken up the empty ground. ${c.name}`, `${c.name}, a ${sp}, arrived from beyond the plot`]);
  }

  /* ---------- one day of life ---------- */
  // wx: {rainHours, minTemp, maxTemp, snowHours, stormHours} or null (unknown day → season only)
  function stepDay(date, wx, live, scale) {
    scale = scale == null ? 1 : scale;
    const events = [];
    const month = new Date(date).getMonth();
    const lat = (window.Weather && Weather.place() && Weather.place().lat) || 55;
    const warm = WARM[lat < 0 ? (month + 6) % 12 : month];
    const minT = wx ? wx.minTemp : (warm < 0.2 ? -3 : warm < 0.5 ? 4 : 10);
    const rainH = wx ? wx.rainHours : 2;
    const stormH = wx ? wx.stormHours : 0;
    const frostDay = minT < -2 ? 1 : minT < 1 ? 0.35 : 0;
    // deaths
    for (const c of state.creatures.slice()) {
      const t = TABLE[c.species];
      c.ageDays += scale;
      const rel = c.ageDays / c.lifespan;
      const pAge = rel > 1 ? 0.5 : rel > 0.8 ? 0.06 : 0.003;
      const pCold = frostDay * t.frost * 0.35;
      const pStorm = stormH > 0 && t.lifespan < 100 ? 0.04 : 0;
      const r = Math.random();
      if (r < pAge * scale) events.push({ text: kill(c, 'age'), kind: 'alarm' });
      else if (r < (pAge + pCold) * scale) events.push({ text: kill(c, 'cold'), kind: 'alarm' });
      else if (r < (pAge + pCold + pStorm) * scale) events.push({ text: kill(c, 'storm'), kind: 'alarm' });
    }
    // births and arrivals
    for (const sp in TABLE) {
      const t = TABLE[sp];
      const n = state.creatures.filter(c => c.species === sp).length;
      const rainFactor = 1 + t.rainLove * clamp(rainH / 8, 0, 1);
      if (n > 0 && n < t.cap) {
        const p = t.birth * (0.15 + warm) * rainFactor * (frostDay ? 0.2 : 1) * scale;
        if (Math.random() < p) events.push({ text: birth(sp, live), kind: 'hot' });
      } else if (n === 0) {
        if (Math.random() < t.migrate * (0.3 + warm) * scale) events.push({ text: arrival(sp, live), kind: 'hot' });
      }
    }
    // flowers
    const target = FLOWER_SEASON[lat < 0 ? (month + 6) % 12 : month];
    const before = state.flowers;
    state.flowers += ((target - state.flowers) * 0.08 + rainH * 0.004 - frostDay * 0.1 - (wx && wx.snowHours > 3 ? 0.15 : 0)) * scale;
    state.flowers = clamp(state.flowers, 0.04, 1);
    if (before - state.flowers > 0.12) events.push({ text: pick(['most of the flowers have gone over', 'the cold flattened the flower heads']), kind: 'normal' });
    if (state.flowers - before > 0.12) events.push({ text: pick(['the plot is coming into flower', 'new flower heads open all along the edge']), kind: 'normal' });
    return events;
  }

  /* ---------- catching up after an absence ---------- */
  function localDate(ts, off) { return new Date(ts + (off || 0) * 1000).toISOString().slice(0, 10); }
  L.catchUp = function (o) {
    // o: {history: {date → wx} | null, utcOffset}
    const now = Date.now(), off = o.utcOffset || 0;
    const gapMs = now - state.lastSeen;
    state.visits++;
    const out = { daysAway: gapMs / DAY, events: [], rainHours: 0, coldest: null, snowDays: 0, births: 0, deaths: 0, arrivals: 0, steps: 0 };
    if (gapMs < 10 * 60 * 1000) return out;
    const b0 = state.stats.births, d0 = state.stats.deaths, a0 = state.stats.arrivals;
    const from = localDate(state.lastSeen, off), to = localDate(now, off);
    const days = [];
    for (let t = state.lastSeen + DAY; localDate(t, off) < to; t += DAY) days.push(localDate(t, off));
    // a same-day return still ages everyone a little; a part day counts as a scaled step
    if (days.length === 0) {
      const scale = gapMs / DAY;
      if (from !== to && state.today && state.today.date === from) {
        // we left late yesterday: close that day with the sky we saw
        out.events.push(...stepDay(from, state.today, false, 1).map(e => Object.assign(e, { day: 1 }))); out.steps = 1;
      } else if (scale > 0.2) { out.events.push(...stepDay(to, o.history && o.history[to] || null, false, scale).map(e => Object.assign(e, { day: 0 }))); out.steps = 1; }
      else for (const c of state.creatures) c.ageDays += scale;
    } else {
      const capped = days.slice(-400);
      capped.forEach((date, i) => {
        const wx = o.history && o.history[date] || null;
        if (wx) { out.rainHours += wx.rainHours; out.coldest = out.coldest == null ? wx.minTemp : Math.min(out.coldest, wx.minTemp); if (wx.snowHours > 2) out.snowDays++; }
        out.events.push(...stepDay(date, wx, false, 1).map(e => Object.assign(e, { day: i + 1 })));
        out.steps++;
      });
      if (days.length > capped.length) for (const c of state.creatures) c.ageDays += 0; // beyond the cap the plot simply endured
    }
    out.births = state.stats.births - b0; out.deaths = state.stats.deaths - d0; out.arrivals = state.stats.arrivals - a0;
    if (state.today && state.today.date !== to) state.today = null; // that day is accounted for
    if (state.creatures.length === 0) out.events.push({ text: arrival(pick(['vole', 'beetle', 'wren']), false), kind: 'hot', day: out.steps });
    return out;
  };

  /* ---------- living time ---------- */
  let acc = 0;
  L.tick = function (dt, simState) {
    if (!state) return;
    acc += dt;
    if (acc < 30) return;
    const days = acc / 86400; acc = 0;
    for (const c of state.creatures) c.ageDays += days;
    // remember today's sky for the day step at midnight
    const off = simState.utcOffset || 0, date = localDate(Date.now(), off);
    if (!state.today || state.today.date !== date) {
      if (state.today && state.today.date) {
        const ev = stepDay(state.today.date, state.today, true, 1);
        for (const e of ev) emit(e);
        World.setFlowerDensity(state.flowers);
      }
      state.today = { date, rainHours: 0, minTemp: simState.temp, maxTemp: simState.temp, snowHours: 0, stormHours: 0 };
    }
    const t = state.today, h = 30 / 3600;
    if (simState.weather === 'snow') t.snowHours += h; else if (simState.rainAmount > 0.3) t.rainHours += h;
    if (simState.storm) t.stormHours += h;
    t.minTemp = Math.min(t.minTemp, simState.temp); t.maxTemp = Math.max(t.maxTemp, simState.temp);
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; L.save(); }, 1000);
  };
  L.population = function () {
    const by = {}; for (const c of state.creatures) by[c.species] = (by[c.species] || 0) + 1;
    return { count: state.creatures.length, species: Object.keys(by).length, by };
  };
  L.age = () => state ? (Date.now() - state.born) / DAY : 0;
  L.TABLE = TABLE;
  window.Life = L;
})();
