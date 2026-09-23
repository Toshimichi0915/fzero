import { MenuAction } from '../input/Input';
import { Track } from '../track/Track';
import { Vehicle } from '../vehicles/Vehicle';

export interface MenuItem {
  label: string;
  value?: () => string;
  left?: () => void;
  right?: () => void;
  action?: () => void;
  desc?: string;
}

const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

export const fmtTime = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${m}'${String(s).padStart(2, '0')}"${String(cs).padStart(2, '0')}`;
};
export const ordinal = (n: number) => {
  const s = ['TH', 'ST', 'ND', 'RD'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
};

export class MenuView {
  sel = 0;
  el: HTMLElement;
  private list: HTMLElement;
  private desc: HTMLElement | null;
  constructor(
    public container: HTMLElement,
    public items: MenuItem[],
    private onMove?: () => void,
    withDesc = true,
  ) {
    this.el = container;
    this.list = container.querySelector('.items') as HTMLElement;
    this.desc = withDesc ? h('<div class="desc"></div>') : null;
    this.render();
  }
  setItems(items: MenuItem[]) {
    this.items = items;
    this.sel = Math.min(this.sel, items.length - 1);
    this.render();
  }
  render() {
    this.list.innerHTML = '';
    this.items.forEach((it, i) => {
      const d = h(`<div class="item ${i === this.sel ? 'sel' : ''}"><span>${it.label}</span>${it.value ? `<span class="val">${it.value()}</span>` : ''}</div>`);
      d.addEventListener('mouseenter', () => {
        if (this.sel !== i) {
          this.sel = i;
          this.render();
          this.onMove?.();
        }
      });
      d.addEventListener('click', (e) => {
        this.sel = i;
        if (it.action) it.action();
        else if (it.right) {
          const rect = d.getBoundingClientRect();
          if ((e as MouseEvent).clientX < rect.left + rect.width * 0.6 && it.left) it.left();
          else it.right();
        }
        this.render();
      });
      this.list.appendChild(d);
    });
    if (this.desc) {
      this.desc.textContent = this.items[this.sel]?.desc ?? '';
      this.list.appendChild(this.desc);
    }
  }
  handle(a: MenuAction): boolean {
    const it = this.items[this.sel];
    const vertical = !this.list.classList.contains('horizontal');
    if ((vertical && a === 'up') || (!vertical && a === 'left')) {
      this.sel = (this.sel - 1 + this.items.length) % this.items.length;
      this.onMove?.();
    } else if ((vertical && a === 'down') || (!vertical && a === 'right')) {
      this.sel = (this.sel + 1) % this.items.length;
      this.onMove?.();
    } else if (a === 'left' && it?.left) {
      it.left();
      this.onMove?.();
    } else if (a === 'right' && it?.right) {
      it.right();
      this.onMove?.();
    } else if (a === 'confirm' && it) {
      if (it.action) it.action();
      else if (it.right) it.right();
      else return false;
    } else return false;
    this.render();
    return true;
  }
}

export class Minimap {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  private pts: { x: number; y: number; h: number }[][] = [];
  private bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private scale = 1;
  private bg: HTMLCanvasElement | null = null;
  constructor(public track: Track) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-map';
    this.ctx = this.canvas.getContext('2d')!;
    let minX = 1e9,
      maxX = -1e9,
      minZ = 1e9,
      maxZ = -1e9;
    for (const p of track.paths)
      for (let i = 0; i < p.n; i += 4) {
        minX = Math.min(minX, p.pos[i * 3]);
        maxX = Math.max(maxX, p.pos[i * 3]);
        minZ = Math.min(minZ, p.pos[i * 3 + 2]);
        maxZ = Math.max(maxZ, p.pos[i * 3 + 2]);
      }
    this.bounds = { minX, maxX, minZ, maxZ };
    for (const p of track.paths) {
      const arr = [];
      for (let i = 0; i < p.n; i += 8) arr.push({ x: p.pos[i * 3], y: p.pos[i * 3 + 2], h: p.pos[i * 3 + 1] });
      if (p.closed) arr.push(arr[0]);
      else arr.push({ x: p.pos[(p.n - 1) * 3], y: p.pos[(p.n - 1) * 3 + 2], h: p.pos[(p.n - 1) * 3 + 1] });
      this.pts.push(arr);
    }
  }
  private map(x: number, z: number): [number, number] {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const W = this.canvas.width,
      H = this.canvas.height;
    const s = Math.min((W - 30) / (maxX - minX), (H - 30) / (maxZ - minZ));
    this.scale = s;
    const ox = (W - (maxX - minX) * s) / 2,
      oy = (H - (maxZ - minZ) * s) / 2;
    return [ox + (x - minX) * s, oy + (z - minZ) * s];
  }
  private drawBg() {
    const W = this.canvas.width,
      H = this.canvas.height;
    const bg = document.createElement('canvas');
    bg.width = W;
    bg.height = H;
    const c = bg.getContext('2d')!;
    for (const [pass, width, color] of [
      [0, 9, 'rgba(0,0,0,0.55)'],
      [1, 4.5, 'rgba(60,242,255,0.35)'],
      [2, 2, 'rgba(210,250,255,0.95)'],
    ] as [number, number, string][]) {
      void pass;
      c.lineWidth = width * (W / 300);
      c.strokeStyle = color;
      c.lineJoin = 'round';
      c.lineCap = 'round';
      for (const arr of this.pts) {
        c.beginPath();
        arr.forEach((p, i) => {
          const [x, y] = this.map(p.x, p.y);
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        });
        c.stroke();
      }
    }
    // start line
    const m = this.track.main;
    const i = Math.round(this.track.startS / m.ds);
    const [sx, sy] = this.map(m.pos[i * 3], m.pos[i * 3 + 2]);
    c.fillStyle = '#fff';
    c.fillRect(sx - 3, sy - 7, 6, 14);
    this.bg = bg;
  }
  draw(vehicles: Vehicle[], player: Vehicle | null) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(this.canvas.clientWidth * dpr),
      H = Math.round(this.canvas.clientHeight * dpr);
    if (!W || !H) return;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.bg = null;
    }
    if (!this.bg) this.drawBg();
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.drawImage(this.bg!, 0, 0);
    const r = 3.2 * (W / 300);
    for (const v of vehicles) {
      if (v.retired || v === player) continue;
      const [x, y] = this.map(v.pos.x, v.pos.z);
      c.fillStyle = '#' + v.spec.thrust.getHexString();
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    if (player) {
      const [x, y] = this.map(player.pos.x, player.pos.z);
      c.fillStyle = '#fff';
      c.shadowColor = '#3cf2ff';
      c.shadowBlur = 12;
      c.beginPath();
      c.arc(x, y, r * 1.9, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
      c.fillStyle = '#ff2fa8';
      c.beginPath();
      c.arc(x, y, r * 1.0, 0, Math.PI * 2);
      c.fill();
    }
  }
}

