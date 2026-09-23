import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural hover-racer models. Model space: nose towards -Z, +X right, +Y up.
 * Total length ~6.5m.
 */

export interface EngineMount {
  pos: THREE.Vector3; // nozzle exit centre (model space)
  radius: number;
}

export interface MachineSpec {
  name: string;
  hull: number; // 0 falcon, 1 needle, 2 manta, 3 brick
  color: THREE.Color;
  accent: THREE.Color;
  thrust: THREE.Color; // thruster glow color
  // performance
  maxSpeed: number;
  accel: number;
  turn: number;
  grip: number;
  body: number; // durability multiplier (lower = takes less damage)
  weight: number;
  boost: number;
}

interface Section {
  z: number;
  w: number; // half width
  t: number; // top height
  b: number; // bottom depth
  y?: number;
  e?: number; // superellipse exponent
}

function loft(sections: Section[], seg = 20) {
  const pos: number[] = [];
  const idx: number[] = [];
  const ring = seg;
  for (const s of sections) {
    const e = s.e ?? 2.6;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      const c = Math.cos(a),
        sn = Math.sin(a);
      const px = Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * s.w;
      const pyN = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / e);
      const py = (pyN > 0 ? pyN * s.t : pyN * s.b) + (s.y ?? 0);
      pos.push(px, py, s.z);
    }
  }
  for (let k = 0; k < sections.length - 1; k++)
    for (let i = 0; i < ring; i++) {
      const a = k * ring + i,
        b = k * ring + ((i + 1) % ring);
      const c = a + ring,
        d = b + ring;
      idx.push(a, b, c, b, d, c);
    }
  // caps
  const capCenter = (k: number, flip: boolean) => {
    const s = sections[k];
    const ci = pos.length / 3;
    pos.push(0, s.y ?? 0, s.z);
    for (let i = 0; i < ring; i++) {
      const a = k * ring + i,
        b = k * ring + ((i + 1) % ring);
      if (flip) idx.push(ci, b, a);
      else idx.push(ci, a, b);
    }
  };
  capCenter(0, true);
  capCenter(sections.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g.index ? g.toNonIndexed() : g;
}

function wing(points: [number, number][], thickness: number, y: number, bevel = 0.03) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  // shape in XY -> rotate so shape Y maps to Z
  g.rotateX(Math.PI / 2);
  g.translate(0, y + thickness / 2, 0);
  return g.index ? g.toNonIndexed() : g;
}

function fin(points: [number, number][], thickness: number, x: number, tilt: number) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1 });
  // shape x->z, y->y, extrude along x
  g.rotateY(-Math.PI / 2);
  g.translate(-thickness / 2, 0, 0);
  g.rotateZ(tilt);
  g.translate(x, 0, 0);
  return g.index ? g.toNonIndexed() : g;
}

function pod(x: number, y: number, z0: number, z1: number, r: number) {
  const secs: Section[] = [
    { z: z0, w: r * 0.35, t: r * 0.35, b: r * 0.35, y, e: 2 },
    { z: z0 + (z1 - z0) * 0.2, w: r * 0.9, t: r * 0.9, b: r * 0.9, y, e: 2 },
    { z: z0 + (z1 - z0) * 0.7, w: r, t: r, b: r, y, e: 2.2 },
    { z: z1, w: r * 1.08, t: r * 1.08, b: r * 1.08, y, e: 2.2 },
  ];
  const g = loft(secs, 18);
  g.translate(x, 0, 0);
  return g;
}

function nozzle(x: number, y: number, z: number, r: number) {
  const g = new THREE.CylinderGeometry(r * 1.12, r * 0.95, 0.35, 20, 1, true);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z + 0.1);
  return g.index ? g.toNonIndexed() : g;
}

function disc(x: number, y: number, z: number, r: number) {
  const g = new THREE.CircleGeometry(r, 20);
  g.translate(x, y, z);
  return g.index ? g.toNonIndexed() : g;
}

function stripe(x: number, y: number, z0: number, z1: number, w: number) {
  const g = new THREE.BoxGeometry(w, 0.03, z1 - z0);
  g.translate(x, y, (z0 + z1) / 2);
  return g.index ? g.toNonIndexed() : g;
}

export interface BuiltModel {
  group: THREE.Group;
  engines: EngineMount[];
  length: number;
  width: number;
}

const matCache = new Map<string, THREE.Material>();
function getMat(key: string, make: () => THREE.Material) {
  let m = matCache.get(key);
  if (!m) matCache.set(key, (m = make()));
  return m;
}

