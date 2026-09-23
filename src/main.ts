import * as THREE from 'three';
import '@fontsource/orbitron/500.css';
import '@fontsource/orbitron/800.css';
import '@fontsource/rajdhani/600.css';
import './style.css';
import { GameRenderer } from './core/Renderer';
import { World } from './world/World';
import { Game } from './game/Game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const camera = new THREE.PerspectiveCamera(70, 1, 0.3, 30000);
const gr = new GameRenderer(canvas, new THREE.Scene(), camera);
const world = new World(gr.renderer);
(gr.renderPass as unknown as { mainScene: THREE.Scene }).mainScene = world.scene;
const game = new Game(gr, world, camera);
(window as unknown as { game: Game }).game = game;

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(1 / 20, (now - last) / 1000);
  last = now;
  game.frame(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
