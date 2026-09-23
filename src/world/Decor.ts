import * as THREE from 'three';
import { Track, HALF_W } from '../track/Track';
import { F_GAP, F_LOOP, F_TUNNEL, makeFrame } from '../track/Path';
import { fogParsGLSL, globalUniforms, noiseGLSL } from '../shaders/common';
import { mulberry32, rrange } from '../core/util';
import { CityBuild } from './City';

export const decorUniforms = {
  uStartLights: { value: 0 }, // 0 = off, 1..3 = red count, 4 = green
};

// ---------------------------------------------------------------- ad textures
const ADS: { lines: string[]; colors: [string, string]; style: number; vertical?: boolean }[] = [
  { lines: ['NEON ZERO', 'GRAND PRIX'], colors: ['#3cf2ff', '#ff2fa8'], style: 0 },
  { lines: ['ZERO-G', 'COLA'], colors: ['#ff3a3a', '#ffffff'], style: 1 },
  { lines: ['KAIJU', 'ENERGY'], colors: ['#7dff3a', '#ffe23a'], style: 2 },
  { lines: ['ネオン', '未来都市'], colors: ['#ff49b8', '#3cf2ff'], style: 3, vertical: true },
  { lines: ['NEXUS', 'DYNAMICS'], colors: ['#8a7dff', '#3cf2ff'], style: 0 },
  { lines: ['HYPER', 'AIRWAYS'], colors: ['#ffb13a', '#ffffff'], style: 1 },
  { lines: ['速度', '無限'], colors: ['#3cf2ff', '#ffffff'], style: 3, vertical: true },
  { lines: ['SYNTH', 'NOODLE', 'BAR'], colors: ['#ff2fa8', '#ffcf3a'], style: 2 },
  { lines: ['VOLT', 'MOTORS'], colors: ['#3affc8', '#ff2fa8'], style: 0 },
  { lines: ['DRINK', 'THE STARS'], colors: ['#ffffff', '#8a7dff'], style: 1 },
];

