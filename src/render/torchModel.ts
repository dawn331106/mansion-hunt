import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Torch } from '../game/map.js';
import { assetUrl } from './assets.js';
import { instanceAt, placement } from './instancing.js';
import type { Stage } from './staging.js';

/**
 * The torches: a moshal — a bamboo torch wrapped in oiled rag — seated in an
 * iron wall bracket, from `moshal/moshal_wall_lit.glb`. Every light inside the
 * house comes from one of these.
 *
 * The lights are made straight away, at the flame's position, and do not wait
 * for the model: a slow load should show bare walls lit by fire, not a house
 * with no light at all. The torches themselves never move, so they are drawn
 * instanced, all of them at once.
 */

export const TORCH_MODEL_URL = assetUrl('assets/moshal/moshal_wall_lit.glb');

/**
 * Where the flame sits relative to the bracket's base on the wall.
 *
 * Taken from the model: its `LightPoint` is 0.72m up a torch seated at
 * (0, 1.5, 0.14) and tipped 20 degrees out from the wall.
 */
const FLAME_Y = 1.5 + 0.72 * Math.cos(THREE.MathUtils.degToRad(20));
const FLAME_OUT = 0.14 + 0.72 * Math.sin(THREE.MathUtils.degToRad(20));

/** Firelight: a deep orange, around 1900K. */
const FIRE = new THREE.Color(0xff8a3c);

/**
 * How hard a torch burns, and how far it reaches.
 *
 * A pool of light around the bracket that dies out within a few metres,
 * rather than a room lit wall to wall: this was much brighter, and with
 * twice as many torches the house had stopped having any dark in it.
 */
const TORCH_INTENSITY = 11;
const TORCH_RANGE = 14;
const TORCH_DECAY = 1.45;

/**
 * Corridors and passages burn harder and reach further.
 *
 * A room is small enough for one torch to reach its corners; a corridor is
 * forty metres of wall with a torch every dozen, and at room strength the
 * stretches between them went black — not frightening, just unreadable.
 */
const PASSAGE_INTENSITY = 16;
const PASSAGE_RANGE = 18;
const isPassage = (room: string) =>
  room.startsWith('corridor') || room.startsWith('outer') || room.startsWith('spur');

export interface TorchView {
  /** Flicker the light. */
  update(time: number): void;
}

/**
 * Light every torch and hang its model.
 *
 * `tint` is the room's own lamp colour. Each torch's light is firelight
 * pulled part way toward it, because the per-room colour is how players tell
 * rooms apart in the dark, and pure firelight would make every room the same.
 */
export function buildTorches(
  scene: THREE.Scene,
  torches: Torch[],
  tint: (room: string) => { light: number },
  stage: Stage,
  track: <T extends { dispose(): void }>(o: T) => T,
): TorchView {
  const lights: { light: THREE.PointLight; base: number; phase: number }[] = [];

  torches.forEach((t, i) => {
    const color = FIRE.clone().lerp(new THREE.Color(tint(t.room).light), 0.45);
    const passage = isPassage(t.room);
    const base = passage ? PASSAGE_INTENSITY : TORCH_INTENSITY;
    const light = new THREE.PointLight(color, base, passage ? PASSAGE_RANGE : TORCH_RANGE, TORCH_DECAY);
    // Out from the wall along the bracket's facing, at the flame.
    light.position.set(
      t.x + Math.sin(t.rot) * FLAME_OUT, FLAME_Y, t.z + Math.cos(t.rot) * FLAME_OUT,
    );
    scene.add(light);
    lights.push({ light, base, phase: i * 2.37 });
  });

  stage.wait(new GLTFLoader().loadAsync(TORCH_MODEL_URL).then((gltf) => {
    const source = gltf.scene;
    source.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Small, high on a wall, and lit from inside: not worth a shadow.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      track(mesh.geometry);
      for (const m of [mesh.material].flat()) track(m);
    });
    const set = instanceAt(source, torches.map((t) => placement(t.x, 0, t.z, t.rot)), track);
    stage.hold(set);
    scene.add(set);
  }).catch((err) => console.warn('torch model failed to load; the light stays, the torch does not', err)));

  return {
    update(time) {
      // About +/-15%, from two unrelated wobbles so it never settles into a beat.
      for (const l of lights) {
        const f = 1 + 0.09 * Math.sin(time * 9.3 + l.phase) + 0.06 * Math.sin(time * 23.1 + l.phase * 1.7);
        l.light.intensity = l.base * f;
      }
    },
  };
}
