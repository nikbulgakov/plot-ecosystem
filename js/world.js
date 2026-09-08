/* Three.js scene drawn like a 16-bit game: rendered to a low-res target, palette-quantised with an ordered dither,
   a faint bloom on top, creatures as pixel sprites. */
(function () {
  const W = {};
  const R = 9.5;                 // plot radius
  const PIX_TARGET = 640;        // width of the low-res frame in pixels when no pixel size is chosen (≈2 px per pixel)
  let renderer, scene, camera, clock;
  let grassMat, rain, rainPos, rainCount = 0, spot, hemi, fillLight;
  let cam = { theta: 0.6, phi: 0.72, radius: 20, auto: true, target: new THREE.Vector3(0, 0, 0), follow: null };
  let drag = null;
  const creatures = [];
  const raycaster = new THREE.Raycaster();
  const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();
  const camRight = new THREE.Vector3(1, 0, 0), camDir = new THREE.Vector3();
  const rnd = (a, b) => a + Math.random() * (b - a);
  // post-processing
  let rt, bloomRT, postScene, postCam, quad, postMat, downMat, lowW, lowH, pixOverride = 0;
  let grassMesh, ground;

  /* ---------- grass palettes: hue / saturation / lightness ranges, the odd dry blade, the ground under it ---------- */
  const PALETTES = {
    meadow: { hue: [0.24, 0.30], sat: [0.42, 0.67], lig: [0.17, 0.31], dry: [0.14, 0.40, 0.32], dryP: 0.05, ground: 0x0a1608 },
    moss:   { hue: [0.36, 0.44], sat: [0.32, 0.52], lig: [0.13, 0.25], dry: [0.20, 0.30, 0.26], dryP: 0.04, ground: 0x07130f },
    straw:  { hue: [0.09, 0.15], sat: [0.45, 0.70], lig: [0.22, 0.36], dry: [0.07, 0.55, 0.42], dryP: 0.10, ground: 0x15100a },
    arcade: { hue: [0.27, 0.33], sat: [0.80, 1.00], lig: [0.22, 0.38], dry: [0.16, 0.90, 0.50], dryP: 0.06, ground: 0x05170a },
  };
  let paletteName = 'meadow';
  W.setGrassPalette = function (name) {
    const p = PALETTES[name]; if (!p || !grassMesh) return;
    paletteName = name;
    const col = new THREE.Color();
    for (let i = 0; i < grassMesh.count; i++) {
      col.setHSL(rnd(p.hue[0], p.hue[1]), rnd(p.sat[0], p.sat[1]), rnd(p.lig[0], p.lig[1]));
      if (Math.random() < p.dryP) col.setHSL(p.dry[0], p.dry[1], p.dry[2]);
      grassMesh.setColorAt(i, col);
    }
    grassMesh.instanceColor.needsUpdate = true;
    groundBase.setHex(p.ground);
    applySeasonGround();
  };
  W.palettes = () => Object.keys(PALETTES);
  // season: dry 0..1 (green → straw), snow 0..1 (cover)
  const groundBase = new THREE.Color(0x0a1608), groundDry = new THREE.Color(0x241c10), groundSnow = new THREE.Color(0xaeb8c4), groundTmp = new THREE.Color();
  let season = { dry: 0, snow: 0 };
  function applySeasonGround() {
    if (!ground) return;
    groundTmp.copy(groundBase).lerp(groundDry, season.dry).lerp(groundSnow, season.snow);
    ground.material.color.copy(groundTmp);
  }
  W.setSeason = function (s) {
    const dry = Math.max(0, Math.min(1, s.dry || 0)), snow = Math.max(0, Math.min(1, s.snow || 0));
    if (Math.abs(dry - season.dry) < 0.002 && Math.abs(snow - season.snow) < 0.002) return;
    season = { dry, snow };
    if (grassMat) { grassMat.uniforms.uDry.value = dry; grassMat.uniforms.uSnow.value = snow; }
    applySeasonGround();
  };

  /* ---------- grass ---------- */
  function makeGrass(count) {
    const geo = new THREE.PlaneGeometry(0.17, 0.42, 1, 4);
    geo.translate(0, 0.225, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) { // taper
      const y = pos.getY(i) / 0.45;
      pos.setX(i, pos.getX(i) * (1 - y * 0.8));
      pos.setZ(i, Math.sin(y * 1.4) * 0.05);
    }
    grassMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uWind: { value: 0.5 }, uRadius: { value: R }, uLight: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: 0.45 }, uDry: { value: 0 }, uSnow: { value: 0 } },
      vertexShader: `
        uniform float uTime, uWind, uRadius;
        varying float vH, vFade; varying vec3 vCol;
        void main(){
          vec3 ipos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float h = uv.y;
          vec3 p = position;
          float g = sin(uTime*1.1 + ipos.x*0.7 + ipos.z*0.5)*0.6 + sin(uTime*2.3 + ipos.z*1.9 + ipos.x*0.3)*0.25;
          p.x += g * h*h * uWind * 0.3;
          p.z += cos(uTime*0.8 + ipos.x*1.3 + ipos.z*0.4)*0.15*h*h*uWind;
          vec4 wp = instanceMatrix * vec4(p,1.0);
          vH = h;
          float d = length(ipos.xz);
          vFade = 1.0 - smoothstep(uRadius*0.42, uRadius*0.98, d);
          vCol = instanceColor;
          gl_Position = projectionMatrix * modelViewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 uLight; uniform float uAmb, uDry, uSnow;
        varying float vH, vFade; varying vec3 vCol;
        void main(){
          vec3 c = vCol * mix(0.25, 1.0, pow(vH,1.3));
          // the season: dead straw in autumn and winter, a cover of snow when the sky says so
          float lum = dot(c, vec3(0.3, 0.59, 0.11));
          vec3 dry = vec3(0.72, 0.56, 0.27) * (lum * 2.2 + 0.06);
          c = mix(c, dry, uDry);
          vec3 snow = vec3(0.84, 0.88, 0.95) * (0.5 + 0.5 * pow(vH, 1.2));
          c = mix(c, snow, uSnow * smoothstep(0.15, 0.7, vH + uSnow * 0.5));
          c *= uLight * (uAmb + 0.75 * vFade);
          c *= vFade;
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geo, grassMat, count);
    const col = new THREE.Color(0x335522);
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(Math.random()) * R * 0.98, a = Math.random() * Math.PI * 2;
      tmpP.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      tmpQ.setFromEuler(new THREE.Euler(rnd(-0.25, 0.25), Math.random() * Math.PI * 2, rnd(-0.25, 0.25)));
      const s = rnd(0.6, 1.35);
      tmpS.set(s, s * rnd(0.7, 1.5), s);
      tmpM.compose(tmpP, tmpQ, tmpS);
      mesh.setMatrixAt(i, tmpM);
      mesh.setColorAt(i, col); // real colours come from the palette
    }
    mesh.frustumCulled = false;
    grassMesh = mesh;
    return mesh;
  }

  /* ---------- rocks ---------- */
  function makeRock(size, x, z) {
    const geo = new THREE.IcosahedronGeometry(size, 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
      const n = 1 + 0.16 * Math.sin(v.x * 3.1 + v.y * 2.3) * Math.cos(v.z * 2.7 + v.x) + (Math.random() - 0.5) * 0.06;
      v.multiplyScalar(n); p.setXYZ(i, v.x, v.y * 0.72, v.z);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xa8716d, roughness: 1, metalness: 0, flatShading: true }));
    m.position.set(x, size * 0.2, z);
    m.rotation.set(rnd(0, 0.4), rnd(0, 6.28), rnd(0, 0.3));
    return m;
  }

  /* ---------- dead branches ---------- */
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x9a9184, roughness: 0.95, flatShading: true });
  function branch(group, from, dir, len, rad, depth) {
    const to = from.clone().add(dir.clone().multiplyScalar(len));
    const g = new THREE.CylinderGeometry(rad * 0.6, rad, len, 5, 1);
    const m = new THREE.Mesh(g, woodMat);
    m.position.copy(from).lerp(to, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    group.add(m);
    if (depth <= 0) return;
    const n = depth > 1 ? 2 : (Math.random() < 0.6 ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const d = dir.clone().add(new THREE.Vector3(rnd(-0.9, 0.9), rnd(-0.3, 0.5), rnd(-0.9, 0.9))).normalize();
      branch(group, to.clone().lerp(from, i === 0 ? 0 : rnd(0.1, 0.4)), d, len * rnd(0.55, 0.8), rad * 0.65, depth - 1);
    }
  }
  function makeSnag(x, z, scale, lying) {
    const g = new THREE.Group();
    const dir = lying ? new THREE.Vector3(rnd(-1, 1), 0.25, rnd(-1, 1)).normalize() : new THREE.Vector3(rnd(-0.3, 0.3), 1, rnd(-0.3, 0.3)).normalize();
    branch(g, new THREE.Vector3(0, -0.1, 0), dir, 1.4 * scale, 0.08 * scale, 3);
    g.position.set(x, 0, z);
    return g;
  }

  /* ---------- flowers & stalks ---------- */
  let flowers = null, flowerTarget = 1, flowerNow = 1;
  function makeFlowers(count) {
    const palette = [0xff7a1c, 0xfff1cf, 0xff4da6, 0xffd23f, 0xffffff, 0xff9c5b, 0xffe7a3, 0xd9ff7a];
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.085, 5, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), count);
    const stems = new Float32Array(count * 6);
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(Math.random()) * R * 0.95, a = Math.random() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r, h = rnd(0.35, 0.95);
      const lean = rnd(0.05, 0.3), la = rnd(0, 6.28);
      const hx = x + Math.cos(la) * lean, hz = z + Math.sin(la) * lean;
      tmpM.compose(new THREE.Vector3(hx, h, hz), tmpQ.set(0, 0, 0, 1), tmpS.set(1, 1, 1).multiplyScalar(rnd(0.6, 1.3)));
      heads.setMatrixAt(i, tmpM);
      col.setHex(palette[Math.floor(Math.random() * palette.length)]);
      const fade = 1 - Math.pow(r / R, 3) * 0.85;
      col.multiplyScalar(fade);
      heads.setColorAt(i, col);
      stems.set([x, 0, z, hx, h, hz], i * 6);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(stems, 3));
    const stemLines = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xd8cfa8, transparent: true, opacity: 0.55 }));
    const g = new THREE.Group(); g.add(heads); g.add(stemLines);
    flowers = { heads, stems: stemLines, max: count };
    return g;
  }
  // how much of the plot is in flower, 0..1 (instances beyond the count are simply not drawn)
  W.setFlowerDensity = function (d, immediate) { flowerTarget = Math.max(0.04, Math.min(1, d)); if (immediate) flowerNow = flowerTarget; };
  function applyFlowers(dt) {
    if (!flowers) return;
    flowerNow += (flowerTarget - flowerNow) * Math.min(1, dt * 0.8);
    const n = Math.floor(flowers.max * flowerNow * (1 - season.snow * 0.95));
    if (flowers.heads.count !== n) { flowers.heads.count = n; flowers.stems.geometry.setDrawRange(0, n * 2); }
  }

  /* ---------- rain ---------- */
  let snowMode = false;
  function makeRain(max) {
    rainPos = new Float32Array(max * 6);
    for (let i = 0; i < max; i++) resetDrop(i, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xcdd8c6, transparent: true, opacity: 0.4 }));
    rain.frustumCulled = false;
    rain.geometry.setDrawRange(0, 0);
    return rain;
  }
  function resetDrop(i, randomY) {
    const x = rnd(-22, 22), z = rnd(-22, 22), y = randomY ? rnd(0, 14) : rnd(12, 15), l = snowMode ? rnd(0.05, 0.1) : rnd(0.25, 0.6);
    rainPos.set([x, y, z, x + 0.03, y + l, z + 0.02], i * 6);
  }

  /* ---------- the night sky: stars, a moon with a phase, fireflies ---------- */
  let stars, moon, moonTex, moonPhase = -1, fireflies, ffBase, ffPhase, ffColor, ffAmount = 0, nightAmount = 0;
  function makeSky() {
    const N = 420, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const az = Math.random() * Math.PI * 2, el = 0.06 + Math.pow(Math.random(), 1.4) * 1.4, r = 70;
      pos.set([r * Math.cos(el) * Math.cos(az), r * Math.sin(el), r * Math.cos(el) * Math.sin(az)], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xe6ecff, size: 0.55, sizeAttenuation: true, transparent: true, opacity: 0, fog: false, toneMapped: false, depthWrite: false }));
    stars.frustumCulled = false; scene.add(stars);
    moonTex = new THREE.CanvasTexture(document.createElement('canvas'));
    moonTex.magFilter = THREE.NearestFilter; moonTex.minFilter = THREE.NearestFilter; moonTex.generateMipmaps = false;
    moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, transparent: true, opacity: 0, fog: false, toneMapped: false, depthWrite: false }));
    const az = 2.3, el = 0.24, r = 62;
    moon.position.set(r * Math.cos(el) * Math.cos(az), r * Math.sin(el), r * Math.cos(el) * Math.sin(az));
    moon.scale.set(6, 6, 1);
    scene.add(moon);
    drawMoon(0.5);
    // fireflies
    const F = 80; ffBase = new Float32Array(F * 3); ffPhase = new Float32Array(F);
    const fp = new Float32Array(F * 3); ffColor = new Float32Array(F * 3);
    for (let i = 0; i < F; i++) {
      const rr = Math.sqrt(Math.random()) * R * 0.85, a = Math.random() * Math.PI * 2;
      ffBase.set([Math.cos(a) * rr, rnd(0.6, 1.7), Math.sin(a) * rr], i * 3);
      ffPhase[i] = Math.random() * 20;
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
    fg.setAttribute('color', new THREE.BufferAttribute(ffColor, 3));
    fireflies = new THREE.Points(fg, new THREE.PointsMaterial({ size: 0.3, sizeAttenuation: true, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
    fireflies.frustumCulled = false; fireflies.visible = false; scene.add(fireflies);
  }
  // a 16×16 pixel moon: the lit side follows the phase (waxing lights the right edge)
  function drawMoon(phase) {
    const cv = moonTex.image; cv.width = 16; cv.height = 16;
    const g = cv.getContext('2d'); g.clearRect(0, 0, 16, 16);
    const k = (1 - Math.cos(2 * Math.PI * phase)) / 2, side = phase < 0.5 ? 1 : -1;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const nx = (x - 7.5) / 7, ny = (y - 7.5) / 7, d = nx * nx + ny * ny;
      if (d > 1) continue;
      const w = Math.sqrt(1 - ny * ny);
      const lit = side * nx >= -(2 * k - 1) * w;
      g.fillStyle = lit ? (d > 0.8 ? '#d8d4bf' : '#f2eed8') : 'rgba(60,68,92,0.35)';
      g.fillRect(x, y, 1, 1);
    }
    moonTex.needsUpdate = true; moonPhase = phase;
  }
  // o: {night 0..1, moonPhase 0..1, fireflies 0..1}
  W.setNight = function (o) {
    nightAmount = Math.max(0, Math.min(1, o.night || 0));
    if (o.moonPhase != null && Math.abs(o.moonPhase - moonPhase) > 0.01) drawMoon(o.moonPhase);
    stars.material.opacity = nightAmount * 0.9;
    moon.material.opacity = nightAmount;
    ffAmount = Math.max(0, Math.min(1, o.fireflies || 0)) * nightAmount;
    fireflies.visible = ffAmount > 0.02;
  };
  function animateFireflies(t) {
    if (!fireflies.visible) return;
    const p = fireflies.geometry.attributes.position.array, c = ffColor;
    for (let i = 0; i < ffPhase.length; i++) {
      const k = i * 3, ph = ffPhase[i];
      p[k] = ffBase[k] + Math.sin(t * 0.3 + ph) * 0.7;
      p[k + 1] = ffBase[k + 1] + Math.sin(t * 0.7 + ph * 1.7) * 0.15;
      p[k + 2] = ffBase[k + 2] + Math.cos(t * 0.25 + ph * 1.3) * 0.7;
      const b = Math.pow(Math.max(0, Math.sin(t * 1.4 + ph * 2.1)), 10) * ffAmount;
      c[k] = 1.0 * b; c[k + 1] = 0.93 * b; c[k + 2] = 0.35 * b;
    }
    fireflies.geometry.attributes.position.needsUpdate = true;
    fireflies.geometry.attributes.color.needsUpdate = true;
  }

  /* ---------- creatures: pixel sprites ---------- */
  // Each species has three frames of the same size: two walk frames and a sleeping pose.
  const K = '#14121c';
  const SPRITES = {
    badger: { pal: { G: '#8a8896', W: '#f4f4f6', K: K }, frames: [
      ['....GGGGGG..', '..GGGGGGGGG.', '.WKWGGGGGGGG', 'KWKWGGGGGGGG', '.WKWGGGGGGG.', '..GGGGGGGG..', '..K..K.K.K..'],
      ['....GGGGGG..', '..GGGGGGGGG.', '.WKWGGGGGGGG', 'KWKWGGGGGGGG', '.WKWGGGGGGG.', '..GGGGGGGG..', '.K..K..K..K.'],
      ['............', '....GGGGG...', '..GGGGGGGGG.', '.WKWGGGGGGGG', 'KWKWGGGGGGGG', '.WKGGGGGGGG.', '..GGGGGGGGG.']] },
    toad: { pal: { Y: '#d2bc4c', O: K, S: '#8a7a2a' }, frames: [
      ['..Y...Y..', '.YYYYYYY.', 'YYOYYYOYY', 'YYYYYYYYY', '.YYYYYYY.', 'YY.....YY'],
      ['..Y...Y..', '.YYYYYYY.', 'YYOYYYOYY', 'YYYYYYYYY', 'YYYYYYYYY', '.Y.....Y.'],
      ['.........', '..Y...Y..', '.YYYYYYY.', 'YYSYYYSYY', 'YYYYYYYYY', 'YYYYYYYYY']] },
    vole: { pal: { B: '#a8743f', K: K, P: '#f0a0a0' }, frames: [
      ['..BBBB.', '.BBBBBK', 'BBBBBBB', 'P.B..B.'],
      ['..BBBB.', '.BBBBBK', 'BBBBBBB', '.PB.B..'],
      ['.......', '..BBBB.', '.BBBBBB', 'PBBBBB.']] },
    beetle: { pal: { K: '#20202c', H: '#7a7a96' }, frames: [
      ['.KKK.', 'KKHKK', 'KKKKK', 'K.K.K'],
      ['.KKK.', 'KKHKK', 'KKKKK', '.K.K.'],
      ['.KKK.', 'KKHKK', 'KKKKK', '.....']] },
    moth: { pal: { M: '#f0ecf8', P: '#d884b8' }, frames: [
      ['M.......M', 'MMM...MMM', '.MMMPMMM.', '..MMPMM..', '...M.M...'],
      ['.........', '..M...M..', '.MMMPMMM.', '..MMPMM..', '...M.M...'],
      ['.........', '.........', '..MMPMM..', '.MMMPMMM.', '...M.M...']] },
    wren: { pal: { R: '#b47a4e', B: '#86643f', K: K }, frames: [
      ['.....B', '.RRR.B', 'RRRRBB', 'RRRRR.', '.K..K.'],
      ['.RRR..', 'RRRRB.', 'RRRRBB', '.RRR..', '..KK..'],
      ['......', '.RRR.B', 'RRRRRB', 'RRRRR.', '.RRRR.']] },
    nuthatch: { pal: { N: '#7a9ac4', W: '#f2ece2', K: K }, frames: [
      ['.NNNN.', 'NNNNNK', 'NWWWNN', '.NWWN.', '..N.N.'],
      ['.NNNN.', 'NNNNNK', 'NWWWNN', '.NWWN.', '.N..N.'],
      ['......', '.NNNN.', 'NNNNNN', 'NWWWN.', '.NWWN.']] },
    slug: { pal: { T: '#dcb884' }, frames: [
      ['....TT.', 'TTTTTTT', '.TTTTT.'],
      ['.....TT', '.TTTTTT', 'TTTTTT.'],
      ['.......', '..TTT..', '.TTTTT.']] },
  };
  const FRAME_WALK_A = 0, FRAME_WALK_B = 1, FRAME_REST = 2;
  const texCache = {};
  // sprite sheet: frames side by side, each with a 1-px outline and a 1-px margin
  function spriteTexture(name) {
    if (texCache[name]) return texCache[name];
    const s = SPRITES[name] || SPRITES.beetle;
    const cols = s.frames[0][0].length, rows = s.frames[0].length, n = s.frames.length;
    const fw = cols + 2, fh = rows + 2;
    const cv = document.createElement('canvas'); cv.width = fw * n; cv.height = fh;
    const g = cv.getContext('2d');
    s.frames.forEach((frame, fi) => {
      const ox = fi * fw;
      const solid = (x, y) => y >= 0 && y < rows && x >= 0 && x < cols && frame[y][x] !== '.';
      g.fillStyle = '#0c0a12';
      for (let y = -1; y <= rows; y++) for (let x = -1; x <= cols; x++) {
        if (!solid(x, y) && (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1))) g.fillRect(ox + x + 1, y + 1, 1, 1);
      }
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const ch = frame[y][x]; if (ch === '.') continue;
        g.fillStyle = s.pal[ch]; g.fillRect(ox + x + 1, y + 1, 1, 1);
      }
    });
    const t = new THREE.CanvasTexture(cv);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    t.encoding = THREE.sRGBEncoding;
    texCache[name] = { tex: t, w: fw, h: fh, n };
    return texCache[name];
  }
  function setFrame(c, frame, flip) {
    const n = c.frames;
    if (flip) { c.tex.repeat.x = -1 / n; c.tex.offset.x = (frame + 1) / n; }
    else { c.tex.repeat.x = 1 / n; c.tex.offset.x = frame / n; }
    c.frame = frame; c.flipped = flip;
  }
  W.addCreature = function (spec) {
    const g = new THREE.Group();
    const st = spriteTexture(spec.sprite);
    const tex = st.tex.clone(); tex.needsUpdate = true;
    tex.repeat.set(1 / st.n, 1);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.5, toneMapped: false });
    const sprite = new THREE.Sprite(mat);
    const unit = 0.17 * (spec.size || 1);
    sprite.scale.set(st.w * unit, st.h * unit, 1);
    sprite.center.set(0.5, 0.3);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), new THREE.MeshBasicMaterial({ visible: false }));
    g.add(sprite); g.add(hit);
    scene.add(g);
    // trail: red pixel dots
    const N = 140;
    const tp = new Float32Array(N * 3);
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(tp, 3));
    tg.setDrawRange(0, 0);
    const trail = new THREE.Points(tg, new THREE.PointsMaterial({ color: spec.trail || 0xff4a3c, size: 0.2, sizeAttenuation: true, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }));
    trail.frustumCulled = false; trail.renderOrder = 9;
    scene.add(trail);
    const c = { spec, group: g, sprite, mat, tex, hit, trail, tp, tn: 0, tN: N, baseScale: sprite.scale.clone(), lastTrail: new THREE.Vector3(1e9, 0, 0), facing: 1, flipped: false, frame: -1, frames: st.n, restT: 0, bob: Math.random() * 6 };
    setFrame(c, FRAME_WALK_A, false);
    hit.userData.creature = c;
    creatures.push(c);
    return c;
  };
  W.removeCreature = function (c) {
    const i = creatures.indexOf(c); if (i >= 0) creatures.splice(i, 1);
    scene.remove(c.group); scene.remove(c.trail);
    c.trail.geometry.dispose(); c.tex.dispose(); c.mat.dispose(); c.hit.geometry.dispose();
    if (cam.follow === c) cam.follow = null;
  };
  W.updateCreature = function (c, x, y, z, state, scale) {
    const g = c.group;
    // face the way we move, judged in screen space so it survives the orbiting camera
    const dx = x - g.position.x, dz = z - g.position.z;
    const sx = dx * camRight.x + dz * camRight.z;
    if (Math.abs(sx) > 0.0015) c.facing = sx < 0 ? -1 : 1;
    g.position.set(x, y, z);
    const s = scale != null ? scale : 1;
    c.sprite.scale.set(c.baseScale.x * s, c.baseScale.y * s, 1);
    const flip = c.facing > 0; // sprites are drawn facing left
    // frame: walk cycle while moving (faster when fleeing), a slow shuffle while busy, the sleeping pose after a while at rest
    const t = clock.elapsedTime;
    c.restT = state === 'rest' ? c.restT + lastDt : 0;
    let frame = FRAME_WALK_A;
    if (state === 'wander') frame = Math.floor(t * 5 + c.bob) % 2;
    else if (state === 'flee') frame = Math.floor(t * 12 + c.bob) % 2;
    else if (state === 'act') frame = Math.floor(t * 2.5 + c.bob) % 2;
    else if (state === 'rest' && c.restT > 1.5) frame = FRAME_REST;
    if (frame !== c.frame || flip !== c.flipped) setFrame(c, frame, flip);
    if (c.lastTrail.distanceTo(g.position) > 0.22) {
      c.lastTrail.copy(g.position);
      const i = c.tn % c.tN;
      c.tp.set([x, Math.max(0.3, y - 0.25), z], i * 3);
      c.tn++;
      c.trail.geometry.attributes.position.needsUpdate = true;
      c.trail.geometry.setDrawRange(0, Math.min(c.tn, c.tN));
    }
    const moving = state === 'wander' || state === 'flee';
    c.sprite.position.y = moving ? Math.abs(Math.sin(t * (state === 'flee' ? 14 : 7) + c.bob)) * 0.09 : 0;
    c.mat.opacity = frame === FRAME_REST ? 0.9 : 1;
  };

  /* ---------- post: low-res + palette + dither + bloom ---------- */
  function setupPost() {
    const w = window.innerWidth, h = window.innerHeight;
    const pix = pixOverride || Math.max(2, Math.round(w / PIX_TARGET));
    lowW = Math.max(64, Math.round(w / pix)); lowH = Math.max(36, Math.round(h / pix));
    if (rt) { rt.dispose(); bloomRT.dispose(); }
    rt = new THREE.WebGLRenderTarget(lowW, lowH, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false });
    rt.texture.encoding = THREE.sRGBEncoding;
    bloomRT = new THREE.WebGLRenderTarget(Math.max(1, Math.round(lowW / 4)), Math.max(1, Math.round(lowH / 4)), { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    bloomRT.texture.encoding = THREE.sRGBEncoding;
    if (!postScene) {
      postScene = new THREE.Scene();
      postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      postMat = new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null }, tBloom: { value: null }, uRes: { value: new THREE.Vector2() }, uLevels: { value: 12 }, uDither: { value: 0.1 }, uBloom: { value: 0.08 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `
          uniform sampler2D tDiffuse, tBloom; uniform vec2 uRes; uniform float uLevels, uDither, uBloom;
          varying vec2 vUv;
          float b2(vec2 p){ return mod(p.y, 2.0) * 3.0 + mod(p.x, 2.0) * 2.0; }
          float bayer4(vec2 p){ return mod(b2(p), 4.0) * 4.0 + mod(b2(floor(p * 0.5)), 4.0); }
          void main(){
            vec3 c = texture2D(tDiffuse, vUv).rgb;
            vec3 b = texture2D(tBloom, vUv).rgb;
            c += b * b * uBloom;                          // soft glow from the bright parts only
            vec2 p = floor(vUv * uRes);
            float d = (bayer4(p) + 0.5) / 16.0 - 0.5;     // ordered dither, -0.5..0.5
            c = floor(c * uLevels + d * uDither + 0.5) / uLevels;
            gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
          }`,
        depthTest: false, depthWrite: false,
      });
      downMat = new THREE.MeshBasicMaterial({ map: null, depthTest: false, depthWrite: false, toneMapped: false });
      quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
      quad.frustumCulled = false;
      postScene.add(quad);
    }
    postMat.uniforms.tDiffuse.value = rt.texture;
    postMat.uniforms.tBloom.value = bloomRT.texture;
    postMat.uniforms.uRes.value.set(lowW, lowH);
    downMat.map = rt.texture; downMat.needsUpdate = true;
  }
  W.setPixelLook = function (o) { // {levels, dither, bloom, pixel, palette}
    if (!postMat) return;
    if (o.levels != null) postMat.uniforms.uLevels.value = o.levels;
    if (o.dither != null) postMat.uniforms.uDither.value = o.dither;
    if (o.bloom != null) postMat.uniforms.uBloom.value = o.bloom;
    if (o.pixel != null && o.pixel !== pixOverride) { pixOverride = o.pixel; setupPost(); }
    if (o.palette && o.palette !== paletteName) W.setGrassPalette(o.palette);
  };
  W.getPixelLook = () => postMat ? { levels: postMat.uniforms.uLevels.value, dither: postMat.uniforms.uDither.value, bloom: postMat.uniforms.uBloom.value, pixel: pixOverride || Math.max(2, Math.round(window.innerWidth / PIX_TARGET)), palette: paletteName } : null;

  /* ---------- init ---------- */
  W.init = function (canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x0c0e12);
    scene.fog = new THREE.FogExp2(0x0c0e12, 0.035);
    camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
    clock = new THREE.Clock();

    hemi = new THREE.HemisphereLight(0x8fb36a, 0x0a1206, 0.35); scene.add(hemi);
    spot = new THREE.SpotLight(0xfff2d6, 1.6, 60, 0.55, 0.7, 1.2); spot.position.set(2, 18, 3); spot.target.position.set(0, 0, 0);
    scene.add(spot); scene.add(spot.target);
    fillLight = new THREE.DirectionalLight(0x6a8cff, 0.15); fillLight.position.set(-6, 4, -8); scene.add(fillLight);

    ground = new THREE.Mesh(new THREE.CircleGeometry(R * 1.05, 48), new THREE.MeshStandardMaterial({ color: 0x0a1608, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);

    scene.add(makeGrass(15000));
    W.setGrassPalette(paletteName);
    scene.add(makeFlowers(650));
    const rocks = [[1.25, 0.5, -0.4], [0.8, -1.6, 0.6], [0.6, 1.9, 1.8], [0.7, -2.4, -3.1], [0.45, 3.4, -0.6], [0.4, -0.4, 2.9], [0.35, 2.6, 3.4]];
    rocks.forEach(([s, x, z]) => scene.add(makeRock(s, x, z)));
    W.oak = makeSnag(-2.1, -2.3, 1.7, false); scene.add(W.oak);
    scene.add(makeSnag(5.2, 1.4, 1.3, true));
    scene.add(makeSnag(-5.4, 2.6, 0.9, true));
    scene.add(makeSnag(3.6, -4.6, 0.8, true));
    scene.add(makeRain(2200));
    makeSky();
    setupPost();

    window.addEventListener('resize', onResize);
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; });
    window.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      cam.theta -= dx * 0.005; cam.phi = Math.max(0.3, Math.min(1.35, cam.phi - dy * 0.004));
    });
    window.addEventListener('pointerup', e => {
      if (drag && drag.moved < 4) W.click(e.clientX, e.clientY);
      drag = null;
    });
    canvas.addEventListener('wheel', e => { cam.radius = Math.max(6, Math.min(28, cam.radius + e.deltaY * 0.01)); }, { passive: true });
  };
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    setupPost();
  }
  W.click = function (x, y) {
    const v = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(v, camera);
    const hits = raycaster.intersectObjects(creatures.map(c => c.hit));
    const c = hits.length ? hits[0].object.userData.creature : null;
    cam.follow = (c && cam.follow !== c) ? c : null;
    if (W.onFollow) W.onFollow(cam.follow);
  };
  W.setAutoOrbit = v => { cam.auto = v; };
  W.getAutoOrbit = () => cam.auto;

  /* ---------- atmosphere ---------- */
  const lightCol = new THREE.Color(), tmpC = new THREE.Color();
  W.setAtmosphere = function (a) {
    // a: {hour, mood, rainAmount, wind, brightness, day?, dusk?, snow?}
    const h = a.hour;
    const day = a.day != null ? a.day : Math.max(0, Math.min(1, 1 - Math.abs(h - 13) / 7.5));
    const dusk = a.dusk != null ? a.dusk : Math.exp(-Math.pow((h - 19.5) / 1.6, 2)) + Math.exp(-Math.pow((h - 6.2) / 1.4, 2));
    if (!!a.snow !== snowMode) { snowMode = !!a.snow; rain.material.color.setHex(snowMode ? 0xf4f6ff : 0xcdd8c6); }
    lightCol.setRGB(0.55, 0.62, 0.95).lerp(tmpC.setRGB(1, 0.95, 0.85), day);
    lightCol.lerp(tmpC.setRGB(1, 0.62, 0.32), Math.min(1, dusk) * 0.7);
    if (a.mood === 'dusk') lightCol.lerp(tmpC.setRGB(1, 0.55, 0.25), 0.6);
    if (a.mood === 'night') lightCol.lerp(tmpC.setRGB(0.4, 0.5, 1), 0.7);
    // moonlight: a cool fill on clear nights, scaled by how much of the moon is lit
    const moonlight = (1 - day) * (a.moon || 0) * (1 - a.rainAmount) * (a.fog ? 0.3 : 1);
    const bright = (0.45 + 1.2 * day + 0.25 * moonlight) * (a.mood === 'night' ? 0.55 : 1) * (1 - a.rainAmount * 0.35) * (a.brightness || 1);
    spot.color.copy(lightCol); spot.intensity = bright * 1.6;
    hemi.intensity = 0.15 + 0.3 * day + 0.12 * moonlight;
    grassMat.uniforms.uLight.value.copy(lightCol);
    grassMat.uniforms.uAmb.value = 0.14 + 0.34 * bright;
    grassMat.uniforms.uWind.value = 0.35 + a.wind * 1.6;
    fillLight.intensity = (a.mood === 'night' ? 0.4 : 0.15) + 0.5 * moonlight;
    rainCount = Math.floor(2200 * a.rainAmount);
    rain.geometry.setDrawRange(0, rainCount);
    rain.material.opacity = 0.22 + 0.25 * a.rainAmount;
  };

  /* ---------- frame ---------- */
  let lastDt = 0.016;
  W.update = function () {
    const dt = Math.min(0.05, clock.getDelta());
    lastDt = dt;
    const t = clock.elapsedTime;
    grassMat.uniforms.uTime.value = t;
    applyFlowers(dt);
    animateFireflies(t);
    // rain
    if (rainCount > 0) {
      const fall = (snowMode ? 1.6 : 9) * dt, drift = snowMode ? Math.sin(t * 0.7) * 0.5 * dt : dt * 0.6;
      for (let i = 0; i < rainCount; i++) {
        const k = i * 6; rainPos[k + 1] -= fall; rainPos[k + 4] -= fall;
        rainPos[k] += drift; rainPos[k + 3] += drift;
        if (snowMode) { const w = Math.sin(t * 1.3 + i) * 0.3 * dt; rainPos[k + 2] += w; rainPos[k + 5] += w; }
        if (rainPos[k + 1] < 0) resetDrop(i, false);
      }
      rain.geometry.attributes.position.needsUpdate = true;
    }
    // camera
    if (cam.auto && !drag) cam.theta += dt * 0.035;
    const want = cam.follow ? cam.follow.group.position : tmpP.set(0, 0, 0);
    cam.target.lerp(want, 0.03);
    const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
    camera.position.set(cam.target.x + cam.radius * sp * Math.cos(cam.theta), cam.target.y + cam.radius * cp + 0.5, cam.target.z + cam.radius * sp * Math.sin(cam.theta));
    camera.lookAt(cam.target.x, cam.target.y + 0.3, cam.target.z);
    camera.getWorldDirection(camDir);
    camRight.crossVectors(camDir, camera.up).normalize();
    // three passes: scene → low-res, low-res → tiny bloom, both → screen with palette + dither
    renderer.setRenderTarget(rt); renderer.render(scene, camera);
    quad.material = downMat; renderer.setRenderTarget(bloomRT); renderer.render(postScene, postCam);
    quad.material = postMat; renderer.setRenderTarget(null); renderer.render(postScene, postCam);
    return dt;
  };
  W.creatures = creatures;
  W.R = R;
  W.oakTop = () => { const o = W.oak; return new THREE.Vector3(o.position.x, 2.2, o.position.z); };
  W.camera = () => camera;
  W.screenPos = function (p) { const v = p.clone().project(camera); return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight }; };
  W.pan = function (x, z) { // -1..1 stereo pan relative to camera
    const v = new THREE.Vector3(x, 0, z).sub(camera.position);
    return Math.max(-1, Math.min(1, v.normalize().dot(camRight)));
  };
  window.World = W;
})();