/** DOM overlay: HUD + menus */
export class UI {
  root = document.getElementById('ui')!;
  hud: HTMLElement;
  title: HTMLElement;
  mainMenu: HTMLElement;
  select: HTMLElement;
  pause: HTMLElement;
  results: HTMLElement;
  controls: HTMLElement;
  loading: HTMLElement;
  minimap: Minimap;
  private el: Record<string, HTMLElement> = {};
  private msgTimer = 0;
  private toastEl: HTMLElement;
  private toastTimer = 0;
  private fpsAcc = 0;
  private fpsN = 0;
  showFps = false;

  constructor(track: Track) {
    this.loading = h(`<div class="loading">INITIALISING</div>`);
    this.root.appendChild(this.loading);
    this.hud = h(`<div class="layer hidden">
      <div class="hud-pos"><span class="n" data-k="pos">31</span><span class="suf" data-k="suf">ST</span><div class="of" data-k="of">/ 31</div></div>
      <div class="hud-rivals" data-k="rivals"></div>
      <div class="hud-lap"><div class="lap">LAP <b data-k="lap">1</b> / <span data-k="laps">3</span></div><div class="time" data-k="time">0'00"00</div><div class="laps" data-k="laptimes"></div></div>
      <div class="hud-energy"><div class="label"><span>POWER</span><span data-k="epct">100%</span></div><div class="bar"><div class="fill" data-k="efill"></div><div class="ticks"></div></div>
        <div class="boost" data-k="boost">BOOST LOCKED · LAP 2</div><div class="ko" data-k="ko"></div></div>
      <div class="hud-speed">
        <svg viewBox="0 0 100 100">
          <defs><linearGradient id="sg" x1="0" x2="1"><stop offset="0" stop-color="#ff2fa8"/><stop offset="0.6" stop-color="#3cf2ff"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>
          <path d="M 12 78 A 42 42 0 1 1 88 78" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="5" stroke-linecap="round"/>
          <path data-k="arc" d="M 12 78 A 42 42 0 1 1 88 78" fill="none" stroke="url(#sg)" stroke-width="5" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100" style="filter:drop-shadow(0 0 4px #3cf2ff)"/>
        </svg>
        <div class="val" data-k="speed">0</div><div class="unit">KM/H</div>
      </div>
      <div class="hud-msg" data-k="msg"></div>
      <div class="hud-count" data-k="count"></div>
      <div class="hud-hint" data-k="hint"></div>
      <div class="hud-fps" data-k="fps"></div>
    </div>`);
    this.minimap = new Minimap(track);
    this.hud.appendChild(this.minimap.canvas);
    this.root.appendChild(this.hud);
    this.hud.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));

    this.title = h(`<div class="layer hidden"><div class="menu-bg"></div>
      <div class="title"><div class="logo">NEON ZERO</div><div class="logo-sub">GRAND PRIX · 2099</div></div>
      <div class="press glow" style="color:#fff">PRESS <span data-k2="btn">✕</span> TO START</div>
      <div class="foot">30 RIVALS · 1 CITY · NO LIMITS — DualSense recommended</div></div>`);
    this.root.appendChild(this.title);
    this.mainMenu = h(`<div class="layer hidden"><div class="menu-bg"></div>
      <div class="title" style="top:8vh"><div class="logo" style="font-size:8vh">NEON ZERO</div></div>
      <div class="panel main-menu"><h2>MAIN MENU<small>SELECT MODE</small></h2><div class="items"></div></div></div>`);
    this.root.appendChild(this.mainMenu);
    this.controls = h(`<div class="panel controls-panel hidden"><h2>CONTROLS<small>DUALSENSE / KEYBOARD</small></h2>
      <table>
      <tr><td>Accelerate</td><td><b>R2</b> or <b>✕</b></td><td><b>W / ↑</b></td></tr>
      <tr><td>Steer</td><td><b>L-STICK</b> / <b>D-PAD</b></td><td><b>A D / ← →</b></td></tr>
      <tr><td>Air brake</td><td><b>L2</b></td><td><b>S / ↓</b></td></tr>
      <tr><td>Boost (lap 2+, costs power)</td><td><b>○</b></td><td><b>SPACE</b></td></tr>
      <tr><td>Lean / drift</td><td><b>L1 / R1</b></td><td><b>Q / E</b></td></tr>
      <tr><td>Side attack</td><td><b>double-tap L1/R1</b></td><td><b>double-tap Q/E</b></td></tr>
      <tr><td>Spin attack</td><td><b>□</b></td><td><b>F</b></td></tr>
      <tr><td>Air pitch (dive/float)</td><td><b>L-STICK ↕</b></td><td>—</td></tr>
      <tr><td>Camera</td><td><b>△</b></td><td><b>C</b></td></tr>
      <tr><td>Look back</td><td><b>TOUCHPAD</b></td><td><b>R</b></td></tr>
      <tr><td>Pause</td><td><b>OPTIONS</b></td><td><b>ESC / P</b></td></tr>
      </table>
      <p style="color:var(--dim);margin-top:2vh">Pit zone (pink strip, main straight) recharges power. Power at zero = one more hit and you're out. Adaptive triggers, lightbar & player LEDs need “Connect DualSense (HID)” in Settings (Chrome/Edge).</p></div>`);
    this.mainMenu.appendChild(this.controls);
    this.select = h(`<div class="layer hidden">
      <div class="panel select-panel"><h2 style="margin-bottom:1.5vh">MACHINE SELECT<small>◂ ▸ CHOOSE · ✕ CONFIRM · ○ BACK</small></h2>
        <div class="mname" data-k3="name"></div><div class="pilot" data-k3="pilot"></div><div class="blurb" data-k3="blurb"></div>
        <div data-k3="stats"></div><div class="dots" data-k3="dots"></div>
        <div class="items" style="margin-top:2vh"></div></div></div>`);
    this.root.appendChild(this.select);
    this.pause = h(`<div class="layer hidden"><div class="menu-bg" style="background:rgba(0,0,10,.55)"></div><div class="panel pause"><h2>PAUSED</h2><div class="items"></div></div></div>`);
    this.root.appendChild(this.pause);
    this.results = h(`<div class="layer hidden"><div class="menu-bg" style="background:rgba(0,0,10,.5)"></div><div class="panel results">
      <h2>RACE RESULTS<small>NEON CITY CIRCUIT</small></h2>
      <div class="big"><div class="place" data-k4="place">1ST</div><div class="info" data-k4="info"></div></div>
      <div class="tbl" data-k4="tbl"></div>
      <div class="items horizontal"></div></div></div>`);
    this.root.appendChild(this.results);
    this.toastEl = h(`<div class="toast hidden"></div>`);
    this.root.appendChild(this.toastEl);
  }

  show(layer: 'hud' | 'title' | 'mainMenu' | 'select' | 'pause' | 'results' | null, keepHud = false) {
    for (const k of ['hud', 'title', 'mainMenu', 'select', 'pause', 'results'] as const) {
      const on = k === layer || (keepHud && k === 'hud');
      this[k].classList.toggle('hidden', !on);
    }
  }
  doneLoading() {
    this.loading.style.transition = 'opacity 1s';
    this.loading.style.opacity = '0';
    setTimeout(() => this.loading.remove(), 1100);
  }
  toast(text: string, ms = 2500) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    this.toastTimer = ms / 1000;
  }
  setPadGlyphs(pad: boolean) {
    const b = this.title.querySelector('[data-k2="btn"]');
    if (b) b.textContent = pad ? '✕' : 'ENTER';
  }

  message(text: string, sub = '', ms = 1800, color = '#fff') {
    const m = this.el.msg;
    m.innerHTML = `${text}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    m.style.color = color;
    m.classList.add('show', 'glow');
    this.msgTimer = ms / 1000;
  }
  countdown(n: number) {
    const c = this.el.count;
    c.textContent = n > 0 ? String(n) : 'GO!';
    c.style.color = n > 0 ? '#fff' : '#ffcf3a';
    c.classList.remove('pop');
    void c.offsetWidth;
    c.classList.add('pop', 'glow');
  }
  hint(text: string) {
    this.el.hint.textContent = text;
  }

  update(dt: number) {
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.el.msg.classList.remove('show');
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.add('hidden');
    }
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.el.fps.textContent = this.showFps ? `${Math.round(this.fpsN / this.fpsAcc)} FPS` : '';
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
  }

  updateHud(d: {
    place: number;
    total: number;
    lap: number;
    laps: number;
    time: number;
    lapTimes: number[];
    energy: number;
    boostReady: boolean;
    boostUnlocked: boolean;
    speed: number;
    speedFrac: number;
    kos: number;
    rivals: { place: number; name: string; me: boolean; gap: string }[];
  }) {
    const e = this.el;
    e.pos.textContent = String(d.place);
    e.suf.textContent = ordinal(d.place);
    e.of.textContent = `/ ${d.total}`;
    e.lap.textContent = String(Math.max(1, Math.min(d.laps, d.lap + 1)));
    e.laps.textContent = String(d.laps);
    e.time.textContent = fmtTime(d.time);
    const best = d.lapTimes.length ? Math.min(...d.lapTimes) : -1;
    e.laptimes.innerHTML = d.lapTimes.map((t, i) => `<div class="${t === best && d.lapTimes.length > 1 ? 'best' : ''}">L${i + 1} ${fmtTime(t)}</div>`).join('');
    const en = Math.max(0, d.energy);
    e.epct.textContent = `${Math.ceil(en)}%`;
    e.efill.style.transform = `scaleX(${en / 100})`;
    e.efill.classList.toggle('low', en < 25);
    e.boost.textContent = !d.boostUnlocked ? 'BOOST LOCKED · LAP 2' : d.boostReady ? 'BOOST READY ○' : 'BOOST ···';
    e.boost.classList.toggle('ready', d.boostUnlocked && d.boostReady);
    e.ko.textContent = d.kos ? `K.O. × ${d.kos}` : '';
    e.speed.textContent = String(Math.round(d.speed));
    e.arc.setAttribute('stroke-dasharray', `${Math.min(100, d.speedFrac * 78).toFixed(1)} 100`);
    e.rivals.innerHTML = d.rivals.map((r) => `<div class="${r.me ? 'me' : ''}"><span class="p">${r.place}</span>${r.name} <span style="opacity:.6">${r.gap}</span></div>`).join('');
  }

  setSelect(info: { name: string; pilot: string; blurb: string; stats: [string, number][]; index: number; count: number }) {
    const q = (k: string) => this.select.querySelector(`[data-k3="${k}"]`) as HTMLElement;
    q('name').textContent = info.name;
    q('pilot').textContent = 'PILOT · ' + info.pilot;
    q('blurb').textContent = info.blurb;
    q('stats').innerHTML = info.stats.map(([n, v]) => `<div class="stat"><span class="nm">${n}</span><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div></div>`).join('');
    q('dots').innerHTML = Array.from({ length: info.count }, (_, i) => `<i class="${i === info.index ? 'on' : ''}"></i>`).join('');
  }

  setResults(place: number, info: string, rows: { place: number; name: string; time: string; me: boolean }[]) {
    const q = (k: string) => this.results.querySelector(`[data-k4="${k}"]`) as HTMLElement;
    q('place').textContent = place > 0 ? `${place}${ordinal(place)}` : 'RETIRED';
    q('info').innerHTML = info;
    q('tbl').innerHTML = rows.map((r) => `<div class="row ${r.me ? 'me' : ''}"><span class="p">${r.place}</span><span class="n">${r.name}</span><span class="t">${r.time}</span></div>`).join('');
  }
}
