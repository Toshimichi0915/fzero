import * as THREE from 'three';
import { GameRenderer } from '../core/Renderer';
import { World } from '../world/World';
import { Race } from './Race';
import { ChaseCamera, CAMERA_MODES } from './ChaseCamera';
import { CineCamera } from './CineCamera';
import { Input, MenuAction } from '../input/Input';
import { PLAYER_LED_PATTERNS, DualSenseHID } from '../input/DualSenseHID';
import { globalUniforms } from '../shaders/common';
import { UI, MenuView, MenuItem, fmtTime, ordinal } from '../ui/UI';
import { AudioEngine } from '../audio/Audio';
import { PLAYER_MACHINES, playerSpec } from './Roster';
import { buildMachine } from '../vehicles/VehicleModel';
import { VehicleEvent, SPEED_TO_KMH } from '../vehicles/Vehicle';
import { clamp } from '../core/util';
import { decorUniforms } from '../world/Decor';
import { Rain } from '../fx/Rain';
import { reflectionUniforms, ROAD_LAYER } from '../fx/RoadReflection';

type State = 'title' | 'menu' | 'select' | 'race' | 'paused' | 'results';

const DIFFS = [
  { name: 'NOVICE', skill: 0.9 },
  { name: 'STANDARD', skill: 0.97 },
  { name: 'EXPERT', skill: 1.02 },
  { name: 'MASTER', skill: 1.07 },
];

interface Settings {
  res: number;
  music: number;
  sfx: number;
  vibration: boolean;
  camera: number;
  fps: boolean;
  laps: number;
  diff: number;
  machine: number;
  rain: boolean;
}

const DEFAULTS: Settings = { res: 1, music: 0.55, sfx: 0.9, vibration: true, camera: 0, fps: false, laps: 3, diff: 1, machine: 0, rain: false };

export class Game {
  race: Race;
  chase: ChaseCamera;
  cine: CineCamera;
  input = new Input();
  ui: UI;
  audio = new AudioEngine();
  state: State = 'title';
  time = 0;
  settings: Settings;
  private menu!: MenuView;
  private pauseMenu!: MenuView;
  private resultsMenu!: MenuView;
  private selectMenu!: MenuView;
  private menuMode: 'main' | 'settings' = 'main';
  private lastCount = 99;
  private finishTimer = 0;
  private showroom = new THREE.Group();
  private showroomModels: THREE.Group[] = [];
  private showroomAngle = 0;
  private rocketWindow = -1;
  private camVel = new THREE.Vector3();
  private lastCamPos = new THREE.Vector3();
  private flash = 0;
  private titleTime = 0;
  debugCam: ((c: THREE.PerspectiveCamera) => void) | null = null;
  rain = new Rain();

