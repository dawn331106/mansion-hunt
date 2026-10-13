import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Prop, PropModel } from '../game/map.js';
import { assetUrl } from './assets.js';
import { instanceAt, placement } from './instancing.js';
import type { Stage } from './staging.js';

/**
 * The accessories: gurneys, rocking chairs, longcase clocks, draped mirrors
 * and candelabras, from `public/assets/horror_accessories/`.
 *
 * Each model loads once and is drawn instanced, every copy of it at once.
 * Until all of them are in, the collision boxes underneath stay drawn as
 * plain furniture, so a slow or failed load leaves blocks rather than
 * invisible obstacles.
 *
 * Two of them move. Rocking chairs rock, slowly and out of step with each
 * other, with nobody in them. Candle flames flicker.
 */

const FILES: Record<PropModel, string> = {
  gurney: 'ward_gurney.glb',
  rocking_chair: 'rocking_chair.glb',
  clock: 'longcase_clock.glb',
  mirror: 'covered_mirror.glb',
  candelabra: 'floor_candelabra.glb',
};

export interface PropView {
  /** Advance the rocking and the flicker. */
  update(time: number): void;
}

export function loadProps(
  scene: THREE.Scene,
  props: Prop[],
  /** The plain boxes standing in for the props, until every model is in. */
  placeholders: THREE.Object3D[],
  stage: Stage,
  track: <T extends { dispose(): void }>(o: T) => T,
): PropView {
  const chairs: { pivot: THREE.Object3D; phase: number; speed: number }[] = [];
  const flames: THREE.MeshStandardMaterial[] = [];

  const needed = [...new Set(props.map((p) => p.model))];
  const loader = new GLTFLoader();

  const loads = needed.map((model) => loader.loadAsync(
    assetUrl(`assets/horror_accessories/${FILES[model]}`),
  ).then((gltf) => {
    const source = gltf.scene;
    source.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      track(mesh.geometry);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      track(mat);
      if (mat.name === 'M_Flame') {
        mat.emissiveIntensity = 2.5;
        flames.push(mat);
      }
    });

    const here = props.map((p, i) => ({ p, i })).filter(({ p }) => p.model === model);
    if (model === 'rocking_chair') {
      // Chairs rock, so each keeps its own copy.
      for (const { p, i } of here) {
        const placed = new THREE.Group();
        placed.position.set(p.x, 0, p.z);
        placed.rotation.y = p.rot;
        // Rock about the rockers' contact with the floor, under the seat.
        const pivot = new THREE.Group();
        pivot.add(source.clone());
        placed.add(pivot);
        chairs.push({ pivot, phase: i * 1.7, speed: 1.3 + (i % 3) * 0.15 });
        stage.hold(placed);
        scene.add(placed);
      }
    } else {
      const set = instanceAt(source, here.map(({ p }) => placement(p.x, 0, p.z, p.rot)), track);
      stage.hold(set);
      scene.add(set);
    }
  }));

  stage.wait(Promise.all(loads).then(() => {
    for (const box of placeholders) stage.standIn(box);
  }).catch((err) => console.warn('an accessory failed to load; keeping box furniture', err)));

  return {
    update(time) {
      for (const c of chairs) {
        c.pivot.rotation.x = Math.sin(time * c.speed + c.phase) * 0.09;
      }
      // One shared flicker: the flames are few, and in step they read as a draught.
      const f = 2.2 + Math.sin(time * 11) * 0.25 + Math.sin(time * 23.7) * 0.2;
      for (const m of flames) m.emissiveIntensity = f;
    },
  };
}