function drawAd(ctx: CanvasRenderingContext2D, w: number, h: number, ad: (typeof ADS)[number], seed: number) {
  const r = mulberry32(seed);
  ctx.clearRect(0, 0, w, h);
  const [c1, c2] = ad.colors;
  ctx.save();
  // frame
  ctx.strokeStyle = c1;
  ctx.lineWidth = 6;
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = c1;
  ctx.fillRect(10, 10, w - 20, h - 20);
  ctx.globalAlpha = 1;
  // graphic
  if (ad.style === 0) {
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = i % 2 ? c1 : c2;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(w * 0.82, h * 0.5, 20 + i * 14, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (ad.style === 1) {
    ctx.fillStyle = c2;
    for (let i = 0; i < 12; i++) ctx.fillRect(w * 0.08 + i * (w * 0.07), h * 0.84, w * 0.04, -r() * h * 0.2);
  } else if (ad.style === 2) {
    ctx.strokeStyle = c2;
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h * 0.8 + Math.sin(x * 0.05) * 14);
    ctx.stroke();
  }
  // text
  const font = '"Orbitron", "Rajdhani", sans-serif';
  ctx.textBaseline = 'middle';
  if (ad.vertical) {
    ctx.textAlign = 'center';
    const chars = ad.lines.join('').split('');
    const size = Math.min(w * 0.7, (h - 40) / chars.length);
    ctx.font = `900 ${size}px ${font}`;
    chars.forEach((ch, i) => {
      ctx.fillStyle = i % 2 ? c2 : c1;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 18;
      ctx.fillText(ch, w / 2, 20 + size * (i + 0.5));
    });
  } else {
    ctx.textAlign = 'left';
    const n = ad.lines.length;
    const size = Math.min((h * 0.7) / n, 90);
    ad.lines.forEach((ln, i) => {
      ctx.font = `italic 900 ${size}px ${font}`;
      ctx.fillStyle = i === 0 ? c1 : c2;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 20;
      ctx.fillText(ln, 34, h / 2 + (i - (n - 1) / 2) * size * 1.05);
    });
  }
  ctx.restore();
}

function adTexture(i: number) {
  const ad = ADS[i % ADS.length];
  const canvas = document.createElement('canvas');
  canvas.width = ad.vertical ? 256 : 512;
  canvas.height = ad.vertical ? 768 : 256;
  const ctx = canvas.getContext('2d')!;
  const redraw = () => drawAd(ctx, canvas.width, canvas.height, ad, i * 17 + 3);
  redraw();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  document.fonts?.ready.then(() => {
    redraw();
    tex.needsUpdate = true;
  });
  return { tex, vertical: !!ad.vertical };
}

const holoMat = (tex: THREE.Texture, tint: THREE.Color, seed: number, intensity = 2.2) =>
  new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, map: { value: tex }, tint: { value: tint }, seed: { value: seed }, inten: { value: intensity } },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vWorld;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      ${noiseGLSL}
      uniform sampler2D map; uniform vec3 tint; uniform float seed; uniform float inten;
      varying vec2 vUv; varying vec3 vWorld;
      void main(){
        vec2 uv = vUv;
        float gt = floor(uTime * 9. + seed * 7.);
        float glitch = step(.93, hash11(gt + seed));
        float band = step(abs(fract(uv.y * 2.3 + hash11(gt) ) - .5), .08);
        uv.x += glitch * band * (hash11(gt * 1.7) - .5) * .12;
        float ca = .004 + glitch * .012;
        vec4 t0 = texture2D(map, uv);
        float r = texture2D(map, uv + vec2(ca, 0.)).r;
        float b = texture2D(map, uv - vec2(ca, 0.)).b;
        vec3 c = vec3(r, t0.g, b);
        float a = max(t0.a, .0);
        float scan = .72 + .28 * sin(uv.y * 520. - uTime * 14.);
        float roll = .85 + .15 * smoothstep(.0, .1, abs(fract(uv.y - uTime * .15) - .5));
        float flick = (.92 + .08 * sin(uTime * 31. + seed * 9.)) * (1. - glitch * .35);
        vec3 col = c * tint * scan * roll * flick * inten * a;
        // edge fade
        vec2 e = min(uv, 1. - uv);
        col *= smoothstep(0., .02, min(e.x, e.y));
        float dist = length(vWorld - uCamPos);
        col *= exp(-dist * uFogDensity * .6);
        gl_FragColor = vec4(col, 1.);
      }`,
  });

// ---------------------------------------------------------------- main builder
export function buildDecor(track: Track, city: CityBuild, scene: THREE.Scene) {
  const group = new THREE.Group();
  const rng = mulberry32(99);
  const updaters: ((dt: number, t: number) => void)[] = [];
  const ads = ADS.map((_, i) => adTexture(i));

  // ---- billboards on building faces
  const verticalAds = ads.filter((a) => a.vertical);
  city.hologramSpots.forEach((sp, i) => {
    const kyoto = sp.district === 'kyoto';
    const ad = kyoto ? verticalAds[i % verticalAds.length] : ads[i % ads.length];
    const w = kyoto ? sp.w : ad.vertical ? sp.w * 0.4 : sp.w;
    const hgt = kyoto ? sp.h : ad.vertical ? w * 3 : w * 0.5;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), holoMat(ad.tex, new THREE.Color(1, 1, 1), i * 1.37));
    m.position.copy(sp.pos);
    m.lookAt(sp.pos.clone().add(sp.normal));
    group.add(m);
  });

  // ---- free-floating holo billboards along the course, facing oncoming racers
  const f = makeFrame();
  const main = track.main;
  for (let s = 400; s < main.length - 200; s += 520) {
    const [i] = main.idx(s);
    if (main.flags[i] & (F_LOOP | F_GAP | F_TUNNEL)) continue;
    if (Math.abs(main.curlAt(s)) > 0.05) continue;
    main.sample(s, f);
    if (f.u.y < 0.9) continue;
    const side = rng() < 0.5 ? -1 : 1;
    const ad = ads[Math.floor(rng() * ads.length)];
    const w = ad.vertical ? 16 : 46;
    const hh = ad.vertical ? 48 : 23;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), holoMat(ad.tex, new THREE.Color(1, 1, 1), s));
    const pos = f.p.clone().addScaledVector(f.r, side * (HALF_W + 18 + w * 0.3)).addScaledVector(f.u, hh * 0.5 + 6);
    // keep clear of other parts of the course
    const ny = city.grid.minYNear(pos.x, pos.z, w / 2 + 4);
    if (ny < Infinity && Math.abs(ny - pos.y) < hh + 25) continue;
    m.position.copy(pos);
    // face back down the course, angled towards the road
    const look = pos.clone().addScaledVector(f.t, -100).addScaledVector(f.r, -side * 45);
    m.lookAt(look);
    group.add(m);
    // projector base glow
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(w * 0.45, 1.5, hh * 0.5 + 6, 16, 1, true),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: { ...globalUniforms },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
        fragmentShader: `uniform float uTime; varying vec2 vUv; void main(){ float a = pow(1. - vUv.y, 0.5) * vUv.y * .5 * (.8 + .2*sin(uTime*20.)); gl_FragColor = vec4(vec3(.3,.8,1.) * a * .35, 1.); }`,
      }),
    );
    beam.position.copy(f.p).addScaledVector(f.r, side * (HALF_W + 18 + w * 0.3)).addScaledVector(f.u, (hh * 0.5 + 6) / 2 - 3);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), f.u);
    beam.scale.y = -1;
    group.add(beam);
  }

  // ---- energy pit sign hanging over the pit lane
  for (const z of track.pitZones) {
    const path = track.paths[z.path];
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 256;
    const cx = cv.getContext('2d')!;
    const draw = () => {
      cx.clearRect(0, 0, 512, 256);
      cx.strokeStyle = '#ff2fa8';
      cx.lineWidth = 8;
      cx.strokeRect(12, 12, 488, 232);
      cx.fillStyle = 'rgba(255,47,168,0.18)';
      cx.fillRect(12, 12, 488, 232);
      cx.fillStyle = '#ffffff';
      cx.shadowColor = '#ff2fa8';
      cx.shadowBlur = 24;
      cx.fillRect(58, 108, 96, 28);
      cx.fillRect(92, 74, 28, 96);
      cx.font = 'italic 900 58px "Orbitron", sans-serif';
      cx.textBaseline = 'middle';
      cx.fillText('ENERGY', 186, 96);
      cx.fillStyle = '#ffb3e0';
      cx.fillText('PIT ▼', 186, 170);
    };
    draw();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    document.fonts?.ready.then(() => {
      draw();
      tex.needsUpdate = true;
    });
    for (const sAt of [z.s0 - 6, (z.s0 + z.s1) / 2]) {
      path.sample(sAt, f);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(22, 11), holoMat(tex, new THREE.Color(1, 1, 1), sAt, 3));
      sign.position.copy(f.p).addScaledVector(f.r, (z.x0 + z.x1) / 2).addScaledVector(f.u, 13);
      sign.lookAt(sign.position.clone().addScaledVector(f.t, -10));
      group.add(sign);
    }
  }

  // ---- arches (checkpoints) & start gate
  group.add(buildArches(track));
  group.add(buildStartGate(track, ads[0].tex));

  // ---- hologram dragon around the megatower
  const tower = track.towers[0].pos;
  group.add(buildDragon(new THREE.Vector3(tower.x, 0, tower.z)));

  // ---- holo globe above downtown
  main.sample(main.markers.db0 + 700, f);
  const globePos = f.p.clone().add(new THREE.Vector3(-350, 220, -450));
  group.add(buildGlobe(globePos, 90));

  // ---- rooftop holo sculptures
  for (let k = 0; k < 26; k++) {
    const sp = city.roofSpots[Math.floor(rng() * city.roofSpots.length)];
    if (!sp) break;
    const size = rrange(rng, 8, 18);
    const geo = [new THREE.IcosahedronGeometry(size, 0), new THREE.TorusKnotGeometry(size * 0.6, size * 0.12, 64, 8), new THREE.OctahedronGeometry(size, 0), new THREE.TorusGeometry(size, size * 0.1, 8, 40)][k % 4];
    const m = new THREE.Mesh(geo, wireHoloMat(new THREE.Color().setHSL(rng(), 0.9, 0.6), k));
    m.position.copy(sp).add(new THREE.Vector3(0, size * 1.6, 0));
    const spd = rrange(rng, 0.2, 0.6);
    updaters.push((dt) => {
      m.rotation.y += dt * spd;
      m.rotation.x += dt * spd * 0.4;
    });
    group.add(m);
  }

  // ---- flying traffic
  group.add(buildTraffic(rng));

  // ---- search lights
  const beams = buildSearchlights(city, rng);
  group.add(beams.group);
  updaters.push(beams.update);

  // ---- airship with a giant screen
  const ship = buildAirship(ads[1].tex, ads[3].tex);
  group.add(ship.group);
  updaters.push(ship.update);

  scene.add(group);
  return { group, updaters };
}

function wireHoloMat(color: THREE.Color, seed: number) {
  return new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uColor: { value: color }, seed: { value: seed } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vWorld; varying vec3 vLocal;
      void main(){ vLocal = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      uniform vec3 uColor; uniform float seed;
      varying vec3 vN; varying vec3 vWorld; varying vec3 vLocal;
      void main(){
        vec3 V = normalize(uCamPos - vWorld);
        float fres = pow(1. - abs(dot(normalize(vN), V)), 2.5);
        float scan = .6 + .4 * sin(vWorld.y * 3. - uTime * 6.);
        float flick = .85 + .15 * sin(uTime * 17. + seed);
        vec3 col = uColor * (fres * 2.2 + .12) * scan * flick;
        col *= exp(-length(vWorld - uCamPos) * uFogDensity * .5);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
}

function buildArches(track: Track) {
  const g = new THREE.Group();
  const f = makeFrame();
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vWorld;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      varying vec2 vUv; varying vec3 vWorld;
      void main(){
        float run = pow(fract(vUv.x * 6. - uTime * 1.5), 6.);
        vec3 base = mix(vec3(.2,.9,2.), vec3(2.,.3,1.3), step(.5, fract(vUv.x * 3.)));
        vec3 col = base * (.6 + run * 3.);
        col *= smoothstep(.0, .3, sin(vUv.y * 3.14159));
        gl_FragColor = vec4(applyFog(col, vWorld), 1.);
      }`,
  });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1d26, metalness: 0.9, roughness: 0.3 });
  for (const path of track.paths) {
    for (let s = 700; s < path.length - 100; s += 900) {
      const [i] = path.idx(s);
      if (path.flags[i] & (F_LOOP | F_GAP | F_TUNNEL)) continue;
      if (Math.abs(path.curlAt(s)) > 0.05) continue;
      path.sample(s, f);
      if (f.u.y < 0.9) continue;
      const [L, R] = path.ext(s);
      const rad = (L + R) / 2 + 4;
      const center = f.p.clone().addScaledVector(f.r, (R - L) / 2);
      const arch = new THREE.Group();
      const neon = new THREE.Mesh(new THREE.TorusGeometry(rad, 0.55, 8, 64, Math.PI), mat);
      arch.add(neon);
      const shell = new THREE.Mesh(new THREE.TorusGeometry(rad + 1.4, 1.1, 6, 48, Math.PI), frameMat);
      arch.add(shell);
      for (const sx of [-1, 1]) {
        const pyl = new THREE.Mesh(new THREE.BoxGeometry(2.4, 8, 2.4), frameMat);
        pyl.position.set(sx * (rad + 1.4), -2.5, 0);
        arch.add(pyl);
      }
      arch.position.copy(center).addScaledVector(f.u, -0.5);
      const m = new THREE.Matrix4().makeBasis(f.r, f.u, f.t.clone().negate());
      arch.quaternion.setFromRotationMatrix(m);
      g.add(arch);
    }
  }
  return g;
}