export function buildMachine(spec: MachineSpec): BuiltModel {
  const body: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const hot: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const engines: EngineMount[] = [];
  let width = 3;

  const addEngine = (x: number, y: number, z: number, r: number) => {
    trim.push(nozzle(x, y, z, r));
    hot.push(disc(x, y, z + 0.12, r * 0.92));
    engines.push({ pos: new THREE.Vector3(x, y, z + 0.3), radius: r });
  };

  switch (spec.hull) {
    case 0: {
      // "Falcon": sleek body, twin side pods, swept wings
      body.push(
        loft([
          { z: -3.4, w: 0.04, t: 0.03, b: 0.03, y: 0.05 },
          { z: -2.7, w: 0.42, t: 0.2, b: 0.14, y: 0.05 },
          { z: -1.6, w: 0.78, t: 0.34, b: 0.2 },
          { z: -0.3, w: 0.98, t: 0.5, b: 0.26 },
          { z: 1.0, w: 1.05, t: 0.46, b: 0.28 },
          { z: 2.2, w: 0.9, t: 0.36, b: 0.28 },
          { z: 2.8, w: 0.7, t: 0.28, b: 0.24 },
        ]),
      );
      for (const sx of [-1, 1]) {
        body.push(pod(sx * 1.45, 0.02, -0.9, 2.75, 0.4));
        addEngine(sx * 1.45, 0.02, 2.75, 0.4);
        dark.push(wing([[0, -0.8], [sx * 1.5, 0.2], [sx * 2.1, 1.9], [sx * 1.9, 2.4], [0, 2.2]].map(([a, b]) => [a, b]) as [number, number][], 0.08, -0.05));
        dark.push(fin([[0.8, 0.3], [2.3, 1.2], [2.7, 1.25], [2.5, 0.3]], 0.07, sx * 0.55, sx * 0.25));
        glow.push(stripe(sx * 0.55, 0.47, -1.2, 1.4, 0.07));
        glow.push(stripe(sx * 1.45, 0.43, -0.4, 2.4, 0.05));
      }
      addEngine(0, 0.08, 2.8, 0.28);
      glass.push(canopy(0, 0.42, -0.7, 0.46, 0.34, 1.25));
      width = 4.2;
      break;
    }
    case 1: {
      // "Needle": long nose, big central engine
      body.push(
        loft([
          { z: -3.8, w: 0.03, t: 0.03, b: 0.03, y: 0.0 },
          { z: -2.8, w: 0.3, t: 0.2, b: 0.12 },
          { z: -1.2, w: 0.6, t: 0.36, b: 0.22 },
          { z: 0.4, w: 0.8, t: 0.5, b: 0.3, e: 2.2 },
          { z: 1.8, w: 0.8, t: 0.55, b: 0.35, e: 2.2 },
          { z: 2.7, w: 0.72, t: 0.52, b: 0.4, e: 2.2 },
        ]),
      );
      addEngine(0, 0.08, 2.7, 0.55);
      for (const sx of [-1, 1]) {
        dark.push(wing([[0, 0.2], [sx * 1.8, 1.3], [sx * 1.9, 2.5], [0, 2.3]], 0.07, -0.1));
        dark.push(wing([[0, -2.4], [sx * 0.9, -1.6], [sx * 0.95, -1.3], [0, -1.5]], 0.05, -0.02));
        body.push(pod(sx * 1.85, -0.05, 0.9, 2.6, 0.24));
        addEngine(sx * 1.85, -0.05, 2.6, 0.24);
        glow.push(stripe(sx * 0.35, 0.5, -1.0, 2.0, 0.05));
      }
      dark.push(fin([[1.0, 0.4], [2.4, 1.5], [2.8, 1.5], [2.7, 0.4]], 0.08, 0, 0));
      glass.push(canopy(0, 0.35, -0.9, 0.36, 0.3, 1.2));
      width = 4;
      break;
    }
    case 2: {
      // "Manta": wide flat lifting body, four engines
      body.push(
        loft(
          [
            { z: -3.2, w: 0.2, t: 0.05, b: 0.05 },
            { z: -2.2, w: 1.1, t: 0.22, b: 0.12, e: 3.5 },
            { z: -0.6, w: 1.8, t: 0.34, b: 0.18, e: 4 },
            { z: 1.2, w: 2.1, t: 0.32, b: 0.2, e: 4 },
            { z: 2.6, w: 1.9, t: 0.26, b: 0.2, e: 4 },
          ],
          24,
        ),
      );
      for (const x of [-1.35, -0.45, 0.45, 1.35]) addEngine(x, 0.02, 2.62, 0.22);
      for (const sx of [-1, 1]) {
        dark.push(fin([[0.6, 0.2], [2.2, 1.0], [2.6, 1.0], [2.5, 0.2]], 0.07, sx * 1.9, sx * 0.1));
        glow.push(stripe(sx * 1.2, 0.34, -1.5, 2.2, 0.06));
        dark.push(wing([[sx * 1.9, -0.5], [sx * 2.6, 0.8], [sx * 2.6, 2.4], [sx * 1.9, 2.5]], 0.06, 0.0));
      }
      glass.push(canopy(0, 0.3, -0.8, 0.55, 0.28, 1.3));
      width = 5.2;
      break;
    }
    default: {
      // "Brick": chunky heavy machine, two huge engines
      body.push(
        loft(
          [
            { z: -3.1, w: 0.7, t: 0.15, b: 0.1, e: 5 },
            { z: -2.5, w: 1.2, t: 0.42, b: 0.3, e: 5 },
            { z: -0.5, w: 1.35, t: 0.62, b: 0.34, e: 5 },
            { z: 1.6, w: 1.4, t: 0.62, b: 0.36, e: 5 },
            { z: 2.6, w: 1.3, t: 0.5, b: 0.36, e: 5 },
          ],
          24,
        ),
      );
      for (const sx of [-1, 1]) {
        body.push(pod(sx * 1.2, 0.2, -0.2, 2.85, 0.55));
        addEngine(sx * 1.2, 0.2, 2.85, 0.55);
        dark.push(wing([[sx * 1.3, -2.5], [sx * 1.9, -1.8], [sx * 1.9, -0.8], [sx * 1.3, -0.8]], 0.12, -0.15));
        glow.push(stripe(sx * 1.36, 0.1, -2.4, -0.9, 0.08));
      }
      glass.push(canopy(0, 0.6, -0.9, 0.55, 0.3, 1.0));
      width = 4.2;
      break;
    }
  }

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: spec.color,
    metalness: 0.55,
    roughness: 0.28,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.4,
  });
  applyLivery(bodyMat, spec);
  const darkMat = getMat('dark', () => new THREE.MeshPhysicalMaterial({ color: 0x14161c, metalness: 0.8, roughness: 0.35, clearcoat: 0.6, envMapIntensity: 1.2, side: THREE.DoubleSide }));
  const trimMat = getMat('trim', () => new THREE.MeshStandardMaterial({ color: 0x9aa0aa, metalness: 1, roughness: 0.22, side: THREE.DoubleSide }));
  const glowMat = new THREE.MeshBasicMaterial({ color: spec.accent.clone().multiplyScalar(3.5) });
  const hotMat = new THREE.MeshBasicMaterial({ color: spec.thrust.clone().lerp(new THREE.Color(1, 1, 1), 0.5).multiplyScalar(3.5) });
  const glassMat = getMat(
    'glass',
    () =>
      new THREE.MeshPhysicalMaterial({
        color: 0x05060a,
        metalness: 0.2,
        roughness: 0.02,
        clearcoat: 1,
        envMapIntensity: 2.2,
        emissive: new THREE.Color(0.02, 0.06, 0.12),
      }),
  );
  const group = new THREE.Group();
  const add = (geos: THREE.BufferGeometry[], m: THREE.Material) => {
    if (!geos.length) return;
    const g = mergeGeometries(geos.map((x) => (x.index ? x.toNonIndexed() : x)).map(stripAttrs));
    const mesh = new THREE.Mesh(g, m);
    group.add(mesh);
  };
  add(body, bodyMat);
  add(dark, darkMat);
  add(trim, trimMat);
  add(glow, glowMat);
  add(hot, hotMat);
  add(glass, glassMat);
  return { group, engines, length: 6.5, width };
}

