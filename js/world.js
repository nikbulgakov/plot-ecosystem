/* Three.js scene drawn like a 16-bit game: rendered to a low-res target, palette-quantised with an ordered dither,
   a faint bloom on top, creatures as low-poly membranes with a luminous rim and trailing threads. */
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
    fireflies = new THREE.Points(fg, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
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

  /* ---------- creatures: low-poly membranes with a luminous rim, glowing eye spots and trailing threads ---------- */
  const rimVert = `varying vec3 vN, vP; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vP = mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`;
  const rimFrag = `uniform vec3 uRim, uInner; uniform float uAlpha, uPulse; varying vec3 vN, vP;
    void main(){
      vec3 n = normalize(vN); vec3 v = normalize(-vP);
      float f = pow(1.0 - max(0.0, dot(n, v)), 1.6);
      float glow = clamp(f * uPulse, 0.0, 1.0);
      gl_FragColor = vec4(mix(uInner, uRim, glow), mix(uAlpha, 1.0, glow));
    }`;
  function membrane(rim, inner, alpha) {
    return new THREE.ShaderMaterial({ uniforms: { uRim: { value: new THREE.Color(rim) }, uInner: { value: new THREE.Color(inner) }, uAlpha: { value: Math.min(1, alpha + 0.2) }, uPulse: { value: 1.6 } },
      vertexShader: rimVert, fragmentShader: rimFrag, transparent: true, depthWrite: true, side: THREE.DoubleSide });
  }
  const EYE = 0xffcd78;
  const flat = geo => { const g = geo.toNonIndexed(); g.computeVertexNormals(); return g; };
  // every body part gets a dark back-face shell: the one-pixel outline that keeps a creature legible on grass
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0x0a0c12, side: THREE.BackSide, toneMapped: false });
  function part(geo, mat, x, y, z, sx, sy, sz, rx, ry, rz, noOutline) {
    const m = new THREE.Mesh(flat(geo), mat);
    m.position.set(x || 0, y || 0, z || 0); m.scale.set(sx || 1, sy || 1, sz || 1); m.rotation.set(rx || 0, ry || 0, rz || 0);
    if (!noOutline && mat !== eyeMat && mat !== bandMat) { const o = new THREE.Mesh(m.geometry, outlineMat); o.scale.setScalar(1.14); m.add(o); }
    return m;
  }
  function leg(g, mat, x, y, z, h, r) { // a pivot at the hip so the leg can swing
    const p = new THREE.Group(); p.position.set(x, y, z);
    p.add(part(new THREE.CylinderGeometry(r * 0.7, r, h, 5, 1), mat, 0, -h / 2, 0));
    g.add(p); return p;
  }
  function eye(g, x, y, z, r) { const m = part(new THREE.SphereGeometry(r || 0.05, 5, 4), eyeMat, x, y, z); g.add(m); return m; }
  const eyeMat = new THREE.MeshBasicMaterial({ color: EYE, toneMapped: false });
  const bandMat = new THREE.MeshBasicMaterial({ color: 0xcdf2ec, transparent: true, opacity: 0.85, toneMapped: false });
  // a thread: a line of segments from an anchor, sagging and swaying in the creature's own space
  function thread(g, anchor, dir, len, droop, color) {
    const segs = 6, pts = new Float32Array((segs + 1) * 3);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, toneMapped: false }));
    line.frustumCulled = false; g.add(line);
    return { line, pts, segs, anchor: new THREE.Vector3(anchor[0], anchor[1], anchor[2]), dir: new THREE.Vector3(dir[0], dir[1], dir[2]).normalize(), len, droop, phase: Math.random() * 6, bead: null };
  }
  function animThread(th, t, sag, flutter) {
    const p = th.pts, n = th.segs;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      p[i * 3] = th.anchor.x + th.dir.x * k * th.len + Math.sin(t * 2.2 + k * 4 + th.phase) * 0.06 * k * flutter;
      p[i * 3 + 1] = th.anchor.y + th.dir.y * k * th.len - th.droop * sag * k * k * th.len + Math.sin(t * 1.7 + k * 3 + th.phase) * 0.04 * k;
      p[i * 3 + 2] = th.anchor.z + th.dir.z * k * th.len + Math.cos(t * 1.9 + k * 3.5 + th.phase) * 0.06 * k * flutter;
    }
    th.line.geometry.attributes.position.needsUpdate = true;
    if (th.bead) th.bead.position.set(p[n * 3], p[n * 3 + 1], p[n * 3 + 2]);
  }
  // species: rim / inner colours, body translucency, and a builder (forward is +X, feet at y = 0)
  const SPECIES3D = {
    badger: { rim: 0x9fe8dd, inner: 0x0f1e22, alpha: 0.55, build(g, m) {
      const body = part(new THREE.SphereGeometry(0.5, 8, 6), m, 0, 0.36, 0, 1.3, 0.62, 0.8); g.add(body);
      g.add(part(new THREE.SphereGeometry(0.28, 7, 5), m, 0.66, 0.4, 0, 1.15, 0.8, 0.9));
      g.add(part(new THREE.BoxGeometry(0.34, 0.05, 0.05), bandMat, 0.72, 0.5, 0.15)); g.add(part(new THREE.BoxGeometry(0.34, 0.05, 0.05), bandMat, 0.72, 0.5, -0.15));
      eye(g, 0.9, 0.44, 0.13); eye(g, 0.9, 0.44, -0.13);
      const legs = [leg(g, m, 0.38, 0.28, 0.26, 0.3, 0.07), leg(g, m, 0.38, 0.28, -0.26, 0.3, 0.07), leg(g, m, -0.38, 0.28, 0.26, 0.3, 0.07), leg(g, m, -0.38, 0.28, -0.26, 0.3, 0.07)];
      const threads = [thread(g, [-0.62, 0.4, 0], [-1, 0.15, 0], 0.75, 0.5, 0x9fe8dd), thread(g, [-0.6, 0.36, 0.12], [-1, 0.05, 0.25], 0.6, 0.5, 0x9fe8dd), thread(g, [-0.6, 0.36, -0.12], [-1, 0.05, -0.25], 0.6, 0.5, 0x9fe8dd)];
      return { body, legs, threads, gait: 'walk' };
    } },
    toad: { rim: 0xa8f0d0, inner: 0x12241c, alpha: 0.55, build(g, m) {
      const body = part(new THREE.SphereGeometry(0.5, 8, 6), m, 0, 0.26, 0, 0.95, 0.55, 0.85); g.add(body);
      g.add(part(new THREE.SphereGeometry(0.13, 6, 5), m, 0.28, 0.5, 0.2)); g.add(part(new THREE.SphereGeometry(0.13, 6, 5), m, 0.28, 0.5, -0.2));
      eye(g, 0.36, 0.55, 0.2, 0.06); eye(g, 0.36, 0.55, -0.2, 0.06);
      [[0.32, 0.35], [0.32, -0.35], [-0.3, 0.38], [-0.3, -0.38]].forEach(([x, z]) => g.add(part(new THREE.SphereGeometry(0.1, 5, 4), m, x, 0.08, z, 1.3, 0.7, 1)));
      return { body, legs: [], threads: [], gait: 'hop' };
    } },
    vole: { rim: 0xbfe8dd, inner: 0x1a1c22, alpha: 0.5, build(g, m) {
      const body = part(new THREE.SphereGeometry(0.5, 7, 5), m, 0, 0.22, 0, 0.7, 0.42, 0.46); g.add(body);
      g.add(part(new THREE.SphereGeometry(0.17, 6, 5), m, 0.42, 0.26, 0));
      g.add(part(new THREE.SphereGeometry(0.06, 5, 4), m, 0.4, 0.42, 0.1)); g.add(part(new THREE.SphereGeometry(0.06, 5, 4), m, 0.4, 0.42, -0.1));
      eye(g, 0.56, 0.3, 0.08, 0.04); eye(g, 0.56, 0.3, -0.08, 0.04);
      const legs = [leg(g, m, 0.2, 0.16, 0.14, 0.16, 0.04), leg(g, m, 0.2, 0.16, -0.14, 0.16, 0.04), leg(g, m, -0.2, 0.16, 0.14, 0.16, 0.04), leg(g, m, -0.2, 0.16, -0.14, 0.16, 0.04)];
      const tail = thread(g, [-0.34, 0.22, 0], [-1, 0.2, 0], 0.6, 0.6, 0xbfe8dd); tail.bead = eye(g, 0, 0, 0, 0.045);
      return { body, legs, threads: [tail], gait: 'walk' };
    } },
    beetle: { rim: 0xb8a6ff, inner: 0x0a0a16, alpha: 0.8, build(g, m) {
      const body = part(new THREE.SphereGeometry(0.5, 7, 5), m, 0, 0.14, 0, 0.5, 0.3, 0.45); g.add(body);
      g.add(part(new THREE.BoxGeometry(0.4, 0.03, 0.03), bandMat, -0.02, 0.29, 0));
      const threads = [thread(g, [0.22, 0.2, 0.06], [0.7, 0.9, 0.3], 0.35, 0, 0xb8a6ff), thread(g, [0.22, 0.2, -0.06], [0.7, 0.9, -0.3], 0.35, 0, 0xb8a6ff)];
      const legs = [leg(g, m, 0.12, 0.1, 0.16, 0.1, 0.025), leg(g, m, 0.12, 0.1, -0.16, 0.1, 0.025), leg(g, m, -0.12, 0.1, 0.16, 0.1, 0.025), leg(g, m, -0.12, 0.1, -0.16, 0.1, 0.025)];
      return { body, legs, threads, gait: 'walk' };
    } },
    moth: { rim: 0xf0ecf8, inner: 0x2a2a3a, alpha: 0.4, build(g, m) {
      const body = part(new THREE.SphereGeometry(0.5, 6, 5), m, 0, 0.5, 0, 0.5, 0.16, 0.16); g.add(body);
      eye(g, 0.22, 0.52, 0, 0.05);
      const wings = [];
      [1, -1].forEach(s => { const p = new THREE.Group(); p.position.set(0, 0.55, s * 0.05); p.add(part(new THREE.PlaneGeometry(0.5, 0.36), m, 0, 0, s * 0.2, 1, 1, 1, -Math.PI / 2, 0, 0, true)); g.add(p); wings.push(p); });
      const threads = [thread(g, [0.24, 0.55, 0.03], [0.8, 0.8, 0.2], 0.25, 0, 0xf0ecf8), thread(g, [0.24, 0.55, -0.03], [0.8, 0.8, -0.2], 0.25, 0, 0xf0ecf8)];
      return { body, legs: [], threads, wings, gait: 'fly' };
    } },
    wren: { rim: 0xd8e8c8, inner: 0x1a2018, alpha: 0.5, build(g, m) {
      const body = part(new THREE.SphereGeometry(0.5, 7, 5), m, 0, 0.3, 0, 0.56, 0.44, 0.42); g.add(body);
      g.add(part(new THREE.SphereGeometry(0.17, 6, 5), m, 0.3, 0.44, 0));
      g.add(part(new THREE.ConeGeometry(0.05, 0.16, 4), eyeMat, 0.5, 0.42, 0, 1, 1, 1, 0, 0, -Math.PI / 2));
      eye(g, 0.4, 0.5, 0.09, 0.04); eye(g, 0.4, 0.5, -0.09, 0.04);
      g.add(part(new THREE.BoxGeometry(0.28, 0.03, 0.12), m, -0.34, 0.42, 0, 1, 1, 1, 0, 0, 0.55));
      const legs = [leg(g, m, 0.05, 0.14, 0.08, 0.14, 0.02), leg(g, m, 0.05, 0.14, -0.08, 0.14, 0.02)];
      const threads = [thread(g, [-0.46, 0.5, 0], [-1, 0.3, 0], 0.45, 0.4, 0xd8e8c8), thread(g, [-0.44, 0.48, 0.06], [-1, 0.2, 0.3], 0.4, 0.4, 0xd8e8c8), thread(g, [-0.44, 0.48, -0.06], [-1, 0.2, -0.3], 0.4, 0.4, 0xd8e8c8)];
      return { body, legs, threads, gait: 'hop' };
    } },
    nuthatch: { rim: 0x9fc4ff, inner: 0x101a2a, alpha: 0.5, build(g, m) {
      const body = part(new THREE.SphereGeometry(0.5, 7, 5), m, 0, 0.3, 0, 0.56, 0.4, 0.4); g.add(body);
      g.add(part(new THREE.SphereGeometry(0.16, 6, 5), m, 0.3, 0.4, 0));
      g.add(part(new THREE.ConeGeometry(0.04, 0.16, 4), eyeMat, 0.48, 0.38, 0, 1, 1, 1, 0, 0, -Math.PI / 2));
      g.add(part(new THREE.BoxGeometry(0.3, 0.04, 0.04), bandMat, 0.3, 0.44, 0.08)); g.add(part(new THREE.BoxGeometry(0.3, 0.04, 0.04), bandMat, 0.3, 0.44, -0.08));
      eye(g, 0.4, 0.46, 0.08, 0.04); eye(g, 0.4, 0.46, -0.08, 0.04);
      const legs = [leg(g, m, 0.05, 0.14, 0.08, 0.14, 0.02), leg(g, m, 0.05, 0.14, -0.08, 0.14, 0.02)];
      const threads = [thread(g, [-0.1, 0.12, 0], [0, -1, 0], 0.5, 0, 0x9fc4ff)];
      return { body, legs, threads, gait: 'hop' };
    } },
    slug: { rim: 0xe0d0a8, inner: 0x2a2018, alpha: 0.55, build(g, m) {
      const body = part(new THREE.SphereGeometry(0.5, 7, 5), m, 0, 0.16, 0, 0.8, 0.3, 0.4); g.add(body);
      g.add(part(new THREE.BoxGeometry(0.5, 0.03, 0.03), bandMat, -0.05, 0.31, 0));
      const threads = [thread(g, [0.36, 0.26, 0.06], [0.7, 0.9, 0.2], 0.25, 0, 0xe0d0a8), thread(g, [0.36, 0.26, -0.06], [0.7, 0.9, -0.2], 0.25, 0, 0xe0d0a8)];
      return { body, legs: [], threads, gait: 'crawl' };
    } },
  };
  W.addCreature = function (spec) {
    const def = SPECIES3D[spec.sprite] || SPECIES3D.beetle;
    const g = new THREE.Group();
    const mat = membrane(def.rim, def.inner, def.alpha);
    const parts = def.build(g, mat);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.3; g.add(hit);
    g.scale.setScalar(spec.size || 1);
    scene.add(g);
    const c = { spec, group: g, mat, hit, parts, size: spec.size || 1, yaw: Math.random() * 6.28, yawTarget: 0, restT: 0, bob: Math.random() * 6, prev: new THREE.Vector3(1e9, 0, 0) };
    hit.userData.creature = c;
    creatures.push(c);
    return c;
  };
  W.removeCreature = function (c) {
    const i = creatures.indexOf(c); if (i >= 0) creatures.splice(i, 1);
    scene.remove(c.group);
    c.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    c.mat.dispose();
    if (cam.follow === c) cam.follow = null;
  };
  W.updateCreature = function (c, x, y, z, state, scale) {
    const g = c.group, t = clock.elapsedTime, p = c.parts;
    // turn toward the way we move
    if (c.prev.x < 1e8) {
      const dx = x - c.prev.x, dz = z - c.prev.z;
      if (dx * dx + dz * dz > 1e-6) c.yawTarget = Math.atan2(-dz, dx);
    }
    c.prev.set(x, y, z);
    let d = c.yawTarget - c.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    c.yaw += d * Math.min(1, lastDt * 8);
    g.rotation.y = c.yaw;
    g.position.set(x, y - 0.22, z);
    g.scale.setScalar(c.size * (scale != null ? scale : 1));
    // state → tempo, glow, posture
    c.restT = state === 'rest' ? c.restT + lastDt : 0;
    const asleep = state === 'rest' && c.restT > 1.5;
    const moving = state === 'wander' || state === 'flee';
    const f = state === 'flee' ? 13 : state === 'wander' ? 6.5 : state === 'act' ? 3 : 0;
    const m = moving ? 1 : state === 'act' ? 0.5 : 0;
    const pulse = (asleep ? 0.7 : state === 'alert' || state === 'flee' ? 3.0 : 1.6) * (0.85 + 0.15 * Math.sin(t * 1.5 + c.bob));
    c.mat.uniforms.uPulse.value = pulse;
    const squash = asleep ? 0.8 : 1;
    p.body.scale.y = (p.bodyScaleY || (p.bodyScaleY = p.body.scale.y)) * squash;
    // gait
    const ph = t * f + c.bob;
    p.legs.forEach((l, i) => { l.rotation.z = Math.sin(ph + (i % 2) * Math.PI + (i > 1 ? Math.PI : 0)) * 0.6 * m; });
    let lift = 0;
    if (p.gait === 'walk') lift = Math.abs(Math.sin(ph)) * 0.04 * m;
    else if (p.gait === 'hop') lift = Math.max(0, Math.sin(ph * 0.5)) * 0.22 * m;
    else if (p.gait === 'crawl') p.body.scale.x = (p.bodyScaleX || (p.bodyScaleX = p.body.scale.x)) * (1 + Math.sin(ph) * 0.12 * m);
    else if (p.gait === 'fly') { lift = 0.06 + Math.sin(t * 2 + c.bob) * 0.06; p.wings.forEach((w, i) => { w.rotation.x = Math.sin(t * (moving ? 16 : 5) + c.bob) * 0.9 * (i ? -1 : 1); }); }
    g.position.y += lift;
    // threads sag at rest, stream out at speed, snap straight when alarmed
    const sag = state === 'alert' || state === 'flee' ? 0.1 : asleep ? 1.4 : 1;
    const flutter = 0.5 + m * 1.5;
    p.threads.forEach(th => animThread(th, t, sag, flutter));
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
