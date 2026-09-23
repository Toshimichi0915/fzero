(() => {
  const r = game.race, tr = game.world.track, m = tr.main;
  const v = r.vehicles[5];
  const out = [];
  const ev = [];
  for (const spd of [120, 160, 200]) {
    v.retired = false; v.air = false; v.respawnTimer = 0;
    v.path = 0; v.s = m.markers.jump0 - 50; v.x = 0; v.psi = v.phi = 0; v.knock = 0; v.v = spd; v.energy = 100;
    const log = [];
    for (let i = 0; i < 60 * 6; i++) {
      v.controls = { steer: 0, throttle: 1, brake: 0, lean: 0, pitch: 0, boost: false, sideAttack: 0, spin: false };
      const evs = [];
      v.update(1 / 60, tr, 0, evs);
      for (const e of evs) ev.push(spd + ':' + e.type + '@' + Math.round(v.s) + ' h=' + v.h.toFixed(1) + ' x=' + v.x.toFixed(1));
      if (i % 15 == 0) log.push([Math.round(v.s - m.markers.jump0), v.h.toFixed(1), v.air ? 'A' : 'G', v.airPos.y.toFixed(0)]);
    }
    out.push(spd + ': ' + log.map(l => l.join('/')).join(' '));
  }
  return { jump0: m.markers.jump0, jump1: m.markers.jump1, out, ev };
})()
