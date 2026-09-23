(() => {
  const r = game.race;
  const stats = {};
  const falls = [];
  r.listeners.push((e) => { stats[e.type] = (stats[e.type] || 0) + 1; if (e.type === 'fall') falls.push([e.v.id, e.v.path, Math.round(e.v.s)]); });
  const t0 = performance.now();
  for (let i = 0; i < 60 * 150; i++) r.update(1 / 60);
  const ms = performance.now() - t0;
  return { ms: Math.round(ms), stats, falls: falls.slice(0, 20),
    laps: r.standings.map(v => v.lap).join(','),
    top: r.standings.slice(0, 5).map(v => [v.id, v.name, v.lap, Math.round(v.raceDist), v.energy.toFixed(0)]),
    retired: r.vehicles.filter(v => v.retired).length,
    player: [r.player.place, r.player.lap, r.player.lapTimes.map(x => x.toFixed(1))],
    lapTimes: r.standings[0].lapTimes.map(x => x.toFixed(1)),
    avgSpeed: (r.vehicles.reduce((a, v) => a + v.v, 0) / r.vehicles.length).toFixed(0) };
})()
