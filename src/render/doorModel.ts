import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl } from './assets.js';
import { DOORWAY_H } from './shell.js';
import type { Stage } from './staging.js';

/**
 * The room doors: heavy plank leaves with iron strapping and a barred grate,
 * from `ward_door.glb`.
 *
 * The model is a whole wall section — plaster, frame and one 0.9m leaf — but
 * the house builds its own walls around each opening, and its doorways are
 * 1.8m wide so a chase can go through one at a run. So only the leaf is used,
 * twice: a pair of doors per opening, the second mirrored, which fills the gap
 * at the model's own proportions instead of stretching one plank door to
 * double width.
 *
 * Sixty leaves of six parts each were 360 draw calls a frame, so the leaves
 * are instanced: one draw per part, every leaf at once. They still swing —
 * the renderer turns each hinge pivot as before, and every frame the
 * instances are moved to wherever their pivots now are.
 */

export const DOOR_MODEL_URL = assetUrl('assets/ward_door.glb');

/** Width of the model's leaf, hinge to latch edge. */
const MODEL_LEAF_WIDTH = 0.9;
/** And its height. */
const MODEL_LEAF_HEIGHT = 2.1;

/**
 * One doorway: a group at the opening's centre whose children are the two
 * hinge pivots. Each pivot carries `userData.side` — +1 for the leaf hinged
 * at the -x jamb, -1 for its mirror at +x — and the renderer turns it.
 */
export interface DoorwaySlot {
  /** Half-width of the opening; each leaf spans one half. */
  half: number;
  pivots: THREE.Object3D[];
}

export interface DoorView {
  /** Move the leaves to follow their pivots. */
  update(): void;
}

export function loadDoors(
  scene: THREE.Scene,
  slots: DoorwaySlot[],
  stage: Stage,
  track: <T extends { dispose(): void }>(o: T) => T,
): DoorView {
  let update = () => {};
  if (slots.length === 0) return { update: () => update() };

  stage.wait(new GLTFLoader().loadAsync(DOOR_MODEL_URL).then((gltf) => {
    const leaf = gltf.scene.getObjectByName('Door_Leaf') as THREE.Mesh | undefined;
    if (!leaf) throw new Error('door model has no Door_Leaf');
    // The node sits at the hinge in its own wall; here the pivot is the hinge.
    leaf.position.set(0, 0, 0);
    leaf.updateMatrixWorld(true);

    /*
     * Two sets: leaves hung as modelled, and their mirror images.
     *
     * A mirrored instance in an ordinary set would be drawn inside out — the
     * renderer decides which faces are fronts per mesh, not per instance. So
     * the mirrored set is itself flipped in x, and its instances are flipped
     * back inside it: each is drawn the right way out and lands mirrored.
     */
    const flip = new THREE.Matrix4().makeScale(-1, 1, 1);
    const sets = [1, -1].map((side) => {
      const pivots = slots.flatMap((s) => s.pivots.filter((p) => p.userData.side === side)
        .map((pivot) => ({ pivot, half: s.half })));
      const meshes: { mesh: THREE.InstancedMesh; part: THREE.Matrix4 }[] = [];
      const group = new THREE.Group();
      if (side < 0) group.scale.x = -1;
      leaf.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        track(m.geometry);
        for (const mat of [m.material].flat()) track(mat);
        const im = track(new THREE.InstancedMesh(m.geometry, m.material, pivots.length));
        im.castShadow = true;
        im.receiveShadow = true;
        // Leaves swing, so the set's bounds are never final; draw it always.
        im.frustumCulled = false;
        group.add(im);
        meshes.push({ mesh: im, part: m.matrixWorld.clone() });
      });
      return { side, pivots, meshes, group };
    });

    const m = new THREE.Matrix4();
    const size = new THREE.Matrix4();
    update = () => {
      for (const { side, pivots, meshes } of sets) {
        pivots.forEach(({ pivot, half }, i) => {
          pivot.updateWorldMatrix(true, false);
          // Sized to the opening: each leaf spans one half of it, full height.
          size.makeScale((half / MODEL_LEAF_WIDTH) * side, (DOORWAY_H - 0.05) / MODEL_LEAF_HEIGHT, 1);
          for (const { mesh, part } of meshes) {
            m.multiplyMatrices(pivot.matrixWorld, size).multiply(part);
            if (side < 0) m.premultiply(flip);
            mesh.setMatrixAt(i, m);
          }
        });
        for (const { mesh } of meshes) mesh.instanceMatrix.needsUpdate = true;
      }
    };
    update();

    for (const { group } of sets) {
      stage.hold(group);
      scene.add(group);
    }
    // The plain leaves hung on the pivots stand in until now.
    for (const s of slots) for (const p of s.pivots) for (const c of p.children) stage.standIn(c);
  }).catch((err) => console.warn('door model failed to load; keeping box doors', err)));

  return { update: () => update() };
}
