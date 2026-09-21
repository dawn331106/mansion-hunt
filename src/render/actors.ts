import * as THREE from 'three';
import type { Survivor } from '../game/types.js';

/**
 * Survivor bodies.
 *
 * Simple, readable figures rather than detailed characters: at the distances
 * and light levels this game runs at, what matters is that a human shape is
 * instantly distinguishable from a crate, and that crouching visibly changes
 * the silhouette so the ghost can read stance across a room.
 */

const BODY_COLOURS = [0x8a6a4a, 0x6a7a8a, 0x7a6a8a, 0x6a8a7a, 0x8a7a5a];

export interface SurvivorModel {
  object: THREE.Object3D;
  update(s: Survivor, time: number): void;
  dispose(): void;
}

export function createSurvivor(index: number): SurvivorModel {
  const group = new THREE.Object3D();
  const disposables: { dispose(): void }[] = [];
  const colour = BODY_COLOURS[index % BODY_COLOURS.length];

  const mat = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85 });
  disposables.push(mat);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xc8a88a, roughness: 0.8 });
  disposables.push(headMat);

  const torsoGeo = new THREE.CapsuleGeometry(0.22, 0.62, 4, 10);
  disposables.push(torsoGeo);
  const torso = new THREE.Mesh(torsoGeo, mat);
  torso.castShadow = true;
  group.add(torso);

  const headGeo = new THREE.SphereGeometry(0.15, 12, 12);
  disposables.push(headGeo);
  const head = new THREE.Mesh(headGeo, headMat);
  head.castShadow = true;
  group.add(head);

  // Legs, purely so the walk cycle has something to move.
  const legGeo = new THREE.CapsuleGeometry(0.075, 0.4, 3, 8);
  disposables.push(legGeo);
  const legs: THREE.Mesh[] = [];
  for (const dx of [-0.11, 0.11]) {
    const l = new THREE.Mesh(legGeo, mat);
    l.position.x = dx;
    l.castShadow = true;
    group.add(l);
    legs.push(l);
  }

  // A soft marker above the head, only visible to teammates at close range —
  // toggled by the caller, since the ghost must never see it.
  const marker = new THREE.Mesh(
    (() => { const g = new THREE.ConeGeometry(0.09, 0.18, 8); disposables.push(g); return g; })(),
    (() => {
      const m = new THREE.MeshBasicMaterial({ color: 0x66dd99, transparent: true, opacity: 0.55 });
      disposables.push(m);
      return m;
    })(),
  );
  marker.rotation.x = Math.PI;
  marker.visible = false;
  group.add(marker);
  (group as THREE.Object3D & { marker: THREE.Mesh }).marker = marker;

  let phase = 0;
  // Per-model, not module-level: every survivor needs its own walk cycle.
  let lastX = 0;
  let lastZ = 0;

  return {
    object: group,
    update(s, _time) {
      group.position.set(s.pos.x, 0, s.pos.z);
      // Three.js yaw is measured the other way round from the sim's atan2.
      group.rotation.y = -s.yaw + Math.PI / 2;

      const crouch = s.stance === 'crouch';
      const scale = crouch ? 0.6 : 1.0;
      torso.position.y = (0.95 - 0.02) * scale;
      torso.scale.setScalar(1);
      torso.scale.y = crouch ? 0.7 : 1;
      head.position.y = (crouch ? 0.92 : 1.52);
      marker.position.y = (crouch ? 1.18 : 1.78);

      // Walk cycle, advanced by how fast they are actually going. Stationary
      // survivors stand still, which is how you tell across a room whether
      // someone has spotted you.
      const speed = Math.hypot(group.position.x - lastX, group.position.z - lastZ);
      lastX = group.position.x;
      lastZ = group.position.z;
      phase += speed * 7;
      const swing = Math.sin(phase) * (crouch ? 0.12 : 0.28);
      legs[0].position.set(-0.11, (crouch ? 0.32 : 0.42), swing * 0.3);
      legs[0].rotation.x = swing;
      legs[1].position.set(0.11, (crouch ? 0.32 : 0.42), -swing * 0.3);
      legs[1].rotation.x = -swing;

      group.visible = s.alive && !s.escaped && !s.hidden;
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}

/**
 * The reveal-pulse marker the ghost sees: a column of light at a remembered
 * position.
 *
 * It is deliberately a *place*, not a person — no figure, no name — because
 * the pulse reports where someone was three seconds ago, and drawing a body
 * there would make the ghost chase a phantom and feel cheated.
 */
export function createPulseMark(): { object: THREE.Object3D; update(t: number, age: number): void; dispose(): void } {
  const disposables: { dispose(): void }[] = [];
  const geo = new THREE.CylinderGeometry(0.35, 0.5, 6, 12, 1, true);
  disposables.push(geo);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uFade: { value: 1 } },
    vertexShader: `
      varying float vY;
      void main() {
        vY = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uFade;
      varying float vY;
      void main() {
        // Bright at the base, dissolving upward, with a rising scan line.
        float base = pow(1.0 - vY, 2.0);
        float scan = smoothstep(0.0, 0.08, abs(fract(vY - uTime * 0.35) - 0.5) * -1.0 + 0.5);
        float a = (base * 0.5 + scan * 0.25) * uFade;
        gl_FragColor = vec4(vec3(0.95, 0.35, 0.35), a);
      }
    `,
  });
  disposables.push(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 3;

  const group = new THREE.Object3D();
  group.add(mesh);

  return {
    object: group,
    update(t, age) {
      mat.uniforms.uTime.value = t;
      // Fade out over the life of the reveal, so the ghost feels the clock.
      mat.uniforms.uFade.value = Math.max(0, 1 - age);
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