/** Procedural livery: centre racing stripes, side flash, panel lines and a glowing race number. */
function applyLivery(m: THREE.MeshPhysicalMaterial, spec: MachineSpec) {
  const accent = spec.accent.clone();
  const number = (Math.abs(spec.name.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 89) + 10;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uAccent = { value: accent };
    sh.uniforms.uNum = { value: number };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;\nvObjN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vObj; varying vec3 vObjN; uniform vec3 uAccent; uniform float uNum;
        // 3x5 bitmap digits
        float digit(int d, vec2 p){
          if(p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1.) return 0.;
          int x = int(p.x * 3.), y = int(p.y * 5.);
          int bits[10] = int[10](31599, 9362, 29671, 29391, 23497, 31183, 31215, 29257, 31727, 31695);
          int b = bits[d];
          int idx = (4 - y) * 3 + (2 - x);
          return float((b >> idx) & 1);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 o = vObj;
          float top = step(0.05, vObjN.y);
          // twin centre stripes
          float cs = (smoothstep(.16, .14, abs(abs(o.x) - .22))) * top;
          // side flash
          float side = step(.6, abs(vObjN.x)) * smoothstep(.06, .0, abs(o.y - .05 - o.z * .06)) ;
          vec3 acc = uAccent;
          diffuseColor.rgb = mix(diffuseColor.rgb, acc, clamp(cs + side, 0., 1.) * .9);
          // panel lines
          float pl = smoothstep(.015, .0, abs(fract(o.z * .7 + .3) - .5) - .47);
          diffuseColor.rgb *= 1. - pl * .5;
          // race number on the flanks
          int n1 = int(uNum) / 10, n0 = int(uNum) - n1 * 10;
          vec2 q = vec2((sign(o.x) * -o.z + .35) * 2.2, (o.y + .12) * 2.2);
          float dg = digit(n1, q) + digit(n0, q - vec2(1.25, 0.));
          dg *= step(.6, abs(vObjN.x));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.), dg * .9);
        }`,
      );
  };
  m.customProgramCacheKey = () => 'livery';
}

function stripAttrs(g: THREE.BufferGeometry) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function canopy(x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  const g = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(sx, sy, sz);
  g.translate(x, y - 0.05, z);
  return g.index ? g.toNonIndexed() : g;
}
