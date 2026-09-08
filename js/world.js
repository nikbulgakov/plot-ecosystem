/* Three.js scene: a small circular plot of grass with rocks, dead branches, flowers, rain and creatures. */
(function () {
  const W = {};
  const R = 9.5;                 // plot radius
  let renderer, scene, camera, clock;
  let grassMat, rain, rainPos, rainCount = 0, spot, hemi, fillLight;
  let cam = { theta: 0.6, phi: 0.72, radius: 21, auto: true, target: new THREE.Vector3(0, 0, 0), follow: null };
  let drag = null;
  const creatures = [];
  const raycaster = new THREE.Raycaster();
  const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* ---------- grass ---------- */
  function makeGrass(count) {
    const geo = new THREE.PlaneGeometry(0.07, 0.45, 1, 4);
    geo.translate(0, 0.225, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) { // taper
      const y = pos.getY(i) / 0.45;
      pos.setX(i, pos.getX(i) * (1 - y * 0.85));
      pos.setZ(i, Math.sin(y * 1.4) * 0.05);
    }
    grassMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uWind: { value: 0.5 }, uRadius: { value: R }, uLight: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: 0.45 } },
      vertexShader: `
        uniform float uTime, uWind, uRadius;
        varying float vH, vFade; varying vec3 vCol;
        void main(){
          vec3 ipos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float h = uv.y;
          vec3 p = position;
          float g = sin(uTime*1.1 + ipos.x*0.7 + ipos.z*0.5)*0.6 + sin(uTime*2.3 + ipos.z*1.9 + ipos.x*0.3)*0.25 + sin(uTime*4.1+ipos.x*3.0)*0.08;
          p.x += g * h*h * uWind * 0.35;
          p.z += cos(uTime*0.8 + ipos.x*1.3 + ipos.z*0.4)*0.18*h*h*uWind;
          vec4 wp = instanceMatrix * vec4(p,1.0);
          vH = h;
          float d = length(ipos.xz);
          vFade = 1.0 - smoothstep(uRadius*0.42, uRadius*0.98, d);
          vCol = instanceColor;
          gl_Position = projectionMatrix * modelViewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 uLight; uniform float uAmb;
        varying float vH, vFade; varying vec3 vCol;
        void main(){
          vec3 c = vCol * mix(0.18, 1.15, pow(vH,1.4));
          c *= uLight * (uAmb + 0.75 * vFade);
          c *= vFade;
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geo, grassMat, count);
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(Math.random()) * R * 0.98, a = Math.random() * Math.PI * 2;
      tmpP.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      tmpQ.setFromEuler(new THREE.Euler(rnd(-0.25, 0.25), Math.random() * Math.PI * 2, rnd(-0.25, 0.25)));
      const s = rnd(0.55, 1.35);
      tmpS.set(s, s * rnd(0.7, 1.5), s);
      tmpM.compose(tmpP, tmpQ, tmpS);
      mesh.setMatrixAt(i, tmpM);
      const hue = 0.23 + Math.random() * 0.07, sat = 0.45 + Math.random() * 0.3, lig = 0.2 + Math.random() * 0.17;
      col.setHSL(hue, sat, lig);
      if (Math.random() < 0.06) col.setHSL(0.14, 0.4, 0.36); // dry blades
      mesh.setColorAt(i, col);
    }
    mesh.frustumCulled = false;
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
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xa8716d, roughness: 1, metalness: 0, flatShading: false }));
    m.position.set(x, size * 0.2, z);
    m.rotation.set(rnd(0, 0.4), rnd(0, 6.28), rnd(0, 0.3));
    m.castShadow = true;
    return m;
  }

  /* ---------- dead branches ---------- */
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8f8a80, roughness: 0.95 });
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
    branch(g, new THREE.Vector3(0, -0.1, 0), dir, 1.4 * scale, 0.065 * scale, 3);
    g.position.set(x, 0, z);
    g.userData.top = new THREE.Vector3(0, 1.6 * scale, 0);
    return g;
  }

  /* ---------- flowers & stalks ---------- */
  function makeFlowers(count) {
    const palette = [0xff7a1c, 0xfff1cf, 0xff4da6, 0xffd23f, 0xffffff, 0xff9c5b, 0xffe7a3, 0xd9ff7a];
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffffff }), count);
    const stems = new Float32Array(count * 6);
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(Math.random()) * R * 0.95, a = Math.random() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r, h = rnd(0.35, 0.95);
      const lean = rnd(0.05, 0.3), la = rnd(0, 6.28);
      const hx = x + Math.cos(la) * lean, hz = z + Math.sin(la) * lean;
      tmpM.compose(new THREE.Vector3(hx, h, hz), tmpQ.set(0, 0, 0, 1), tmpS.set(1, 1, 1).multiplyScalar(rnd(0.6, 1.4)));
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
    return g;
  }

  /* ---------- rain ---------- */
  function makeRain(max) {
    rainPos = new Float32Array(max * 6);
    for (let i = 0; i < max; i++) resetDrop(i, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xcdd8c6, transparent: true, opacity: 0.35 }));
    rain.frustumCulled = false;
    rain.geometry.setDrawRange(0, 0);
    return rain;
  }
  function resetDrop(i, randomY) {
    const x = rnd(-22, 22), z = rnd(-22, 22), y = randomY ? rnd(0, 14) : rnd(12, 15), l = rnd(0.25, 0.6);
    rainPos.set([x, y, z, x + 0.03, y + l, z + 0.02], i * 6);
  }

  /* ---------- creatures ---------- */
  const SHAPES = {
    cube: () => new THREE.BoxGeometry(0.5, 0.5, 0.5),
    pyramid: () => new THREE.ConeGeometry(0.34, 0.6, 4),
    cone: () => new THREE.ConeGeometry(0.28, 0.6, 3),
    octa: () => new THREE.OctahedronGeometry(0.34),
    ring: () => new THREE.TorusGeometry(0.22, 0.05, 4, 10),
    diamond: () => new THREE.OctahedronGeometry(0.3).scale(0.7, 1.3, 0.7),
    tetra: () => new THREE.TetrahedronGeometry(0.34),
  };
  // bold wireframe: every edge of the shape becomes a thin cylinder drawn on top of the scene
  function outline(geo, color, thick) {
    const e = new THREE.EdgesGeometry(geo, 1).attributes.position;
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
    const g = new THREE.Group();
    const up = new THREE.Vector3(0, 1, 0), a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i < e.count; i += 2) {
      a.set(e.getX(i), e.getY(i), e.getZ(i)); b.set(e.getX(i + 1), e.getY(i + 1), e.getZ(i + 1));
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(thick, thick, len, 4, 1), mat);
      m.position.copy(a).lerp(b, 0.5);
      m.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
      g.add(m);
    }
    g.renderOrder = 10;
    return { group: g, mat };
  }
  W.addCreature = function (spec) {
    const g = new THREE.Group();
    const geo = (SHAPES[spec.shape] || SHAPES.cube)();
    const ol = outline(geo, spec.color, 0.03);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 6), new THREE.MeshBasicMaterial({ color: spec.dot || 0xffffff, depthTest: false, toneMapped: false }));
    dot.renderOrder = 11;
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), new THREE.MeshBasicMaterial({ visible: false }));
    g.add(ol.group); g.add(dot); g.add(hit);
    g.scale.setScalar((spec.size || 1) * 1.7);
    scene.add(g);
    const edges = { material: ol.mat };
    // trail
    const N = 140;
    const tp = new Float32Array(N * 3);
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(tp, 3));
    tg.setDrawRange(0, 0);
    const trail = new THREE.Points(tg, new THREE.PointsMaterial({ color: spec.trail || 0xff2a3c, size: 0.14, sizeAttenuation: true, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }));
    trail.frustumCulled = false; trail.renderOrder = 9;
    scene.add(trail);
    const c = { spec, group: g, edges, dot, hit, trail, tp, tn: 0, tN: N, lastTrail: new THREE.Vector3(1e9, 0, 0), spin: rnd(0.2, 0.8), bob: Math.random() * 6 };
    hit.userData.creature = c;
    creatures.push(c);
    return c;
  };
  W.updateCreature = function (c, x, y, z, state) {
    const g = c.group;
    g.position.set(x, y, z);
    if (c.lastTrail.distanceTo(g.position) > 0.22) {
      c.lastTrail.copy(g.position);
      const i = c.tn % c.tN;
      c.tp.set([x, Math.max(0.3, y - 0.25), z], i * 3);
      c.tn++;
      c.trail.geometry.attributes.position.needsUpdate = true;
      c.trail.geometry.setDrawRange(0, Math.min(c.tn, c.tN));
    }
    const t = clock.elapsedTime;
    const speed = state === 'alert' || state === 'flee' ? 3 : state === 'rest' ? 0.2 : 1;
    g.rotation.y += c.spin * speed * 0.016;
    g.rotation.x = Math.sin(t * 0.7 + c.bob) * 0.15;
    c.dot.position.y = Math.sin(t * 2.4 * speed + c.bob) * 0.05;
    c.edges.material.opacity = state === 'rest' ? 0.5 : 0.95;
  };

  /* ---------- init ---------- */
  W.init = function (canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.9;
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.FogExp2(0x000000, 0.035);
    camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
    clock = new THREE.Clock();

    hemi = new THREE.HemisphereLight(0x8fb36a, 0x0a1206, 0.35); scene.add(hemi);
    spot = new THREE.SpotLight(0xfff2d6, 1.6, 60, 0.55, 0.7, 1.2); spot.position.set(2, 18, 3); spot.target.position.set(0, 0, 0);
    scene.add(spot); scene.add(spot.target);
    fillLight = new THREE.DirectionalLight(0x6a8cff, 0.15); fillLight.position.set(-6, 4, -8); scene.add(fillLight);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(R * 1.05, 48), new THREE.MeshStandardMaterial({ color: 0x07120a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);

    scene.add(makeGrass(38000));
    scene.add(makeFlowers(650));
    const rocks = [[1.25, 0.5, -0.4], [0.8, -1.6, 0.6], [0.6, 1.9, 1.8], [0.7, -2.4, -3.1], [0.45, 3.4, -0.6], [0.4, -0.4, 2.9], [0.35, 2.6, 3.4]];
    rocks.forEach(([s, x, z]) => scene.add(makeRock(s, x, z)));
    W.oak = makeSnag(-2.1, -2.3, 1.7, false); scene.add(W.oak);
    scene.add(makeSnag(5.2, 1.4, 1.3, true));
    scene.add(makeSnag(-5.4, 2.6, 0.9, true));
    scene.add(makeSnag(3.6, -4.6, 0.8, true));
    scene.add(makeRain(2200));

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
    // a: {hour, mood, rainAmount, wind, brightness}
    const h = a.hour;
    const day = Math.max(0, Math.min(1, 1 - Math.abs(h - 13) / 7.5)); // 1 at 13:00, 0 before 5:30 / after 20:30
    const dusk = Math.exp(-Math.pow((h - 19.5) / 1.6, 2)) + Math.exp(-Math.pow((h - 6.2) / 1.4, 2));
    lightCol.setRGB(0.55, 0.62, 0.95).lerp(tmpC.setRGB(1, 0.95, 0.85), day);
    lightCol.lerp(tmpC.setRGB(1, 0.62, 0.32), Math.min(1, dusk) * 0.7);
    if (a.mood === 'dusk') lightCol.lerp(tmpC.setRGB(1, 0.55, 0.25), 0.6);
    if (a.mood === 'night') lightCol.lerp(tmpC.setRGB(0.4, 0.5, 1), 0.7);
    const bright = (0.45 + 1.2 * day) * (a.mood === 'night' ? 0.55 : 1) * (1 - a.rainAmount * 0.35) * (a.brightness || 1);
    spot.color.copy(lightCol); spot.intensity = bright * 1.6;
    hemi.intensity = 0.15 + 0.3 * day;
    grassMat.uniforms.uLight.value.copy(lightCol);
    grassMat.uniforms.uAmb.value = 0.18 + 0.4 * bright;
    grassMat.uniforms.uWind.value = 0.35 + a.wind * 1.6;
    fillLight.intensity = a.mood === 'night' ? 0.4 : 0.15;
    rainCount = Math.floor(2200 * a.rainAmount);
    rain.geometry.setDrawRange(0, rainCount);
    rain.material.opacity = 0.18 + 0.2 * a.rainAmount;
  };

  /* ---------- frame ---------- */
  W.update = function () {
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    grassMat.uniforms.uTime.value = t;
    // rain
    if (rainCount > 0) {
      const fall = 9 * dt;
      for (let i = 0; i < rainCount; i++) {
        const k = i * 6; rainPos[k + 1] -= fall; rainPos[k + 4] -= fall;
        rainPos[k] += dt * 0.6; rainPos[k + 3] += dt * 0.6;
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
    renderer.render(scene, camera);
    return dt;
  };
  W.creatures = creatures;
  W.R = R;
  W.oakTop = () => { const o = W.oak; return new THREE.Vector3(o.position.x, 2.2, o.position.z); };
  W.camera = () => camera;
  W.screenPos = function (p) { const v = p.clone().project(camera); return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight }; };
  W.pan = function (x, z) { // -1..1 stereo pan relative to camera
    const v = new THREE.Vector3(x, 0, z).sub(camera.position);
    const right = new THREE.Vector3().crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).normalize();
    return Math.max(-1, Math.min(1, v.normalize().dot(right)));
  };
  window.World = W;
})();
