import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl } from './assets.js';
import { instanceAt } from './instancing.js';
import type { Stage } from './staging.js';

/**
 * The almirahs: a walnut mourning wardrobe with a pair of louvered doors and
 * three old coats still hanging inside.
 *
 * Every almirah in the house is a copy of `mourning_wardrobe.glb`. The model's
 * front is +z, its doors are hinged at their outer edges, and the louvers in
 * the top half of each door are what the person hiding inside looks through —
 * so the wardrobe is set back from the hiding spot until the occupant's eye
 * sits just behind them.
 */

export const WARDROBE_MODEL_URL = assetUrl('assets/mourning_wardrobe.glb');

/** How far in front of the model's origin the eye sits, behind the louvers. */
export const WARDROBE_PEEK_Z = 0.24;

/**
 * One almirah waiting for its model.
 *
 * `holder` is placed and turned where the wardrobe stands. `doors` is the
 * object the renderer swings: each child is a leaf, turned about its own
 * hinge to `userData.openAngle` when nobody is inside and back to zero when
 * someone is. `standIns` are the plain cupboard and leaf shown until the
 * model is ready.
 */
export interface WardrobeSlot {
  holder: THREE.Object3D;
  doors: THREE.Object3D;
  standIns: THREE.Object3D[];
}

/**
 * Put the model in every almirah once it has loaded.
 *
 * The carcass never moves, so every wardrobe's carcass is one instanced
 * model. The doors swing, so each wardrobe gets its own pair, hung in
 * `doors` beside the stand-in leaf.
 */
export function loadWardrobes(
  scene: THREE.Scene,
  slots: WardrobeSlot[],
  stage: Stage,
  track: <T extends { dispose(): void }>(o: T) => T,
): void {
  if (slots.length === 0) return;
  stage.wait(new GLTFLoader().loadAsync(WARDROBE_MODEL_URL).then((gltf) => {
    const source = gltf.scene;
    source.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      track(mesh.geometry);
      track(mesh.material as THREE.Material);
    });

    /*
     * Lift the leaves out of the model. Its `Doors` group sits at its origin
     * untransformed, and so does each slot's `doors`, so a leaf keeps its
     * hinge exactly where it was. The open angle is the model's own, from the
     * `open_deg` it carries.
     */
    const leaves = ['Door_L', 'Door_R'].flatMap((name) => {
      const leaf = source.getObjectByName(name);
      if (!leaf) return [];
      const openDeg = (leaf.userData.open_deg as number | undefined) ?? 0;
      leaf.userData.openAngle = THREE.MathUtils.degToRad(openDeg);
      return [leaf];
    });
    source.getObjectByName('Doors')?.removeFromParent();

    const carcasses = instanceAt(source, slots.map(({ holder }) => {
      holder.updateMatrix();
      return holder.matrix.clone();
    }), track);
    stage.hold(carcasses);
    scene.add(carcasses);

    for (const { doors, standIns } of slots) {
      for (const leaf of leaves) {
        const l = leaf.clone();
        stage.hold(l);
        doors.add(l);
      }
      for (const o of standIns) stage.standIn(o);
    }
  }).catch((err) => console.warn('wardrobe model failed to load; keeping box almirahs', err)));
}
