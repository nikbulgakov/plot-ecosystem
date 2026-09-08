/* Simulation: weather, clock, and agents with their own small rulebooks. */
(function () {
  const S = {};
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let W, A, emit;
  const agents = [];
  const st = { minutes: 14 * 60 + 55, hour: 14.9, weather: 'after rain', weatherT: 0, temp: 12, activity: 0, tension: 0, wind: 0.15, rainAmount: 0.12, mood: 'forest',
    live: false, place: null, sunrise: 6.2, sunset: 19.5, utcOffset: null, liveTemp: null, liveWind: null, storm: false, snowCover: 0 };

  /* ---------- season: by month at the place, flipped south of the equator ---------- */
  const DRY = [0.78, 0.72, 0.5, 0.2, 0.05, 0, 0, 0.05, 0.25, 0.55, 0.72, 0.78];
  const SEASON_NAMES = ['deep winter', 'late winter', 'early spring', 'spring', 'late spring', 'early summer', 'high summer', 'late summer', 'early autumn', 'autumn', 'late autumn', 'first frosts'];
  function seasonMonth() {
    const m = new Date(Date.now() + (st.utcOffset || 0) * 1000).getUTCMonth();
    const lat = (window.Weather && Weather.place() && Weather.place().lat != null) ? Weather.place().lat : 55;
    return lat < 0 ? (m + 6) % 12 : m;
  }
  S.season = function () {
    const m = seasonMonth();
    let dry = DRY[m];
    if (st.temp > 20) dry *= 0.6; else if (st.temp < 3) dry = Math.max(dry, 0.5); // a warm spell greens up, a cold one browns off
    return { month: m, dry, name: SEASON_NAMES[m] };
  };
  // the moon: phase from the synodic month, counted from the new moon of 2000-01-06
  const MOON_NAMES = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
  S.moon = function () {
    const p = (((Date.now() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000 / 29.530588853) % 1 + 1) % 1;
    return { phase: p, illum: (1 - Math.cos(2 * Math.PI * p)) / 2, name: MOON_NAMES[Math.round(p * 8) % 8] };
  };
  S.night = () => clamp(1 - S.daylight() - S.twilight() * 0.25, 0, 1);
  S.state = st;
  const timers = {};

  const OAK = { x: -2.1, z: -2.3 };
  const STREAM = { x: 9.5, z: 2.5 };
  const ROCKS = [[0.5, -0.4], [-1.6, 0.6], [1.9, 1.8], [-2.4, -3.1], [3.4, -0.6], [-0.4, 2.9]];
  const SETT = { x: -5.4, z: 2.6 };

  // day shape follows the real sunrise/sunset when live, defaults otherwise
  const isNight = () => st.hour < st.sunrise - 0.6 || st.hour > st.sunset + 1.2;
  const isDusk = () => st.hour > st.sunset - 1.2 && st.hour <= st.sunset + 1.2;
  const isDawn = () => st.hour >= st.sunrise - 0.6 && st.hour < st.sunrise + 1.6;
  const isWet = () => ['rain', 'drizzle', 'after rain'].includes(st.weather);
  const smooth = v => { v = clamp(v, 0, 1); return v * v * (3 - 2 * v); };
  S.daylight = () => smooth((st.hour - st.sunrise + 0.4) / 1.6) * smooth((st.sunset + 0.4 - st.hour) / 1.6);
  S.twilight = () => Math.exp(-Math.pow((st.hour - st.sunset) / 0.9, 2)) + Math.exp(-Math.pow((st.hour - st.sunrise) / 0.9, 2));
  const lightWord = () => isNight() ? 'the dark' : isDusk() ? 'the failing light' : isDawn() ? 'the grey early light' : st.weather === 'fog' ? 'the fog' : isWet() ? 'the wet light' : 'the afternoon light';

  /* ---------- helpers ---------- */
  function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
  function panOf(p) { return W.pan(p.x, p.z); }
  function say(agent, text, opts) {
    const o = opts || {};
    emit({ text, kind: o.kind || 'normal', agent });
    if (o.sfx) A.sfx(o.sfx, { pan: agent ? panOf(agent.pos) : (o.pan || 0), repeat: o.repeat, dist: o.dist });
    if (o.pluck !== false && Math.random() < (o.pluckP == null ? 0.55 : o.pluckP)) A.pluck({ degree: o.degree, octave: o.octave || 0, pan: agent ? panOf(agent.pos) * 0.6 : 0, vol: o.vol || 0.11 });
  }

  /* ---------- agent factory ---------- */
  function makeAgent(def) {
    const a = Object.assign({
      pos: { x: def.home.x + rnd(-1, 1), z: def.home.z + rnd(-1, 1) }, y: def.y || 0.25,
      state: 'rest', t: rnd(1, 4), target: null, speed: 0.6, vel: 0, mood: 0, lastAct: '', cooldown: {},
    }, def);
    a.mesh = W.addCreature({ sprite: def.sprite || def.species, size: def.size, trail: def.trail });
    a.meta = def.meta || {};
    agents.push(a);
    return a;
  }
  // life record → live agent (meta carries name, age, lifespan and the last known position)
  S.spawn = function (species, meta) {
    const d = SPECIES[species]; if (!d) return null;
    const def = Object.assign({ species }, d, { home: Object.assign({}, d.home), t: rnd(0.5, 5), meta });
    if (meta && meta.x != null && meta.z != null) def.pos = { x: meta.x, z: meta.z };
    return makeAgent(def);
  };
  S.remove = function (a) {
    const i = agents.indexOf(a); if (i >= 0) agents.splice(i, 1);
    W.removeCreature(a.mesh);
  };
  function moveTo(a, dt, tgt, speed) {
    const dx = tgt.x - a.pos.x, dz = tgt.z - a.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.08) { a.vel = 0; return true; }
    const s = Math.min(d, speed * dt);
    const [ux, uz] = FLIES[a.species] ? [dx / d, dz / d] : steer(a, dx / d, dz / d);
    a.pos.x += ux * s + Math.sin(st.hour * 40 + a.pos.z) * 0.002;
    a.pos.z += uz * s;
    a.vel = speed;
    const r = Math.hypot(a.pos.x, a.pos.z), maxR = W.R * 0.9;
    if (r > maxR) { a.pos.x *= maxR / r; a.pos.z *= maxR / r; }
    walkAround(a, s);
    return false;
  }

  /* ---------- collisions: nobody walks through a stone, a trunk or each other ---------- */
  const RADIUS = { badger: 0.62, toad: 0.45, vole: 0.36, beetle: 0.3, moth: 0.35, wren: 0.36, nuthatch: 0.35, slug: 0.32 };
  // a spot right beside a stone (the vole's favourite), outside its edge and reachable
  function besideStone(a) {
    const stones = W.obstacles.filter(o => !o.seg && !o.tree);
    for (let k = 0; k < 10; k++) {
      const o = pick(stones), ang = rnd(0, 6.28), d = o.r + (RADIUS[a.species] || 0.3) + 0.2;
      const p = { x: o.x + Math.cos(ang) * d, z: o.z + Math.sin(ang) * d };
      if (!blocked(a, p.x, p.z) && pathClear(a, a.pos, p)) return p;
    }
    return randomNear(a.home, a.home.r, a.species, a.pos);
  }
  // is the straight line from here to there free of stones for this creature?
  function pathClear(a, from, to) {
    const d = Math.hypot(to.x - from.x, to.z - from.z), n = Math.max(1, Math.ceil(d / 0.3));
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      if (blocked(a, from.x + (to.x - from.x) * k, from.z + (to.z - from.z) * k)) return false;
    }
    return true;
  }
  // how much room there is at a point: distance to the nearest obstacle edge (negative inside)
  function clearance(a, px, pz) {
    const r = RADIUS[a.species] || 0.3; let best = Infinity;
    for (const o of W.obstacles) {
      if (o.tree && a.species === 'nuthatch') continue;
      const [cx, cz] = nearestOn(o, px, pz);
      best = Math.min(best, Math.hypot(px - cx, pz - cz) - (o.r + r));
    }
    return best;
  }
  // a way out of a pocket between stones: the direction with a clear short path, or failing that the roomiest one
  function escapeTarget(a) {
    const r = RADIUS[a.species] || 0.3;
    let nx = 0, nz = 0;
    for (const o of W.obstacles) {
      if (o.tree && a.species === 'nuthatch') continue;
      const [cx, cz] = nearestOn(o, a.pos.x, a.pos.z);
      const dx = a.pos.x - cx, dz = a.pos.z - cz, d = Math.hypot(dx, dz);
      if (d < o.r + r + 0.9 && d > 1e-4) { nx += dx / d / d; nz += dz / d / d; }
    }
    const ang = (nx || nz) ? Math.atan2(nz, nx) : rnd(0, 6.28);
    const turns = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9, 2.5, -2.5, Math.PI];
    for (const turn of turns) {
      const p = { x: a.pos.x + Math.cos(ang + turn) * 1.4, z: a.pos.z + Math.sin(ang + turn) * 1.4 };
      if (Math.hypot(p.x, p.z) < W.R * 0.88 && !blocked(a, p.x, p.z) && pathClear(a, a.pos, p)) return p;
    }
    let bestP = null, bestC = -Infinity;
    for (const turn of turns) {
      const p = { x: a.pos.x + Math.cos(ang + turn) * 0.7, z: a.pos.z + Math.sin(ang + turn) * 0.7 };
      const c = clearance(a, p.x, p.z);
      if (c > bestC) { bestC = c; bestP = p; }
    }
    return bestP || { x: a.home.x, z: a.home.z };
  }
  // look a little ahead; if a stone is in the way, walk along its edge, keeping to one side until the way is clear
  function steer(a, dirx, dirz) {
    const r = RADIUS[a.species] || 0.3, look = r + 0.5;
    const px = a.pos.x + dirx * look, pz = a.pos.z + dirz * look;
    let best = null, bestD = Infinity;
    for (const o of W.obstacles) {
      if (o.tree && a.species === 'nuthatch') continue;
      const [cx, cz] = nearestOn(o, px, pz);
      const d = Math.hypot(px - cx, pz - cz) - (o.r + r);
      if (d < 0 && d < bestD) { bestD = d; best = nearestOn(o, a.pos.x, a.pos.z); }
    }
    if (!best) { a.side = 0; return [dirx, dirz]; }
    const nx = a.pos.x - best[0], nz = a.pos.z - best[1], nl = Math.hypot(nx, nz) || 1;
    const ux = nx / nl, uz = nz / nl, tx = -uz, tz = ux;
    if (!a.side) a.side = Math.sign(dirx * tx + dirz * tz) || 1;
    let sx = tx * a.side + ux * 0.4, sz = tz * a.side + uz * 0.4;
    const sl = Math.hypot(sx, sz) || 1;
    return [sx / sl, sz / sl];
  }
  const FLIES = { moth: true };
  function nearestOn(o, px, pz) { // closest point of an obstacle to (px, pz)
    if (!o.seg) return [o.x, o.z];
    const [x0, z0, x1, z1] = o.seg, vx = x1 - x0, vz = z1 - z0, L = vx * vx + vz * vz;
    const k = L > 0 ? clamp(((px - x0) * vx + (pz - z0) * vz) / L, 0, 1) : 0;
    return [x0 + vx * k, z0 + vz * k];
  }
  function blocked(a, px, pz) {
    const r = RADIUS[a.species] || 0.3;
    for (const o of W.obstacles) {
      if (o.tree && a.species === 'nuthatch') continue;
      const [cx, cz] = nearestOn(o, px, pz);
      if (Math.hypot(px - cx, pz - cz) < o.r + r) return true;
    }
    return false;
  }
  // push a creature out of any obstacle it overlaps and let it slide along the edge toward its target
  function walkAround(a, step) {
    if (FLIES[a.species]) return;
    const r = RADIUS[a.species] || 0.3;
    for (const o of W.obstacles) {
      if (o.tree && a.species === 'nuthatch') continue;
      const [cx, cz] = nearestOn(o, a.pos.x, a.pos.z);
      const dx = a.pos.x - cx, dz = a.pos.z - cz, d = Math.hypot(dx, dz), R = o.r + r;
      if (d >= R) continue;
      const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
      a.pos.x = cx + nx * R; a.pos.z = cz + nz * R;
      if (a.target && step > 0) {
        const tx = a.target.x - a.pos.x, tz = a.target.z - a.pos.z;
        const side = a.side || Math.sign(tx * -nz + tz * nx) || 1;
        a.side = side;
        a.pos.x += -nz * side * step; a.pos.z += nx * side * step;
      }
    }
  }
  function separate() {
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i], b = agents[j];
      if (FLIES[a.species] || FLIES[b.species]) continue;
      if ((a.species === 'nuthatch') !== (b.species === 'nuthatch')) continue; // the climber is on the trunk, above the rest
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz), R = (RADIUS[a.species] || 0.3) + (RADIUS[b.species] || 0.3);
      if (d >= R || d < 1e-4) continue;
      const push = (R - d) / 2, nx = dx / d, nz = dz / d;
      a.pos.x -= nx * push; a.pos.z -= nz * push; b.pos.x += nx * push; b.pos.z += nz * push;
    }
  }
  // a spot near home with room to stand and, when we know where we start, a straight walk to it
  function randomNear(home, r, who, from) {
    const probe = { species: who || 'toad' };
    for (let k = 0; k < 14; k++) {
      const ang = rnd(0, 6.28), rr = Math.sqrt(Math.random()) * r;
      const p = { x: home.x + Math.cos(ang) * rr, z: home.z + Math.sin(ang) * rr };
      if (blocked(probe, p.x, p.z)) continue;
      if (from && !pathClear(probe, from, p)) continue;
      return p;
    }
    return from ? escapeTarget(Object.assign({ pos: from, home }, probe)) : { x: home.x, z: home.z };
  }

  /* Each species: activity(ctx) 0..1, actions: list of {w(weight fn), dur, run(agent)} */
  const SPECIES = {
    nuthatch: {
      sprite: 'nuthatch', size: 0.8, home: { x: OAK.x, z: OAK.z, r: 1.2 }, y: 1.6, speed: 0.5,
      activity: () => isNight() ? 0.05 : st.weather === 'rain' ? 0.35 : 0.8,
      actions: [
        { w: () => 3, dur: 2, run(a) { a.y = clamp(a.y - rnd(0.15, 0.35), 0.75, 2.3); a.target = randomNear(OAK, 0.6, 'nuthatch'); a.state = 'wander';
            say(a, pick(['the nuthatch moves one slow step down the ' + (isWet() ? 'wet oak' : 'oak'), 'the nuthatch moves again on the ' + (isWet() ? 'wet oak' : 'oak bark'), 'the nuthatch creeps head-first down the trunk', 'nuthatch taps twice at a seam in the bark']), { sfx: Math.random() < 0.4 ? 'step' : null, degree: 6, octave: 1, vol: 0.08 }); } },
        { w: () => (isNight() ? 0 : 1.2), dur: 1.5, run(a) { say(a, pick(['nuthatch calls a thin nasal note over the plot', 'a short chirp from the oak, answered by nothing', 'the nuthatch scolds something unseen in ' + lightWord()]), { sfx: 'chirp', degree: 8, octave: 1, kind: 'hot' }); } },
        { w: () => (isNight() ? 0 : 0.5), dur: 4, run(a) { a.y = 1.9; a.target = randomNear(OAK, 1.2, 'nuthatch'); a.state = 'wander'; say(a, pick(['the nuthatch climbs back up toward the bare crown', 'nuthatch wedges an acorn into a crack and hammers it']), { sfx: Math.random() < 0.5 ? 'acorn' : null, degree: 4, octave: 1 }); } },
        { w: () => 0.6, dur: 6, run(a) { a.state = 'rest'; a.t = 6; say(a, pick(['the nuthatch goes still against the trunk', 'nuthatch fluffs against the cold and waits']), { pluck: false }); } },
      ],
    },
    badger: {
      sprite: 'badger', size: 1.0, home: { x: 0, z: 0, r: 6.5 }, y: 0.7, speed: 0.55,
      activity: () => isNight() ? 0.9 : isDusk() ? 0.8 : st.weather === 'after rain' ? 0.5 : 0.2,
      actions: [
        { w: () => 2, dur: 5, run(a) { a.target = randomNear(a.home, a.home.r, a.species, a.pos); a.state = 'wander'; say(a, pick(['the badger noses forward through the wet grass', 'badger ambles low along the edge of the light', 'the badger follows an old track between the stones', 'badger pauses, lifts its snout, moves on']), { sfx: 'step', degree: 0, octave: -1, vol: 0.09 }); } },
        { w: () => (isWet() ? 2 : 1), dur: 3, run(a) { a.state = 'act'; say(a, pick(['badger claws scraping wet bark nervously', 'the badger rakes at the base of the oak', 'badger scrapes the soft ground under the fallen branch']), { sfx: 'scrape', degree: 1, octave: -1, kind: 'hot' }); } },
        { w: () => (isWet() ? 1.5 : 0.6), dur: 4, run(a) { a.state = 'act'; say(a, pick(['the badger digs for worms brought up by the rain', 'badger snuffles and digs, throwing soil', 'a shallow scrape opens under the badger\'s claws']), { sfx: 'scrape', degree: 2, octave: -1 }); } },
        { w: () => (isNight() || isDusk() ? 1 : 0.3), dur: 4, run(a) { a.target = randomNear(SETT, 1.0, 'badger', a.pos); a.state = 'wander'; say(a, pick(['the badger heads for the sett under the fallen branch', 'badger turns for home along the branch line']), { degree: 0, octave: -1 }); } },
        { w: () => 0.5, dur: 8, run(a) { a.state = 'rest'; a.t = 8; say(a, pick(['the badger settles heavily and listens', 'badger rests, breathing slow in the grass']), { pluck: false }); } },
      ],
    },
    toad: {
      sprite: 'toad', size: 0.85, home: { x: 6.2, z: 1.6, r: 1.8 }, y: 0.55, speed: 0.35,
      activity: () => isWet() ? 0.9 : isNight() ? 0.7 : 0.25,
      actions: [
        { w: () => (isWet() || isNight() ? 2.5 : 0.7), dur: 3, run(a) { a.state = 'act'; say(a, pick(['deep rhythmic toad croaking by stream', 'a single toad answers the stream from the reeds', 'toad croaks twice, then the rain again', 'low toad pulse under the sound of water']), { sfx: 'croak', repeat: Math.random() < 0.5, degree: 0, octave: -1, kind: 'hot' }); } },
        { w: () => 1, dur: 2, run(a) { a.target = randomNear(a.home, a.home.r, a.species, a.pos); a.state = 'wander'; say(a, pick(['the toad hops once toward the wet edge', 'toad drags itself over a fallen stem', 'the toad moves a few slow hops closer to the ravine']), { sfx: 'step', degree: 2, octave: -1, pluckP: 0.3 }); } },
        { w: () => 0.8, dur: 7, run(a) { a.state = 'rest'; a.t = 7; say(a, pick(['the toad sits, throat pulsing, eyes half shut', 'toad goes motionless in the dripping grass']), { pluck: false }); } },
      ],
    },
    vole: {
      sprite: 'vole', size: 0.75, home: { x: 1.2, z: 0.6, r: 3.2 }, y: 0.5, speed: 1.4,
      activity: () => 0.75,
      actions: [
        { w: () => 3, dur: 1.5, run(a) { a.target = besideStone(a); a.state = 'wander'; say(a, pick(['the vole darts between two stones', 'a vole runs the tunnel of bent grass', 'vole nips a seed head and drags it under a rock', 'the vole freezes, then flickers to the next stone']), { sfx: 'rustle', degree: 7, octave: 1, pluckP: 0.4, vol: 0.07 }); } },
        { w: () => 1, dur: 4, run(a) { a.state = 'act'; say(a, pick(['vole gnaws at a stalk, small dry clicks', 'the vole eats quickly, facing outward']), { pluckP: 0.2 }); } },
        { w: () => 0.6, dur: 5, run(a) { a.state = 'rest'; a.t = 5; say(a, pick(['the vole disappears under the largest rock', 'vole hides, only the grass tip trembles']), { pluck: false }); } },
      ],
    },
    beetle: {
      sprite: 'beetle', size: 0.65, home: { x: -0.5, z: 2.5, r: 4 }, y: 0.5, speed: 0.4,
      activity: () => st.weather === 'rain' ? 0.2 : 0.7,
      actions: [
        { w: () => 3, dur: 3, run(a) { a.target = randomNear(a.home, a.home.r, a.species, a.pos); a.state = 'wander'; say(a, pick(['a ground beetle crosses the bare patch', 'beetle climbs a stalk and drops off again', 'the beetle pushes through a tangle of stems', 'beetle circles a puddle rim, testing the edge']), { degree: 5, octave: 1, pluckP: 0.35, vol: 0.06 }); } },
        { w: () => 0.8, dur: 6, run(a) { a.state = 'rest'; a.t = 6; say(a, pick(['the beetle tucks itself under a leaf', 'beetle stalls, antennae ticking']), { pluck: false }); } },
      ],
    },
    moth: {
      sprite: 'moth', size: 0.7, home: { x: 2, z: -1.5, r: 5 }, y: 1.3, speed: 0.9,
      activity: () => (isNight() || isDusk()) && st.weather !== 'rain' ? 0.9 : 0.05,
      actions: [
        { w: () => 3, dur: 2, run(a) { a.target = randomNear(a.home, a.home.r, a.species, a.pos); a.y = rnd(0.9, 1.7); a.state = 'wander'; say(a, pick(['a moth loops through ' + lightWord(), 'the moth flutters from flower head to flower head', 'moth circles nothing in particular above the grass', 'a pale moth blunders against a seed stalk']), { sfx: 'flutter', degree: 8, octave: 1, pluckP: 0.4, vol: 0.06 }); } },
        { w: () => 0.7, dur: 8, run(a) { a.state = 'rest'; a.t = 8; a.y = 0.7; say(a, pick(['the moth settles under a wide leaf', 'moth rests, wings closed, colourless']), { pluck: false }); } },
      ],
    },
    wren: {
      sprite: 'wren', size: 0.8, home: { x: 4.5, z: -3.5, r: 3 }, y: 0.9, speed: 1.1,
      activity: () => isNight() ? 0.05 : isDawn() || st.weather === 'clear' ? 0.9 : 0.5,
      actions: [
        { w: () => 2, dur: 2, run(a) { a.target = randomNear(a.home, a.home.r, a.species, a.pos); a.y = rnd(0.7, 1.3); a.state = 'wander'; say(a, pick(['the wren hops along the fallen branch', 'wren flits low through the stalks, tail cocked', 'the wren picks something from the rotting wood']), { sfx: Math.random() < 0.3 ? 'flutter' : null, degree: 6, octave: 1, pluckP: 0.4, vol: 0.07 }); } },
        { w: () => (isDawn() || st.weather === 'clear' ? 2 : 0.7), dur: 2.5, run(a) { a.state = 'act'; say(a, pick(['wren bursts into a loud, rattling song', 'a quick wren trill from the branch pile', 'the wren sings, far too loud for its size']), { sfx: 'chirp', degree: 8, octave: 1, kind: 'hot' }); } },
        { w: () => 0.6, dur: 6, run(a) { a.state = 'rest'; a.t = 6; say(a, pick(['the wren vanishes into the branch pile', 'wren goes quiet in the dead wood']), { pluck: false }); } },
      ],
    },
    slug: {
      sprite: 'slug', size: 0.65, home: { x: -3.5, z: 1, r: 2.5 }, y: 0.45, speed: 0.12,
      activity: () => isWet() ? 0.9 : isNight() ? 0.5 : 0.08,
      actions: [
        { w: () => 2, dur: 8, run(a) { a.target = randomNear(a.home, a.home.r, a.species, a.pos); a.state = 'wander'; say(a, pick(['a slug glides out across the wet stone', 'the slug leaves a slow line up the fallen branch', 'slug stretches toward a soft fallen leaf']), { degree: 3, octave: -1, pluckP: 0.3, vol: 0.06 }); } },
        { w: () => 0.6, dur: 12, run(a) { a.state = 'rest'; a.t = 12; say(a, 'the slug stops and contracts, glistening', { pluck: false }); } },
      ],
    },
  };

  /* ---------- agent thinking ---------- */
  function think(a) {
    let act = SPECIES[a.species].activity();
    if (st.weather === 'snow') act *= a.species === 'badger' ? 0.7 : 0.35;
    if (Math.random() > act) { a.state = 'rest'; a.t = rnd(1.5, 4); return; }
    const opts = SPECIES[a.species].actions;
    let total = 0; const ws = opts.map(o => { const w = o.w(); total += w; return w; });
    let r = Math.random() * total;
    for (let i = 0; i < opts.length; i++) { r -= ws[i]; if (r <= 0) { opts[i].run(a); if (a.state !== 'rest') a.t = opts[i].dur; return; } }
    a.state = 'rest'; a.t = 3;
  }
  function tickAgent(a, dt) {
    a.t -= dt;
    a.vel = 0;
    // young ones are small, old ones slow
    const life = a.meta.lifespan || 100, age = a.meta.ageDays || 0;
    const grow = clamp(0.5 + 0.5 * age / (life * 0.12), 0.5, 1);
    const old = age > life * 0.85 ? 0.6 : 1;
    if (a.state === 'wander' && a.target) {
      if (a.target !== a.lastTarget) { a.lastTarget = a.target; a.bestD = Infinity; a.stuckT = 0; a.side = 0; }
      const done = moveTo(a, dt, a.target, a.speed * old * (st.weather === 'rain' && a.y < 0.4 ? 0.7 : 1));
      const dNow = dist(a.pos, a.target);
      if (dNow < a.bestD - 0.01) { a.bestD = dNow; a.stuckT = 0; } else a.stuckT += dt;
      // no progress for a while means the way is shut: back out into the open first, then rest and think again
      if (done || a.t < -8) { a.state = 'rest'; a.t = rnd(0.5, 2); a.side = 0; a.escaping = false; }
      else if (a.stuckT > 1.2) {
        if (a.escaping) { a.state = 'rest'; a.t = rnd(0.5, 1.5); a.side = 0; a.escaping = false; }
        else { a.target = escapeTarget(a); a.escaping = true; a.t = 3; a.side = 0; }
      }
      if (done && a.escaping) a.escaping = false;
    } else if (a.state === 'flee') {
      const th = a.threat;
      if (th) { const away = { x: a.pos.x + (a.pos.x - th.pos.x) * 3, z: a.pos.z + (a.pos.z - th.pos.z) * 3 }; moveTo(a, dt, away, a.speed * 2.2); }
      if (a.t <= 0) { a.state = 'rest'; a.t = rnd(2, 5); a.threat = null; }
    } else if (a.state === 'alert') {
      if (a.t <= 0) { a.state = 'rest'; a.t = 1; }
    } else if (a.t <= 0) think(a);
    // grounded creatures sit at their height, fliers bob
    const yy = a.y + (a.species === 'moth' ? Math.sin(st.minutes * 7 + a.pos.x) * 0.08 : 0);
    W.updateCreature(a.mesh, a.pos.x, yy, a.pos.z, a.state, grow);
  }

  /* ---------- interactions ---------- */
  function interactions() {
    const badger = agents.find(a => a.species === 'badger');
    for (const a of agents) {
      if (a === badger || a.state === 'flee') continue;
      if (badger && ['vole', 'toad', 'beetle', 'wren'].includes(a.species) && dist(a.pos, badger.pos) < 1.3 && (a.cooldown.flee || 0) <= 0) {
        a.state = 'flee'; a.t = rnd(1.5, 3); a.threat = badger; a.cooldown.flee = 12;
        st.tension = Math.min(1, st.tension + 0.35);
        say(a, pick([`the ${a.species} bolts as the badger blunders past`, `badger and ${a.species} meet in the grass. the ${a.species} loses its nerve`, `the ${a.species} scatters from the badger's path`]), { kind: 'alarm', sfx: 'rustle', degree: 8, octave: 1, vol: 0.14 });
        if ((badger.cooldown.notice || 0) <= 0) { badger.cooldown.notice = 20; badger.state = 'alert'; badger.t = 2; say(badger, pick(['the badger stops, snout raised, then loses interest', 'badger lunges half-heartedly and misses']), { sfx: 'scrape', pluck: false }); }
      }
    }
    // pairs moving together
    if ((timers.pair || 0) <= 0) {
      for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i], b = agents[j];
        if (a.state === 'wander' && b.state === 'wander' && dist(a.pos, b.pos) < 1.4 && a.species !== 'badger' && b.species !== 'badger') {
          timers.pair = 25;
          say(null, pick([`two creatures move slowly ${isDusk() ? 'downward through the failing light' : 'through ' + lightWord()}`, `the ${a.species} and the ${b.species} cross paths and ignore each other`, `${a.species} and ${b.species} pause a hand's width apart`]), { degree: 4, octave: 0, pan: panOf(a.pos) });
          return;
        }
      }
    }
  }

  /* ---------- environment emitters ---------- */
  function environment(dt) {
    for (const k in timers) timers[k] -= dt;
    for (const a of agents) for (const k in a.cooldown) a.cooldown[k] -= dt;
    // stream (off to the east, in the ravine)
    if ((timers.stream || 0) <= 0) {
      timers.stream = rnd(9, 22) / (isWet() ? 1.5 : 1);
      say(null, pick(['stream murmur continuing through ravine', 'distant stream trickle low and far in ravine', 'water knocks under the roots at the ravine edge', 'the stream sound thickens after the rain']), { sfx: 'trickle', pan: W.pan(STREAM.x, STREAM.z), degree: 2, octave: 0, pluckP: 0.4 });
    }
    // drips from canopy / branches
    if (isWet() && (timers.drip || 0) <= 0) {
      timers.drip = st.weather === 'after rain' ? rnd(2.5, 7) : rnd(1.5, 4);
      const which = Math.random();
      say(null, which < 0.35 ? 'distant rain dripping from canopy to stream' : which < 0.7 ? 'distant drip from overhanging branches' : pick(['a drop lets go of the oak and hits a stone', 'water beads and falls along the fallen branch', 'the drip from the crown finds the same leaf again']), { sfx: 'drip', pan: which < 0.35 ? W.pan(STREAM.x, STREAM.z) : W.pan(OAK.x, OAK.z), degree: pick([4, 6, 8]), octave: 1, pluckP: 0.35, vol: 0.07 });
    }
    // acorns
    if ((timers.acorn || 0) <= 0) {
      timers.acorn = st.weather === 'wind' ? rnd(6, 14) : rnd(25, 70);
      say(null, pick(['acorns rolling and bouncing down oak bark', 'an acorn drops, bounces twice, and is lost in the grass', 'something small falls out of the oak crown']), { sfx: 'acorn', pan: W.pan(OAK.x, OAK.z), degree: 0, octave: 0, kind: 'hot' });
    }
    // wind gusts
    if ((st.weather === 'wind' || st.wind > 0.35) && (timers.gust || 0) <= 0) {
      timers.gust = rnd(5, 12);
      st.gust = 1;
      say(null, pick(['a gust combs the grass flat toward the ravine', 'wind pushes through the dead crown, dry ticking', 'the whole plot leans and rights itself']), { sfx: 'rustle', degree: 5, octave: 0, pluckP: 0.3 });
    }
    // thunder
    if ((st.weather === 'rain' || st.storm) && (timers.thunder || 0) <= 0) {
      timers.thunder = st.storm ? rnd(15, 45) : rnd(40, 120);
      if (Math.random() < (st.storm ? 0.9 : 0.5)) { say(null, pick(['thunder, low and far behind the ravine', 'a long roll of thunder crosses the plot']), { sfx: 'thunder', kind: 'alarm', pluck: false }); st.tension = Math.min(1, st.tension + 0.25); for (const a of agents) if (a.state !== 'rest') { a.state = 'alert'; a.t = rnd(1, 3); } }
    }
    // the night has its own voices
    if (isNight() && (timers.owl || 0) <= 0) {
      timers.owl = rnd(45, 130);
      if (Math.random() < 0.7) say(null, pick(['an owl calls twice from beyond the ravine', 'the owl again, closer, then nothing', 'a soft double hoot from the dead crown']), { sfx: 'owl', pan: W.pan(OAK.x, OAK.z), degree: 0, octave: -1, pluckP: 0.3 });
    }
    if (isNight() && st.temp > 10 && !isWet() && S.season().dry < 0.6 && (timers.firefly || 0) <= 0) {
      timers.firefly = rnd(200, 420);
      say(null, pick(['the first fireflies blink over the grass', 'fireflies drift between the stones, on and off', 'a slow constellation of fireflies low over the verge']), { degree: 8, octave: 1, pluckP: 0.6, vol: 0.06 });
    }
    // light remarks
    if ((timers.light || 0) <= 0) {
      timers.light = rnd(60, 110);
      const t = st.weather === 'snow' ? pick(['snow settles on the pink stones and stays', 'the grass bends under a thin white weight', 'flakes drift through the beam without a sound']) : st.snowCover > 0.4 ? pick(['old snow lies in the hollows, grey at the edges', 'tracks cross the snow and stop at the big rock', 'the verge is white and very quiet']) : S.season().dry > 0.5 ? pick(['the grass has gone to straw, it rattles in the wind', 'seed heads stand dry and pale along the edge', 'the verge is the colour of old paper']) : isNight() ? (S.moon().illum > 0.6 && !isWet() && st.weather !== 'fog' ? pick(['the moon is up. the stones throw short shadows', 'moonlight on the wet stones, every blade edged in grey', 'a bright moon over the oak, the verge in silver']) : pick(['the plot is a dark bowl, only sound now', 'stars between the branches, nothing moves for a while', 'no moon to speak of, the dark is complete'])) : isDusk() ? pick(['the light fails along the west edge of the plot', 'colour drains out of the flower heads']) : isDawn() ? pick(['grey light finds the top of the oak first', 'mist lifting off the grass in threads']) : st.weather === 'fog' ? 'fog sits in the bowl of the plot, sound carries oddly' : pick(['a shaft of light picks out the pink stones', 'the flowers hold still in the warm air']);
      say(null, t, { pluck: false });
    }
    st.gust = Math.max(0, (st.gust || 0) - dt * 0.4);
  }

  /* ---------- weather machine ---------- */
  const NEXT = {
    clear: ['overcast', 'wind', 'clear', 'overcast'], overcast: ['drizzle', 'clear', 'fog', 'rain'], drizzle: ['rain', 'after rain', 'drizzle'],
    rain: ['after rain', 'drizzle', 'rain'], 'after rain': ['clear', 'overcast', 'fog', 'after rain'], fog: ['clear', 'overcast'], wind: ['clear', 'overcast', 'wind'], snow: ['overcast', 'snow', 'clear'],
  };
  const RAIN = { clear: 0, overcast: 0.02, drizzle: 0.35, rain: 1, 'after rain': 0.16, fog: 0.03, wind: 0.04, snow: 0.6 };
  const WIND = { clear: 0.12, overcast: 0.2, drizzle: 0.2, rain: 0.35, 'after rain': 0.12, fog: 0.04, wind: 0.75, snow: 0.18 };
  function setWeather(w, first) {
    st.weather = w; st.weatherT = rnd(45, 110);
    A.setWeather(w);
    if (!first) {
      const line = { clear: 'the cloud breaks. sudden light on the wet stones', overcast: 'cloud closes over the plot, colour flattens', drizzle: 'a fine drizzle starts, barely a sound', rain: 'rain arrives properly, hissing in the grass', 'after rain': 'the rain stops. everything drips', fog: 'fog fills the bowl of the plot', wind: 'the wind gets up from the west', snow: 'snow begins, slow and soundless' }[w];
      say(null, line, { kind: 'hot', degree: 0, octave: 1, pluckP: 1, vol: 0.14 });
      st.tension = Math.min(1, st.tension + (w === 'rain' ? 0.2 : w === 'wind' ? 0.15 : 0));
    }
  }

  /* ---------- public ---------- */
  S.init = function (world, audio, onEvent) {
    W = world; A = audio; emit = onEvent;
    // creatures are spawned by Life from the persisted roster
    setWeather('after rain', true);
  };

  /* live sky: called by the weather module with real conditions for the chosen place */
  S.applyLive = function (d) {
    const first = !st.live;
    st.live = true; st.place = d.place.name; st.utcOffset = d.utcOffset;
    if (d.sunrise != null && d.sunset != null && d.sunset > d.sunrise) { st.sunrise = d.sunrise; st.sunset = d.sunset; }
    st.liveTemp = d.temp; st.liveWind = clamp(d.windKmh / 40, 0.05, 0.9); st.storm = !!d.storm;
    if (first) {
      st.temp = d.temp;
      if (d.temp < -1 && st.snowCover < 0.5 && (d.state === 'snow' || d.recentPrecipitation > 0.3)) st.snowCover = 0.6; // arrived to a white plot
      st.minutes = localMinutes(); st.hour = st.minutes / 60;
      if (d.state !== st.weather) { st.weather = d.state; A.setWeather(d.state); st.rainAmount = RAIN[d.state]; }
      say(null, `the plot syncs with the sky over ${d.place.name.toLowerCase()}: ${Weather.describe(d)}`, { kind: 'hot', degree: 4, octave: 1, pluckP: 1, vol: 0.14 });
    } else if (d.state !== st.weather) setWeather(d.state);
    st.weatherT = 1e9; // real weather never rolls the dice
  };
  S.dropLive = function () { st.live = false; st.place = null; st.weatherT = rnd(30, 60); };
  function localMinutes() {
    const now = Date.now() + (st.utcOffset || 0) * 1000;
    return ((now / 60000) % 1440 + 1440) % 1440;
  }

  S.tick = function (dt) {
    if (st.live) {
      st.minutes = localMinutes();
    } else {
      // simulated clock: one minute every 2.4 real seconds
      st.minutes = (st.minutes + dt / 2.4) % 1440;
    }
    st.hour = st.minutes / 60;
    st.weatherT -= dt;
    if (st.weatherT <= 0) setWeather(pick(NEXT[st.weather]));
    st.rainAmount += (RAIN[st.weather] - st.rainAmount) * dt * 0.15;
    const windBase = st.live ? st.liveWind : WIND[st.weather];
    st.wind += (windBase + (st.gust || 0) * 0.6 - st.wind) * dt * 0.5;
    const tempTarget = st.live ? st.liveTemp : 9 + 7 * Math.max(0, 1 - Math.abs(st.hour - 14) / 8) - (isWet() ? 3 : 0) - (st.weather === 'fog' ? 2 : 0) + (st.weather === 'clear' ? 1.5 : 0);
    st.temp += (tempTarget - st.temp) * dt * 0.02;
    // snow cover: builds while it snows, holds in the cold, melts away above freezing
    const snowTarget = st.weather === 'snow' ? 1 : st.temp < 0.5 ? st.snowCover : 0;
    st.snowCover += (snowTarget - st.snowCover) * dt * (snowTarget > st.snowCover ? 0.01 : 0.003);
    for (const a of agents) tickAgent(a, dt);
    for (const a of agents) walkAround(a, 0);
    separate();
    interactions();
    environment(dt);
    let moving = 0; for (const a of agents) moving += a.vel > 0 ? Math.min(1, a.vel / 1.2) : 0;
    st.activity += (moving / agents.length - st.activity) * dt * 0.8;
    st.tension = Math.max(0, st.tension - dt * 0.03);
  };
  S.agents = agents;
  S.setMood = m => { st.mood = m; A.setMood(m); };
  S.clockText = () => { const h = Math.floor(st.hour), m = Math.floor(st.minutes % 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  window.Sim = S;
})();
