import * as THREE from 'three';
import { MachineSpec } from '../vehicles/VehicleModel';
import { mulberry32 } from '../core/util';

export const PLAYER_MACHINES: (Omit<MachineSpec, 'color' | 'accent' | 'thrust'> & { color: number; accent: number; thrust: number; blurb: string; pilot: string })[] = [
  { name: 'AZURE LANCE', pilot: 'KAI VEGA', hull: 0, color: 0x1a4dff, accent: 0xffd23a, thrust: 0x39a0ff, maxSpeed: 172, accel: 46, turn: 1.55, grip: 7, body: 1.0, weight: 1.0, boost: 1.0, blurb: 'Balanced all-rounder. Forgiving grip, solid boost.' },
  { name: 'CRIMSON NEEDLE', pilot: 'RIN ASHGROVE', hull: 1, color: 0xe0142c, accent: 0xffffff, thrust: 0xff5a1f, maxSpeed: 182, accel: 40, turn: 1.4, grip: 5.5, body: 1.25, weight: 0.85, boost: 1.15, blurb: 'Blistering top speed. Fragile, twitchy in bends.' },
  { name: 'VIOLET MANTA', pilot: 'SABLE OKORO', hull: 2, color: 0x8a2cff, accent: 0x2cffd5, thrust: 0xff3aa8, maxSpeed: 166, accel: 52, turn: 1.75, grip: 8.5, body: 0.95, weight: 0.9, boost: 0.9, blurb: 'Glued to the road. Best cornering in the field.' },
  { name: 'IRON BASTION', pilot: 'DUKE MARROW', hull: 3, color: 0xf2a20c, accent: 0x111111, thrust: 0xffb13a, maxSpeed: 169, accel: 42, turn: 1.45, grip: 7, body: 0.65, weight: 1.45, boost: 1.05, blurb: 'Armoured bruiser. Shrugs off hits, dishes them out.' },
];

const FIRST = ['NOVA', 'HEX', 'VOLT', 'ZEPHYR', 'ORCA', 'PHANTOM', 'SOLAR', 'RIFT', 'ONYX', 'CIRRUS', 'EMBER', 'HALCYON', 'KESTREL', 'LUMEN', 'MIRAGE', 'NEBULA', 'OBSIDIAN', 'PULSAR', 'QUASAR', 'RAVEN', 'SPECTRE', 'TEMPEST', 'ULTRA', 'VORTEX', 'WRAITH', 'XENON', 'YARA', 'ZENITH', 'AURORA', 'BLAZE', 'COBALT', 'DYNAMO'];
const SECOND = ['FANG', 'WING', 'RAY', 'DART', 'EDGE', 'COMET', 'SPARK', 'GHOST', 'STORM', 'BOLT', 'SHARD', 'FURY', 'ARROW', 'BLADE', 'CROWN', 'DRIFT'];
const PILOTS = ['J. KORVIN', 'M. TAKEDA', 'L. ORTEGA', 'S. NAKAMURA', 'A. VOSS', 'D. MBEKI', 'Y. PETROVA', 'K. HALE', 'R. SANTOS', 'T. LINDQVIST', 'O. ADEYEMI', 'N. FUJIWARA', 'E. ROSSI', 'B. QUINN', 'C. DUBOIS', 'H. KIM', 'I. NOVAK', 'P. SHARMA', 'G. MORENO', 'V. KAITO', 'W. ZHANG', 'F. OKAFOR', 'U. BERG', 'Z. ALI', 'X. MERCER', 'Q. ROYCE', 'M. SOL', 'A. REYES', 'T. OYELARAN', 'S. IVANOV', 'L. HART'];

export function makeRivals(count: number, seed = 42): (MachineSpec & { pilot: string })[] {
  const r = mulberry32(seed);
  const out: (MachineSpec & { pilot: string })[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < count; i++) {
    const hue = (i / count + r() * 0.03) % 1;
    const color = new THREE.Color().setHSL(hue, 0.75 + r() * 0.2, 0.42 + r() * 0.15);
    const accent = new THREE.Color().setHSL((hue + 0.45 + r() * 0.2) % 1, 1, 0.6);
    // thruster palette: fiery oranges, electric blues, magentas, teal, violet
    const tpal = [0xff6a1a, 0x3aa0ff, 0xff2a9a, 0x2affd0, 0xa060ff, 0xffc03a, 0xff3a3a, 0x6affff];
    const thrust = new THREE.Color(tpal[Math.floor(r() * tpal.length)]);
    let name = '';
    do name = FIRST[Math.floor(r() * FIRST.length)] + ' ' + SECOND[Math.floor(r() * SECOND.length)];
    while (usedNames.has(name));
    usedNames.add(name);
    const hull = Math.floor(r() * 4);
    const base = PLAYER_MACHINES[hull];
    out.push({
      name,
      pilot: PILOTS[i % PILOTS.length],
      hull,
      color,
      accent,
      thrust,
      maxSpeed: base.maxSpeed * (0.96 + r() * 0.05),
      accel: base.accel * (0.95 + r() * 0.1),
      turn: base.turn * (0.97 + r() * 0.06),
      grip: base.grip,
      body: base.body,
      weight: base.weight,
      boost: base.boost,
    });
  }
  return out;
}

export function playerSpec(i: number): MachineSpec & { pilot: string } {
  const m = PLAYER_MACHINES[i];
  return { ...m, color: new THREE.Color(m.color), accent: new THREE.Color(m.accent), thrust: new THREE.Color(m.thrust) };
}