function buildStartGate(track: Track, logoTex: THREE.Texture) {
  const g = new THREE.Group();
  const f = makeFrame();
  track.main.sample(track.startS, f);
  const W = HALF_W + 8;
  const frameMat = new THREE.MeshPhysicalMaterial({ color: 0x14161f, metalness: 0.9, roughness: 0.25, clearcoat: 1 });
  const H = 26;
  for (const sx of [-1, 1]) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(4, H, 6), frameMat);
    tower.position.set(sx * W, H / 2 - 2, 0);
    g.add(tower);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.3, H - 2, 0.3), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2, 4) }));
    strip.position.set(sx * (W - 2.1), H / 2 - 2, 3.1);
    g.add(strip);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(W * 2 + 4, 7, 5), frameMat);
  beam.position.set(0, H - 2, 0);
  g.add(beam);
  // big screen with logo
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.3, W * 0.65 * 0.5), holoMat(logoTex, new THREE.Color(1, 1, 1), 0.5, 2.6));
  screen.position.set(0, H + 8, 0);
  screen.rotation.y = Math.PI;
  g.add(screen);
  const screen2 = screen.clone();
  screen2.rotation.y = 0;
  g.add(screen2);
  // countdown lights (5 lamps on the beam, both faces)
  const lampMat = new THREE.ShaderMaterial({
    uniforms: { ...decorUniforms, ...globalUniforms },
    vertexShader: `attribute float aIdx; varying float vIdx; varying vec2 vUv; void main(){ vIdx = aIdx; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: /* glsl */ `
      uniform float uStartLights; uniform float uTime; varying float vIdx; varying vec2 vUv;
      void main(){
        float r = length(vUv - .5) * 2.;
        float disc = smoothstep(1., .8, r);
        vec3 off = vec3(.05,.02,.02);
        vec3 col = off;
        if(uStartLights >= 4.) col = vec3(.2, 4., .8);
        else if(vIdx < uStartLights * 5. / 3. - .01) col = vec3(5., .2, .1);
        if(uStartLights <= 0.) col = mix(off, vec3(.3,1.,2.) * (.5 + .5*sin(uTime*3. - vIdx)), .6);
        gl_FragColor = vec4(col * disc, 1.);
      }`,
    side: THREE.DoubleSide,
  });
  for (let i = 0; i < 5; i++) {
    for (const face of [-1, 1]) {
      const geo = new THREE.PlaneGeometry(3, 3);
      geo.setAttribute('aIdx', new THREE.Float32BufferAttribute([i, i, i, i], 1));
      const lamp = new THREE.Mesh(geo, lampMat);
      lamp.position.set((i - 2) * 5, H - 2, face * 2.6);
      if (face < 0) lamp.rotation.y = Math.PI;
      g.add(lamp);
    }
  }
  const m = new THREE.Matrix4().makeBasis(f.r, f.u, f.t.clone().negate());
  g.quaternion.setFromRotationMatrix(m);
  g.position.copy(f.p);
  return g;
}

function buildDragon(center: THREE.Vector3) {
  const SEG = 400,
    RAD = 12;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= SEG; i++) {
    for (let j = 0; j <= RAD; j++) {
      const a = (j / RAD) * Math.PI * 2;
      pos.push(i / SEG, Math.cos(a), Math.sin(a));
      if (i < SEG && j < RAD) {
        const p0 = i * (RAD + 1) + j;
        const p1 = p0 + RAD + 1;
        idx.push(p0, p1, p0 + 1, p0 + 1, p1, p1 + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uCenter: { value: center } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime; uniform vec3 uCenter; uniform vec3 uCamPos;
      varying float vU; varying float vFres; varying vec3 vWorld; varying float vAng;
      vec3 curve(float u){
        float t = uTime * .06;
        float a = u * 5.2 + t * 2.;
        float r = 300. + 40. * sin(u * 9. + uTime * .4);
        float y = 380. + 170. * sin(u * 3. + t * 3.) + 40. * sin(u * 11. - uTime * .7);
        return uCenter + vec3(cos(a) * r, y, sin(a) * r);
      }
      void main(){
        float u = position.x;
        vU = u;
        vec3 c = curve(u);
        vec3 tng = normalize(curve(u + .002) - c);
        vec3 nrm = normalize(cross(tng, vec3(0.,1.,0.)));
        vec3 bin = cross(nrm, tng);
        float head = smoothstep(0., .05, 1. - u);
        float body = pow(sin(3.14159 * clamp(u * .98 + .01, 0., 1.)), .45) * 16. * (1. + .5 * (1. - smoothstep(.93, 1., u)) * step(.9, u));
        body *= 1. + .12 * sin(u * 180.);
        vec3 off = (nrm * position.y + bin * position.z) * body;
        vec3 w = c + off;
        vWorld = w;
        vAng = atan(position.z, position.y);
        vec3 n = normalize(off);
        vFres = 1. - abs(dot(n, normalize(uCamPos - w)));
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uCamPos; uniform float uFogDensity;
      varying float vU; varying float vFres; varying vec3 vWorld; varying float vAng;
      void main(){
        float scales = smoothstep(.35, .5, abs(fract(vU * 260. + (vAng / 6.28318) * 3.) - .5));
        vec3 a = vec3(.1, .9, 1.4), b = vec3(1.6, .2, 1.2);
        vec3 col = mix(a, b, .5 + .5 * sin(vU * 12. - uTime * 1.5));
        float glow = pow(vFres, 2.) * 1.6 + scales * .25 + .05;
        float pulse = pow(fract(vU * 4. - uTime * .6), 12.) * 1.5;
        col *= glow + pulse;
        col *= .75 + .25 * sin(vWorld.y * 2. - uTime * 8.);
        col *= exp(-length(vWorld - uCamPos) * uFogDensity * .35);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  return m;
}

function buildGlobe(pos: THREE.Vector3, r: number) {
  const g = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vWorld;
      void main(){ vUv = uv; vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      ${noiseGLSL}
      varying vec2 vUv; varying vec3 vN; varying vec3 vWorld;
      void main(){
        vec2 uv = vec2(vUv.x + uTime * .01, vUv.y);
        float lon = smoothstep(.02, .0, abs(fract(uv.x * 24.) - .5) * .5);
        float lat = smoothstep(.02, .0, abs(fract(uv.y * 12.) - .5) * .5);
        float land = step(.52, fbm(uv * vec2(8., 4.)));
        float dots = land * step(.6, hash12(floor(uv * vec2(240., 120.))));
        vec3 V = normalize(uCamPos - vWorld);
        float fres = pow(1. - abs(dot(normalize(vN), V)), 3.);
        vec3 col = vec3(.2,.7,1.) * (lon + lat) * .5 + vec3(.3,1.,.8) * dots * .9 + vec3(.4,.6,1.) * fres * 1.5;
        col *= exp(-length(vWorld - uCamPos) * uFogDensity * .5);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 32), mat);
  g.add(sphere);
  const ringMat = wireHoloMat(new THREE.Color(1, 0.3, 0.8), 3);
  for (let i = 0; i < 2; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * (1.35 + i * 0.2), 0.8, 6, 128), ringMat);
    ring.rotation.x = Math.PI / 2 + 0.3 * (i ? -1 : 1);
    g.add(ring);
  }
  g.position.copy(pos);
  return g;
}

function buildTraffic(rng: () => number) {
  const lanes: number[] = [];
  const N = 2600;
  const start: number[] = [],
    dir: number[] = [],
    prm: number[] = [],
    col: number[] = [];
  for (let i = 0; i < N; i++) {
    const alongX = rng() < 0.5;
    const k = Math.floor(rrange(rng, -30, 30));
    const y = rrange(rng, 70, 320);
    const len = 6000;
    const sgn = rng() < 0.5 ? -1 : 1;
    const laneOff = sgn * 6;
    const sx = alongX ? 1200 - 3000 : 1125 + k * 150 + laneOff;
    const sz = alongX ? 1425 + k * 150 + laneOff : 1500 - 3000;
    const d = alongX ? [1, 0, 0] : [0, 0, 1];
    const speed = rrange(rng, 25, 70) * sgn;
    const phase = rng() * len;
    // two lights per car: headlight (white) and tail (red), offset along direction
    for (const part of [0, 1]) {
      start.push(sx, y, sz);
      dir.push(d[0], d[1], d[2]);
      prm.push(len, speed, phase + (part ? -4 * sgn : 0), part);
      if (part === 0) col.push(3, 2.8, 2.4);
      else col.push(3.2, 0.25, 0.15);
    }
  }
  void lanes;
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('iStart', new THREE.InstancedBufferAttribute(new Float32Array(start), 3));
  g.setAttribute('iDir', new THREE.InstancedBufferAttribute(new Float32Array(dir), 3));
  g.setAttribute('iPrm', new THREE.InstancedBufferAttribute(new Float32Array(prm), 4));
  g.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(col), 3));
  g.instanceCount = start.length / 3;
  const m = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 iStart; attribute vec3 iDir; attribute vec4 iPrm; attribute vec3 iCol;
      uniform float uTime; uniform vec3 uCamPos; uniform float uFogDensity;
      varying vec2 vUv; varying vec3 vCol;
      void main(){
        float d = mod(iPrm.z + uTime * iPrm.y, iPrm.x);
        vec3 p = iStart + iDir * d;
        p.y += sin(uTime * .5 + iPrm.z) * 2.;
        float dist = length(p - uCamPos);
        float size = .9 * (1. + dist * .003);
        // tail lights visible from behind, headlights from the front
        vec3 fw = iDir * sign(iPrm.y);
        float facing = dot(normalize(uCamPos - p), fw);
        float vis = iPrm.w < .5 ? smoothstep(-.2, .6, facing) : smoothstep(.2, -.6, facing);
        vis = .25 + .75 * vis;
        float edge = smoothstep(0., 200., d) * smoothstep(iPrm.x, iPrm.x - 200., d);
        vCol = iCol * vis * edge * exp(-dist * uFogDensity * .55);
        vUv = position.xy;
        vec4 mv = viewMatrix * vec4(p, 1.);
        mv.xy += position.xy * size;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vCol;
      void main(){ float r = length(vUv); float a = exp(-r*r*6.) + exp(-r*18.) * .6; gl_FragColor = vec4(vCol * a * smoothstep(1., .7, r), 1.); }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}

function buildSearchlights(city: CityBuild, rng: () => number) {
  const group = new THREE.Group();
  const geo = new THREE.ConeGeometry(70, 1400, 32, 1, true);
  geo.translate(0, -700, 0); // apex at origin, opening downward along -Y; flip below
  geo.rotateX(Math.PI);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uColor: { value: new THREE.Color(0.6, 0.7, 1) } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying float vY; varying vec3 vN; varying vec3 vWorld;
      void main(){ vY = position.y / 1400.; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uCamPos; uniform float uFogDensity;
      varying float vY; varying vec3 vN; varying vec3 vWorld;
      void main(){
        float along = pow(1. - clamp(vY, 0., 1.), 2.5);
        float edge = pow(abs(dot(normalize(vN), normalize(uCamPos - vWorld))), 1.5);
        vec3 col = uColor * along * edge * .12;
        col *= exp(-length(vWorld - uCamPos) * uFogDensity * .3);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
  const lights: { m: THREE.Mesh; a: number; b: number; sp: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const sp = city.roofSpots[Math.floor(rng() * city.roofSpots.length)];
    if (!sp) break;
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(sp);
    group.add(m);
    lights.push({ m, a: rng() * 6.28, b: rng() * 6.28, sp: rrange(rng, 0.2, 0.5) });
  }
  const update = (_dt: number, t: number) => {
    for (const l of lights) {
      const ang = 0.25 + 0.25 * Math.sin(t * l.sp + l.a);
      l.m.rotation.set(ang, t * l.sp * 0.7 + l.b, 0, 'YXZ');
    }
  };
  return { group, update };
}

function buildAirship(adA: THREE.Texture, adB: THREE.Texture) {
  const group = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshPhysicalMaterial({ color: 0x1b1e2a, metalness: 0.6, roughness: 0.35, clearcoat: 1 }));
  hull.scale.set(160, 38, 38);
  group.add(hull);
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2, 4) });
  for (const x of [-100, -40, 40, 100]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(38 * Math.sqrt(1 - (x / 160) ** 2) + 0.5, 0.6, 6, 64), ringMat);
    r.rotation.y = Math.PI / 2;
    r.position.x = x;
    group.add(r);
  }
  const scrA = new THREE.Mesh(new THREE.PlaneGeometry(150, 60), holoMat(adA, new THREE.Color(1, 1, 1), 11, 2.4));
  scrA.position.set(0, -5, 40);
  group.add(scrA);
  const scrB = new THREE.Mesh(new THREE.PlaneGeometry(150, 60), holoMat(adA, new THREE.Color(1, 1, 1), 12, 2.4));
  scrB.position.set(0, -5, -40);
  scrB.rotation.y = Math.PI;
  group.add(scrB);
  void adB;
  for (const x of [-150, 150]) {
    const l = new THREE.PointLight(0xff2244, 0, 1);
    l.position.x = x;
  }
  const update = (_dt: number, t: number) => {
    const a = t * 0.012;
    group.position.set(1200 + Math.cos(a) * 1500, 520 + Math.sin(t * 0.1) * 10, 1500 + Math.sin(a) * 1500);
    group.rotation.y = -a;
  };
  update(0, 0);
  return { group, update };
}
