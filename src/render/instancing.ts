import * as THREE from 'three';

/**
 * Draw one model in many places with one draw call per part.
 *
 * The house repeats its models — 28 torches, 25 mirrors, 18 wardrobes — and
 * as separate clones each part of each copy was its own draw call: well over
 * a thousand a frame, each one shaded against every torch in the house. An
 * instanced mesh draws every copy of a part at once.
 *
 * Only for things that never move. Anything that swings or rocks keeps its
 * own clone.
 */
export function instanceAt(
  source: THREE.Object3D,
  placements: THREE.Matrix4[],
  track: <T extends { dispose(): void }>(o: T) => T,
): THREE.Group {
  const group = new THREE.Group();
  if (placements.length === 0) return group;
  source.updateMatrixWorld(true);
  const toRoot = source.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  source.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Where this part sits within the model.
    const part = toRoot.clone().multiply(mesh.matrixWorld);
    const im = track(new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length));
    placements.forEach((p, i) => im.setMatrixAt(i, m.multiplyMatrices(p, part)));
    im.castShadow = mesh.castShadow;
    im.receiveShadow = mesh.receiveShadow;
    // Bounds over every copy, so the whole set is culled together, correctly.
    im.computeBoundingSphere();
    group.add(im);
  });
  return group;
}

/** A placement: position, a turn about the vertical, and a scale. */
export function placement(
  x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
    new THREE.Vector3(sx, sy, sz),
  );
}
