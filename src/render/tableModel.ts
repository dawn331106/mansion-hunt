import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Solid } from '../game/map.js';
import { assetUrl } from './assets.js';
import { instanceAt, placement } from './instancing.js';
import type { Stage } from './staging.js';

/**
 * The tables: an oak top and apron on four plain legs, open underneath.
 *
 * Every table in the house is the same model, `hollow_table.glb`, stretched to
 * the box the map gives it — collision only ever sees that box, so the model
 * has to fill it exactly or a player crawls under something that is not there.
 *
 * The model also carries a draped cloth. It is left out: hung to the floor it
 * turned every table into a solid block, and the point of a table is that you
 * can see under it — the hider can watch the room, and anyone in the room can
 * see there is someone down there if they look.
 */

export const TABLE_MODEL_URL = assetUrl('assets/hollow_table.glb');

/** The model's size, from the GLB: the tabletop's footprint and height. */
const MODEL_HALF_X = 1.0;
const MODEL_HALF_Z = 0.5;
const MODEL_TOP = 0.78;

/**
 * Set every table in the house, as one instanced model, once it has loaded.
 *
 * Each table's plain box stands in until then, so a slow load shows plain
 * tables rather than holes in the furniture.
 */
export function loadTables(
  scene: THREE.Scene,
  tables: { solid: Solid; standIn: THREE.Object3D }[],
  stage: Stage,
  track: <T extends { dispose(): void }>(o: T) => T,
): void {
  if (tables.length === 0) return;
  stage.wait(new GLTFLoader().loadAsync(TABLE_MODEL_URL).then((gltf) => {
    const source = gltf.scene;
    source.getObjectByName('Cloth')?.removeFromParent();
    source.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      /*
       * Warm the oak. As exported it is near black, which in a house this
       * dark left a table as a silhouette with no grain or edge to it.
       */
      if (mat.name === 'M_AgedOak') mat.color.set(0x5a3d2a);
      track(mesh.geometry);
      track(mat);
    });

    const set = instanceAt(source, tables.map(({ solid: s }) =>
      placement(s.x, 0, s.z, 0, s.hx / MODEL_HALF_X, s.y1 / MODEL_TOP, s.hz / MODEL_HALF_Z)), track);
    stage.hold(set);
    scene.add(set);
    for (const t of tables) stage.standIn(t.standIn);
  }).catch((err) => console.warn('table model failed to load; keeping box tables', err)));
}
