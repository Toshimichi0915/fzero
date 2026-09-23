// Debug: render the course layout as SVG (top view + elevation) and check road clearances
import { buildTrack, HALF_W } from '../src/track/Track';
import { F_GAP, F_LOOP, F_TUNNEL } from '../src/track/Path';
const tr = buildTrack();
let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
for (const p of tr.paths) for (let i = 0; i < p.n; i++) {
  minX = Math.min(minX, p.pos[i*3]); maxX = Math.max(maxX, p.pos[i*3]);
  minZ = Math.min(minZ, p.pos[i*3+2]); maxZ = Math.max(maxZ, p.pos[i*3+2]);
}
const pad = 100, S = 0.4;
const w = (maxX - minX + pad*2) * S, h = (maxZ - minZ + pad*2) * S;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h+340}" style="background:#111"><rect width="100%" height="100%" fill="#111"/>`;
const pcol = ['#0cf', '#f0f', '#ff0'];
const X = (x: number) => (x - minX + pad) * S, Z = (z: number) => (z - minZ + pad) * S;
for (const p of tr.paths) {
  for (let i = 0; i < p.n - 1; i += 3) {
    const fl = p.flags[i];
    const c = fl & F_GAP ? '#f00' : fl & F_LOOP ? '#fff' : Math.abs(p.curl[i]) > 0.5 ? '#0f0' : pcol[p.index];
    const j = Math.min(p.n-1, i+3);
    svg += `<line x1="${X(p.pos[i*3])}" y1="${Z(p.pos[i*3+2])}" x2="${X(p.pos[j*3])}" y2="${Z(p.pos[j*3+2])}" stroke="${c}" stroke-width="${(p.leftExt[i]+p.rightExt[i])*S}" stroke-opacity="0.55"/>`;
  }
  for (const [k, s] of Object.entries(p.markers)) {
    const i = Math.round(s / p.ds) % p.n;
    svg += `<text x="${X(p.pos[i*3])}" y="${Z(p.pos[i*3+2])}" fill="#fff" font-size="13">${k}</text>`;
  }
  for (let i = 0; i < p.n; i += 6) {
    const prog = tr.progress(p.index, i * p.ds);
    svg += `<circle cx="${prog / tr.lapLength * w}" cy="${h + 320 - p.pos[i*3+1] * 0.8}" r="1.2" fill="${pcol[p.index]}"/>`;
  }
}
// clearance check
const pts: { p: number; s: number; x: number; y: number; z: number }[] = [];
for (const p of tr.paths) for (let i = 0; i < p.n; i += 4) pts.push({ p: p.index, s: i * p.ds, x: p.pos[i*3], y: p.pos[i*3+1], z: p.pos[i*3+2] });
const nearFork = (a: typeof pts[0]) => tr.branches.some((b, bi) => {
  if (a.p === bi + 1) return a.s < 350 || a.s > b.path.length - 350;
  if (a.p === b.parent) return Math.abs(a.s - b.startS) < 350 || Math.abs(a.s - b.endS) < 350;
  return false;
});
const conflicts: string[] = [];
const seen = new Set<string>();
for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
  const a = pts[i], b = pts[j];
  const dx = a.x - b.x, dz = a.z - b.z;
  if (dx*dx + dz*dz > (HALF_W * 2 + 8) ** 2) continue;
  if (Math.abs(a.y - b.y) > 22) continue;
  if (a.p === b.p) { const L = tr.paths[a.p].length; let ds = Math.abs(a.s - b.s); if (tr.paths[a.p].closed) ds = Math.min(ds, L - ds); if (ds < 200) continue; }
  else if (nearFork(a) && nearFork(b)) continue;
  const key = `${a.p}:${Math.round(a.s/100)}-${b.p}:${Math.round(b.s/100)}`;
  if (seen.has(key)) continue; seen.add(key);
  conflicts.push(`path${a.p}@${a.s.toFixed(0)} vs path${b.p}@${b.s.toFixed(0)} dy=${(a.y-b.y).toFixed(0)}`);
  svg += `<circle cx="${X(a.x)}" cy="${Z(a.z)}" r="10" fill="none" stroke="#f00" stroke-width="3"/>`;
}
for (const t of tr.towers) svg += `<circle cx="${X(t.pos.x)}" cy="${Z(t.pos.z)}" r="${t.radius*S}" fill="none" stroke="#fff"/>`;
svg += `<text x="10" y="20" fill="#fff" font-size="16">${tr.paths.map(p => p.name + ' ' + p.length.toFixed(0) + 'm').join(', ')} | conflicts ${conflicts.length}</text></svg>`;
await Bun.write(process.argv[2], svg);
console.log(tr.paths.map(p => p.name + ' ' + p.length.toFixed(0)).join(' / '));
console.log('conflicts:', conflicts.length);
console.log(conflicts.slice(0, 30).join('\n'));