  constructor(
    public gr: GameRenderer,
    public world: World,
    public camera: THREE.PerspectiveCamera,
  ) {
    this.settings = { ...DEFAULTS, ...this.loadSettings() };
    this.race = new Race(world);
    this.chase = new ChaseCamera(camera);
    this.chase.mode = this.settings.camera;
    this.cine = new CineCamera(camera);
    this.world.scene.userData.camPos = camera.position;
    this.ui = new UI(world.track);
    this.ui.showFps = this.settings.fps;
    this.gr.setQuality(this.settings.res);
    this.race.listeners.push((e) => this.onEvent(e));
    this.buildMenus();
    this.buildShowroom();
    this.rain.mesh.layers.set(ROAD_LAYER);
    this.world.scene.add(this.rain.mesh);
    this.applyWeather();
    const q = new URLSearchParams(location.search);
    if (q.has('race')) {
      this.settings.machine = Number(q.get('m') ?? this.settings.machine);
      this.startRace();
    } else this.toTitle();
    setTimeout(() => this.ui.doneLoading(), 300);
    // audio needs a gesture: unlock on any interaction
    const unlock = () => {
      this.audio.init();
      this.audio.setVolumes(0.8, this.settings.music, this.settings.sfx);
      this.syncMusic();
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
  }

  // ---------------------------------------------------------------- settings
  private loadSettings(): Partial<Settings> {
    try {
      return JSON.parse(localStorage.getItem('neonzero.settings') || '{}');
    } catch {
      return {};
    }
  }
  private saveSettings() {
    try {
      localStorage.setItem('neonzero.settings', JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- menus
  private buildMenus() {
    const move = () => this.audio.menuMove();
    const s = this.settings;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const mainItems: MenuItem[] = [
      { label: 'GRAND PRIX', desc: '31 machines. 1 winner. Neon City Circuit.', action: () => this.toSelect() },
      {
        label: 'SETTINGS',
        desc: 'Graphics, audio, controller.',
        action: () => {
          this.menuMode = 'settings';
          this.menu.sel = 0;
          this.menu.setItems(settingsItems);
        },
      },
      {
        label: 'CONTROLS',
        desc: 'Show the control layout.',
        action: () => this.ui.controls.classList.toggle('hidden'),
      },
    ];
    const settingsItems: MenuItem[] = [
      {
        label: 'RESOLUTION',
        value: () => pct(s.res),
        desc: 'Render scale. Lower for more FPS.',
        left: () => this.setRes(Math.max(0.5, s.res - 0.125)),
        right: () => this.setRes(Math.min(1.5, s.res + 0.125)),
      },
      {
        label: 'MUSIC',
        value: () => pct(s.music),
        left: () => this.setVol('music', -0.1),
        right: () => this.setVol('music', 0.1),
      },
      {
        label: 'EFFECTS',
        value: () => pct(s.sfx),
        left: () => this.setVol('sfx', -0.1),
        right: () => this.setVol('sfx', 0.1),
      },
      {
        label: 'VIBRATION',
        value: () => (s.vibration ? 'ON' : 'OFF'),
        left: () => this.toggle('vibration'),
        right: () => this.toggle('vibration'),
      },
      {
        label: 'CAMERA',
        value: () => CAMERA_MODES[s.camera],
        left: () => {
          s.camera = (s.camera + CAMERA_MODES.length - 1) % CAMERA_MODES.length;
          this.chase.mode = s.camera;
          this.saveSettings();
        },
        right: () => {
          s.camera = (s.camera + 1) % CAMERA_MODES.length;
          this.chase.mode = s.camera;
          this.saveSettings();
        },
      },
      {
        label: 'WEATHER',
        value: () => (s.rain ? 'NEON RAIN' : 'CLEAR'),
        desc: 'Neon rain: soaked, mirror-like track and rain streaks.',
        left: () => this.toggleRain(),
        right: () => this.toggleRain(),
      },
      {
        label: 'SHOW FPS',
        value: () => (s.fps ? 'ON' : 'OFF'),
        left: () => this.toggle('fps'),
        right: () => this.toggle('fps'),
      },
      {
        label: 'CONNECT DUALSENSE (HID)',
        desc: DualSenseHID.supported() ? 'Enables adaptive triggers, lightbar & player LEDs (click / ✕ then pick the controller).' : 'WebHID not available in this browser — use Chrome or Edge.',
        action: () => this.connectHid(),
      },
      {
        label: 'BACK',
        action: () => {
          this.menuMode = 'main';
          this.menu.sel = 1;
          this.menu.setItems(mainItems);
        },
      },
    ];
    this.menu = new MenuView(this.ui.mainMenu.querySelector('.main-menu')!, mainItems, move);

    this.selectMenu = new MenuView(
      this.ui.select.querySelector('.select-panel')!,
      [
        {
          label: 'MACHINE',
          value: () => PLAYER_MACHINES[s.machine].name,
          left: () => this.pickMachine(-1),
          right: () => this.pickMachine(1),
        },
        {
          label: 'LAPS',
          value: () => String(s.laps),
          left: () => {
            s.laps = Math.max(1, s.laps - 1);
            this.saveSettings();
          },
          right: () => {
            s.laps = Math.min(9, s.laps + 1);
            this.saveSettings();
          },
        },
        {
          label: 'CLASS',
          value: () => DIFFS[s.diff].name,
          left: () => {
            s.diff = Math.max(0, s.diff - 1);
            this.saveSettings();
          },
          right: () => {
            s.diff = Math.min(DIFFS.length - 1, s.diff + 1);
            this.saveSettings();
          },
        },
        { label: 'START RACE', action: () => this.startRace() },
      ],
      move,
      false,
    );
    this.selectMenu.sel = 3;
    this.selectMenu.render();

    this.pauseMenu = new MenuView(
      this.ui.pause.querySelector('.pause')!,
      [
        { label: 'RESUME', action: () => this.resume() },
        { label: 'RESTART', action: () => this.startRace() },
        {
          label: `CAMERA`,
          value: () => CAMERA_MODES[this.chase.mode],
          right: () => {
            this.chase.mode = (this.chase.mode + 1) % CAMERA_MODES.length;
            s.camera = this.chase.mode;
            this.saveSettings();
          },
          left: () => {
            this.chase.mode = (this.chase.mode + CAMERA_MODES.length - 1) % CAMERA_MODES.length;
            s.camera = this.chase.mode;
            this.saveSettings();
          },
        },
        { label: 'QUIT TO MENU', action: () => this.toMenu() },
      ],
      move,
      false,
    );
    this.resultsMenu = new MenuView(
      this.ui.results.querySelector('.results')!,
      [
        { label: 'RETRY', action: () => this.startRace() },
        { label: 'MACHINE SELECT', action: () => this.toSelect() },
        { label: 'MAIN MENU', action: () => this.toMenu() },
      ],
      move,
      false,
    );
  }
  private setRes(v: number) {
    this.settings.res = v;
    this.gr.setQuality(v);
    this.saveSettings();
  }
  private setVol(k: 'music' | 'sfx', d: number) {
    this.settings[k] = clamp(Math.round((this.settings[k] + d) * 10) / 10, 0, 1);
    this.audio.setVolumes(0.8, this.settings.music, this.settings.sfx);
    this.saveSettings();
  }
  private toggleRain() {
    this.settings.rain = !this.settings.rain;
    this.saveSettings();
    this.applyWeather();
  }
  private applyWeather() {
    const on = this.settings.rain;
    this.rain.set(on);
    reflectionUniforms.uWet.value = on ? 1.45 : 1;
    globalUniforms.uFogDensity.value = on ? 0.00062 : 0.00045;
  }
  private toggle(k: 'vibration' | 'fps') {
    this.settings[k] = !this.settings[k];
    if (k === 'fps') this.ui.showFps = this.settings.fps;
    this.saveSettings();
  }
  private async connectHid() {
    try {
      const ok = await this.input.hid.connect();
      this.ui.toast(ok ? `DualSense connected (${this.input.hid.bt ? 'Bluetooth' : 'USB'}) — adaptive triggers on` : 'No controller selected');
    } catch (e) {
      this.ui.toast('HID connection failed: ' + (e as Error).message, 4000);
    }
  }

  private buildShowroom() {
    const g = this.showroom;
    const tower = this.world.track.towers[0].pos;
    g.position.set(tower.x + 260, 330, tower.z - 180);
    // platform
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 9.5, 0.6, 64),
      new THREE.MeshPhysicalMaterial({ color: 0x07080d, metalness: 0.6, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4 }),
    );
    disc.position.y = -0.3;
    g.add(disc);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(9.3 + i * 1.6, 0.06 + (2 - i) * 0.03, 8, 128), new THREE.MeshBasicMaterial({ color: new THREE.Color(i % 2 ? 4 : 0.3, i % 2 ? 0.5 : 2, i % 2 ? 2.5 : 4) }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -0.05 - i * 0.5;
      g.add(ring);
    }
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 9, 60, 48, 1, true),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: globalUniforms.uTime },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
        fragmentShader: `uniform float uTime; varying vec2 vUv; void main(){ float a = pow(1. - vUv.y, 8.) * .12 + pow(fract(vUv.y * 20. - uTime * .5), 30.) * .05 * (1. - vUv.y); gl_FragColor = vec4(vec3(.2,.7,1.) * a, 1.); }`,
      }),
    );
    beam.position.y = 30;
    beam.visible = false;
    g.add(beam);
    // soft rim lights (kept high & wide so the platform gets no hard hotspots)
    const rim = new THREE.SpotLight(0x88ccff, 900, 60, 0.7, 0.9, 1.6);
    rim.position.set(10, 22, 10);
    rim.target.position.set(0, 0, 0);
    g.add(rim, rim.target);
    const rim2 = new THREE.SpotLight(0xff3399, 700, 60, 0.7, 0.9, 1.6);
    rim2.position.set(-12, 16, -8);
    rim2.target.position.set(0, 0, 0);
    g.add(rim2, rim2.target);
    for (let i = 0; i < PLAYER_MACHINES.length; i++) {
      const m = buildMachine(playerSpec(i));
      m.group.position.y = 1.2;
      m.group.visible = false;
      g.add(m.group);
      this.showroomModels.push(m.group);
    }
    g.visible = false;
    this.world.scene.add(g);
  }

  private pickMachine(d: number) {
    const s = this.settings;
    s.machine = (s.machine + d + PLAYER_MACHINES.length) % PLAYER_MACHINES.length;
    this.saveSettings();
    this.updateSelectInfo();
  }
  private updateSelectInfo() {
    const m = PLAYER_MACHINES[this.settings.machine];
    const norm = (v: number, a: number, b: number) => clamp((v - a) / (b - a), 0.08, 1);
    this.ui.setSelect({
      name: m.name,
      pilot: m.pilot,
      blurb: m.blurb,
      stats: [
        ['TOP SPEED', norm(m.maxSpeed, 158, 184)],
        ['ACCEL', norm(m.accel, 36, 54)],
        ['HANDLING', norm(m.turn * m.grip, 7, 15.5)],
        ['BODY', norm(1.4 - m.body, 0.05, 0.8)],
        ['BOOST', norm(m.boost, 0.8, 1.2)],
      ],
      index: this.settings.machine,
      count: PLAYER_MACHINES.length,
    });
    this.showroomModels.forEach((g, i) => (g.visible = i === this.settings.machine));
    this.input.hid.light = hexToRgb(m.thrust);
  }

  // ---------------------------------------------------------------- flow
  private syncMusic() {
    const mu = this.audio.music;
    if (!mu) return;
    if (this.state === 'race' || this.state === 'paused') mu.setMode(this.race.state === 'countdown' && this.race.countdown > 3.5 ? 'title' : 'race');
    else if (this.state === 'results') mu.setMode('results');
    else mu.setMode('title');
  }
  private attractRace() {
    this.race.setup(Math.floor(Math.random() * 4), 99, true);
    this.cine.forceTarget = null;
    this.cine.cut(this.race.vehicles, this.world.track);
    // pre-roll so the field is spread out and moving
    for (let i = 0; i < 60 * 12; i++) this.race.update(1 / 60);
  }
  toTitle() {
    this.state = 'title';
    this.titleTime = 0;
    this.attractRace();
    this.ui.show('title');
    this.showroom.visible = false;
    this.audio.silenceEngine();
    this.syncMusic();
  }
  toMenu() {
    if (this.state === 'race' || this.state === 'paused' || this.state === 'results') this.attractRace();
    this.state = 'menu';
    this.menuMode = 'main';
    this.ui.show('mainMenu');
    this.showroom.visible = false;
    this.audio.silenceEngine();
    this.syncMusic();
  }
  toSelect() {
    this.state = 'select';
    this.ui.show('select');
    this.ui.controls.classList.add('hidden');
    this.showroom.visible = true;
    this.updateSelectInfo();
    this.audio.silenceEngine();
    this.syncMusic();
  }
  startRace() {
    this.state = 'race';
    this.showroom.visible = false;
    this.race.setup(this.settings.machine, this.settings.laps, false);
    const skill = DIFFS[this.settings.diff].skill;
    for (const ai of this.race.ais) ai.p.skill *= skill;
    this.chase.snap();
    this.lastCount = 99;
    this.finishTimer = 0;
    this.rocketWindow = -1;
    this.ui.show('hud');
    this.ui.hint('');
    this.ui.message('NEON CITY CIRCUIT', `${this.settings.laps} LAPS · ${DIFFS[this.settings.diff].name} CLASS`, 2600);
    this.syncMusic();
  }
  private pause() {
    this.state = 'paused';
    this.ui.show('pause', true);
    this.audio.silenceEngine();
  }
  private resume() {
    this.state = 'race';
    this.ui.show('hud');
    this.input.clearMenu();
  }
  private showResults() {
    this.state = 'results';
    const r = this.race;
    const p = r.player;
    const rows = r.standings.map((v) => {
      const L = r.world.track.lapLength;
      const gap = r.laps * L - v.raceDist;
      const est = v.retired ? 'RETIRED' : gap > L ? `+${Math.floor(gap / L)} LAP` : `+${(gap / Math.max(60, v.v)).toFixed(1)}s`;
      return { place: v.place, name: v === p ? `▶ ${v.name} (${v.spec.name})` : `${v.name} · ${v.spec.name}`, time: v.finished ? fmtTime(v.finishTime) : est, me: v === p };
    });
    const best = p.lapTimes.length ? Math.min(...p.lapTimes) : 0;
    const info = p.retired
      ? `Machine destroyed on lap <b>${Math.max(1, p.lap + 1)}</b><br/>K.O.s: <b>${p.kos}</b>`
      : `Total time <b>${fmtTime(p.finishTime)}</b><br/>Best lap <b>${fmtTime(best)}</b><br/>K.O.s <b>${p.kos}</b> · Machine <b>${p.spec.name}</b>`;
    this.ui.setResults(p.retired ? 0 : p.place, info, rows);
    this.ui.show('results');
    this.audio.silenceEngine();
    this.syncMusic();
    this.audio.finish(p.place);
  }

  // ---------------------------------------------------------------- events
  private onEvent(e: VehicleEvent) {
    const p = this.race.player;
    const inRace = this.state === 'race' && !this.race.attract;
    const vib = this.settings.vibration;
    const now = this.time;
    const near = (pos: THREE.Vector3, r: number) => pos.distanceTo(this.camera.position) < r;
    switch (e.type) {
      case 'wall':
        if (e.v === p && inRace) {
          this.audio.wallHit(e.strength);
          this.chase.addShake(Math.min(1, 0.2 + e.strength / 30));
          if (vib) this.input.rumble(Math.min(1, 0.3 + e.strength / 25), 0.8, 160, now);
          this.flash = Math.max(this.flash, Math.min(0.6, e.strength / 40));
        } else if (near(e.pos, 60)) this.audio.wallHit(e.strength * 0.4);
        break;
      case 'hit':
        if ((e.a === p || e.b === p) && inRace) {
          this.audio.carHit(e.strength);
          this.chase.addShake(Math.min(1.2, 0.3 + e.strength / 20));
          if (vib) this.input.rumble(Math.min(1, 0.5 + e.strength / 20), 0.6, 200, now);
          this.flash = Math.max(this.flash, 0.3);
        } else if (near(e.pos, 50)) this.audio.carHit(e.strength * 0.4);
        break;
      case 'boost':
        if (e.v === p && inRace) {
          this.audio.boost();
          this.chase.addShake(0.4);
          if (vib) this.input.rumble(0.6, 1, 400, now);
        }
        break;
      case 'boostpad':
        if (e.v === p && inRace) {
          this.audio.boostPad();
          this.chase.addShake(0.3);
          if (vib) this.input.rumble(0.3, 0.9, 250, now);
        }
        break;
      case 'land':
        if (e.v === p && inRace) {
          this.audio.land(e.strength);
          this.chase.addShake(Math.min(1.2, e.strength / 25));
          if (vib) this.input.rumble(Math.min(1, e.strength / 30), 0.3, 220, now);
        }
        break;
      case 'launch':
        if (e.v === p && inRace) this.ui.message('', '', 10);
        break;
      case 'fall':
        if (e.v === p && inRace) {
          this.audio.fall();
          this.ui.message('COURSE OUT', 'RESCUE DRONE DEPLOYED · −15 POWER', 1800, '#ff2fa8');
        }
        break;
      case 'explode':
        if (near(e.v.pos, 250)) this.audio.explosion();
        if (e.v === p && inRace) {
          this.ui.message('MACHINE DESTROYED', 'RETIRED', 2500, '#ff2f4a');
          if (vib) this.input.rumble(1, 1, 900, now);
          this.chase.addShake(1.5);
          this.finishTimer = 3;
        }
        break;
      case 'ko':
        e.attacker.kos++;
        if (e.attacker === p && inRace) {
          this.audio.ko();
          this.ui.message('K.O.!', `${e.victim.name} ELIMINATED`, 1600, '#ffcf3a');
        }
        break;
      case 'lap':
        if (e.v === p && inRace && e.lap >= 1 && e.lap < this.race.laps) {
          const final = e.lap === this.race.laps - 1;
          this.audio.lap(final);
          const lt = p.lapTimes[p.lapTimes.length - 1];
          if (final) this.ui.message('FINAL LAP', `LAP TIME ${fmtTime(lt)}`, 2200, '#ffcf3a');
          else if (e.lap === 1) this.ui.message(`LAP ${e.lap + 1}`, 'BOOST POWER UNLOCKED — PRESS ○', 2400, '#3cf2ff');
          else this.ui.message(`LAP ${e.lap + 1}`, `LAP TIME ${fmtTime(lt)}`, 1800);
        }
        if (e.v === p && inRace && e.lap >= this.race.laps) {
          this.ui.message('FINISH', `${p.place}${ordinal(p.place)} PLACE`, 3500, p.place <= 3 ? '#ffcf3a' : '#fff');
          this.finishTimer = 4.5;
          this.cine.forceTarget = p;
          this.cine.cut(this.race.vehicles, this.world.track);
        }
        break;
    }
  }

  // ---------------------------------------------------------------- frame
  frame(dt: number) {
    this.time += dt;
    const input = this.input;
    input.poll(dt, this.time);
    this.ui.setPadGlyphs(input.lastDevice === 'pad');
    const actions = input.menu();
    for (const a of actions) {
      const st = this.state;
      this.handleMenu(a);
      if (this.state !== st) break; // one transition per frame
    }

    const r = this.race;
    const p = r.player;
    let useCine = false;
    switch (this.state) {
      case 'title':
      case 'menu':
        r.update(dt);
        useCine = true;
        this.titleTime += dt;
        break;
      case 'select':
        r.update(dt);
        break;
      case 'race': {
        if (!p.finished && !p.retired && !r.autopilot) input.fillControls(p.controls);
        // rocket start: press throttle during the last moment of the countdown
        if (r.state === 'countdown') {
          if (p.controls.throttle > 0.5 && this.rocketWindow < 0) this.rocketWindow = r.countdown;
          if (p.controls.throttle < 0.1) this.rocketWindow = -1;
        }
        const wasCountdown = r.state === 'countdown';
        r.update(dt);
        if (wasCountdown && r.state === 'race' && this.rocketWindow >= 0 && this.rocketWindow < 0.45) {
          p.v = p.spec.maxSpeed * 0.55;
          p.padBoost = 1.5;
          this.ui.message('ROCKET START!', '', 1400, '#ffcf3a');
          this.audio.boostPad();
        }
        this.updateCountdown();
        if (p.finished || p.retired) {
          useCine = p.finished;
          this.finishTimer -= dt;
          if (this.finishTimer <= 0) this.showResults();
        }
        break;
      }
      case 'paused':
        break;
      case 'results':
        r.update(dt);
        useCine = true;
        break;
    }

    // ---- camera
    const frac = Math.min(1.3, p.v / p.spec.maxSpeed);
    const boost = p.boosting ? 1 : 0;
    if (this.state === 'select') {
      this.showroomAngle += dt * 0.25;
      const c = this.showroom.position;
      const R = 15;
      const cx = c.x + Math.cos(this.showroomAngle) * R,
        cz = c.z + Math.sin(this.showroomAngle) * R;
      this.camera.position.set(cx, c.y + 3.6 + Math.sin(this.time * 0.3) * 0.6, cz);
      this.camera.up.set(0, 1, 0);
      // aim left of the machine so it sits in the right half of the screen (panel on the left)
      const toC = new THREE.Vector3(c.x - cx, 0, c.z - cz).normalize();
      const rightV = new THREE.Vector3(-toC.z, 0, toC.x);
      this.camera.lookAt(c.x - rightV.x * 5.5, c.y + 0.6, c.z - rightV.z * 5.5);
      this.camera.fov = 42;
      this.camera.updateProjectionMatrix();
      const m = this.showroomModels[this.settings.machine];
      m.rotation.y = -this.showroomAngle * 0.4;
      m.position.y = 1.4 + Math.sin(this.time * 1.6) * 0.15;
      this.gr.speed.strength = 0;
      this.gr.bloom.intensity = 0.35;
    } else if (useCine || this.state === 'paused') {
      if (this.state !== 'paused') this.cine.update(dt, r.vehicles, this.world.track);
      this.gr.speed.strength = 0;
      this.gr.speed.boost = 0;
    } else {
      if (!this.race.attract && !p.retired) {
        this.chase.update(dt, p, frac, boost);
        r.speedLines(this.camera, p, frac, boost);
      }
      this.gr.speed.strength = Math.max(0, frac - 0.45) * 0.06 + boost * 0.045;
      this.gr.speed.boost = boost;
    }
    if (this.state !== 'select') this.gr.bloom.intensity = 1.15;
    this.camVel.subVectors(this.camera.position, this.lastCamPos).divideScalar(Math.max(dt, 1e-4));
    if (this.camVel.length() > 600) this.camVel.set(0, 0, 0); // camera cut
    this.rain.uniforms.uCamVel.value.lerp(this.camVel, 0.3);
    this.lastCamPos.copy(this.camera.position);

    // ---- start lights
    if (this.state === 'race' || this.state === 'paused') {
      const c = r.countdown;
      decorUniforms.uStartLights.value = r.state === 'countdown' ? (c <= 1 ? 3 : c <= 2 ? 2 : c <= 3 ? 1 : 0) : r.raceTime < 4 ? 4 : 0;
    } else decorUniforms.uStartLights.value = 0;

    // ---- HUD
    if (this.state === 'race' || this.state === 'paused') this.updateHud(frac);
    this.ui.update(dt);
    if (this.state === 'race' || this.state === 'results' || this.state === 'paused') this.ui.minimap.draw(r.vehicles, p);

    // ---- overlay effects
    this.flash = Math.max(0, this.flash - dt * 2.5);
    const ov = this.gr.overlay.uniforms;
    ov.get('amount')!.value = this.flash;
    ov.get('time')!.value = this.time;
    ov.get('lowEnergy')!.value = this.state === 'race' && !p.retired && p.energy < 20 ? 1 - p.energy / 20 : 0;
    this.gr.chroma.offset.set(0.0006 + boost * 0.0015 + this.flash * 0.004, 0.0004 + boost * 0.001);

    // ---- audio
    const racingPlayer = this.state === 'race' && !p.retired && r.started;
    const others = r.vehicles
      .filter((v) => v !== p && !v.retired && v.object.visible)
      .sort((a, b) => a.pos.distanceToSquared(this.camera.position) - b.pos.distanceToSquared(this.camera.position))
      .slice(0, 5)
      .map((v) => ({ pos: v.pos, vel: v.vel, throttle: v.throttleVis }));
    if (this.state !== 'paused')
      this.audio.update(
        dt,
        this.camera,
        {
          v: p.v,
          max: p.spec.maxSpeed,
          throttle: this.state === 'race' ? p.throttleVis : 0,
          boost: p.boosting,
          air: p.air,
          active: this.state === 'race' && !p.retired,
          energy: racingPlayer ? p.energy : 100,
          scraping: racingPlayer && p.wallScrape > 0 ? 1 : 0,
        },
        this.state === 'select' ? [] : others,
        this.camVel,
      );
    this.updateController(racingPlayer, frac);

    // ---- render
    if (this.debugCam) this.debugCam(this.camera);
    this.world.update(dt, this.time, this.camera);
    globalUniforms.uCamPos.value.copy(this.camera.position);
    // planar road reflection about the road under the followed machine
    const follow = useCine ? this.cine.target : this.state === 'select' ? null : p;
    this.camera.updateMatrixWorld();
    if (follow && !follow.air) {
      const pt = follow.pos.clone().addScaledVector(follow.trackUp, -follow.h);
      this.gr.reflection.render(this.world.scene, this.camera, pt, follow.trackUp);
    } else this.gr.reflection.disable();
    this.gr.render(dt);
  }

  private updateCountdown() {
    const r = this.race;
    if (r.state !== 'countdown') {
      if (this.lastCount > 0 && this.lastCount < 99) {
        this.ui.countdown(0);
        this.audio.countdown(0);
        this.lastCount = 0;
        this.syncMusic();
      }
      return;
    }
    const n = Math.ceil(r.countdown);
    if (n <= 3 && n !== this.lastCount) {
      this.lastCount = n;
      this.ui.countdown(n);
      this.audio.countdown(n);
      this.ui.hint('HOLD R2 / ✕ AS “GO” APPEARS FOR A ROCKET START');
    }
    if (r.countdown < 1) this.ui.hint('');
  }

  private updateHud(frac: number) {
    const r = this.race;
    const p = r.player;
    const idx = r.standings.indexOf(p);
    const rivals = r.standings.slice(Math.max(0, idx - 2), idx + 3).map((v) => {
      const gapM = v.raceDist - p.raceDist;
      const gapS = gapM / Math.max(50, p.v);
      return { place: v.place, name: v === p ? 'YOU' : v.name, me: v === p, gap: v === p ? '' : `${gapS > 0 ? '+' : ''}${gapS.toFixed(1)}s` };
    });
    this.ui.updateHud({
      place: p.place,
      total: r.vehicles.length,
      lap: Math.max(0, p.lap),
      laps: r.laps,
      time: r.raceTime,
      lapTimes: p.lapTimes,
      energy: p.energy,
      boostReady: p.energy > 12 && p.boostTime <= 0,
      boostUnlocked: p.lap >= 1,
      speed: p.v * SPEED_TO_KMH,
      speedFrac: frac,
      kos: p.kos,
      rivals,
    });
  }

  private updateController(active: boolean, frac: number) {
    const hid = this.input.hid;
    if (!hid.connected) return;
    const p = this.race.player;
    const vib = this.settings.vibration;
    if (active) {
      if (p.energy < 20) {
        const on = Math.sin(this.time * 12) > 0;
        hid.light = on ? [255, 0, 20] : [40, 0, 0];
      } else if (p.boosting) hid.light = [255, 255, 255];
      else hid.light = hexToRgb(p.spec.thrust.getHex());
      hid.playerLeds = PLAYER_LED_PATTERNS[clamp(p.lap + 1, 1, 5)];
      if (vib) {
        if (p.air) hid.trigR = { mode: 'off' };
        else if (p.boosting) hid.trigR = { mode: 'vibration', position: 2, amplitude: 6, frequency: 35 };
        else hid.trigR = { mode: 'feedback', position: 1, strength: Math.round(1 + frac * 5) };
        hid.trigL = { mode: 'feedback', position: 3, strength: 5 };
      } else {
        hid.trigR = hid.trigL = { mode: 'off' };
      }
      const [s, w] = this.input.rumbleNow;
      const engine = vib ? 0.04 + frac * 0.06 + (p.wallScrape > 0 ? 0.4 : 0) : 0;
      hid.rumbleL = vib ? Math.max(s, p.boosting ? 0.25 : 0) : 0;
      hid.rumbleR = vib ? Math.max(w, engine) : 0;
    } else {
      hid.trigR = { mode: 'off' };
      hid.trigL = { mode: 'off' };
      const [s, w] = this.input.rumbleNow;
      hid.rumbleL = vib ? s : 0;
      hid.rumbleR = vib ? w : 0;
      hid.playerLeds = PLAYER_LED_PATTERNS[1];
      if (this.state !== 'select') {
        const t = this.time * 0.5;
        hid.light = [Math.round(60 + 60 * Math.sin(t)), 40, Math.round(200 + 55 * Math.sin(t + 2))];
      }
    }
    hid.flush();
  }

  private handleMenu(a: MenuAction) {
    const au = this.audio;
    switch (this.state) {
      case 'title':
        if (a === 'confirm' || (a === 'pause' && this.titleTime > 0.5)) {
          this.audio.init();
          this.audio.setVolumes(0.8, this.settings.music, this.settings.sfx);
          au.menuConfirm();
          this.toMenu();
        }
        break;
      case 'menu':
        if (a === 'back') {
          au.menuBack();
          if (this.menuMode === 'settings') {
            this.menu.items[this.menu.items.length - 1].action!();
          } else if (!this.ui.controls.classList.contains('hidden')) this.ui.controls.classList.add('hidden');
          else this.toTitle();
        } else if (this.menu.handle(a) && a === 'confirm') au.menuConfirm();
        break;
      case 'select':
        if (a === 'back') {
          au.menuBack();
          this.toMenu();
        } else if (a === 'left' || a === 'right') {
          // left/right on non-adjustable rows still browses machines
          const it = this.selectMenu.items[this.selectMenu.sel];
          if (it.left) this.selectMenu.handle(a);
          else this.pickMachine(a === 'left' ? -1 : 1);
          this.selectMenu.render();
          au.menuMove();
        } else if (a === 'confirm') {
          au.menuConfirm();
          this.startRace();
        } else this.selectMenu.handle(a);
        break;
      case 'race':
        if (a === 'pause') {
          au.menuBack();
          this.pause();
        } else if (a === 'camera') {
          this.chase.mode = (this.chase.mode + 1) % CAMERA_MODES.length;
          this.ui.message('', CAMERA_MODES[this.chase.mode] + ' CAM', 700);
        } else if (a === 'rear') {
          this.chase.rear = !this.chase.rear;
          setTimeout(() => (this.chase.rear = false), 1200);
        }
        break;
      case 'paused':
        if (a === 'pause' || a === 'back') this.resume();
        else if (this.pauseMenu.handle(a) && a === 'confirm') au.menuConfirm();
        break;
      case 'results':
        if (this.resultsMenu.handle(a) && a === 'confirm') au.menuConfirm();
        break;
    }
  }
}

function hexToRgb(hex: number) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}
