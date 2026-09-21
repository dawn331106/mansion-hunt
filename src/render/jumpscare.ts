import * as THREE from 'three';
import { MATCH } from '../game/config.js';

/**
 * The catch.
 *
 * A jumpscare works or it does not, and what separates the two is almost
 * entirely timing. This one runs on a fixed 1.5-second curve with four
 * overlapping stages, none of which the player can interrupt:
 *
 *   0.00-0.08  SEIZE     The camera is torn off its moorings and snapped to
 *                        face the ghost. Control is gone before you register
 *                        that anything happened.
 *   0.08-0.45  LUNGE     The ghost surges into the lens in 3D — the body
 *                        model's own lunge animation, not an image — while
 *                        the camera shakes hard and the FOV punches in.
 *   0.45-1.10  HOLD      It fills the frame. Chromatic aberration, scanline
 *                        tearing and a violent vignette. This is the part
 *                        that is genuinely unpleasant, and it is held just
 *                        long enough to be too long.
 *   1.10-1.50  COLLAPSE  Hard cut to black, sound gone, then the spectator
 *                        view fades up.
 *
 * The overlay is a full-screen shader rather than DOM, so it can distort what
 * is actually on screen instead of merely covering it.
 */

export interface Jumpscare {
  /** Add this to the scene; it renders after everything else. */
  mesh: THREE.Mesh;
  /** Start the scare. `ghostPos` is where the killer is, in world space. */
  trigger(ghostPos: THREE.Vector3): void;
  /** True while the scare owns the screen and input. */
  get active(): boolean;
  /** 0..1 through the sequence. */
  get progress(): number;
  /**
   * Advance. Returns the camera treatment for this frame, which the renderer
   * applies: where to look, how much to shake, and the FOV punch.
   */
  update(dt: number, camera: THREE.PerspectiveCamera, baseFov: number): {
    shake: THREE.Vector3;
    lookAt: THREE.Vector3 | null;
    /** 0..1, fed to the ghost model's own lunge animation. */
    lunge: number;
  };
  dispose(): void;
}

export function createJumpscare(): Jumpscare {
  const uniforms = {
    uTime: { value: 0 },
    /** 0 = inactive, otherwise 0..1 through the sequence. */
    uProgress: { value: 0 },
    uActive: { value: 0 },
    uAberration: { value: 0 },
    uVignette: { value: 0 },
    uBlack: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uProgress;
      uniform float uActive;
      uniform float uAberration;
      uniform float uVignette;
      uniform float uBlack;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        if (uActive < 0.5) { discard; }

        vec2 uv = vUv;
        vec2 c = uv - 0.5;
        float r = length(c);

        // --- Vignette: a hard, red-black closing iris. ---
        float vig = smoothstep(0.24, 0.78, r) * uVignette;

        // --- Torn scanlines: rows displaced at random, so the image looks
        //     like it is failing rather than merely darkening. ---
        float row = floor(uv.y * 140.0);
        float tear = step(0.88, hash(vec2(row, floor(uTime * 24.0)))) * uAberration;

        // --- Grain, heaviest at the peak. ---
        float grain = (hash(uv * 900.0 + uTime * 60.0) - 0.5) * 0.30 * uAberration;

        // The overlay itself is a bloody wash whose weight follows the curve.
        vec3 wash = vec3(0.52, 0.03, 0.04);
        float washAmt = uVignette * 0.55 + tear * 0.35;

        vec3 col = wash * washAmt + vec3(grain);
        float alpha = clamp(vig * 0.94 + tear * 0.5 + abs(grain) * 0.8, 0.0, 1.0);

        // --- The collapse to black swallows everything. ---
        col = mix(col, vec3(0.0), uBlack);
        alpha = max(alpha, uBlack);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  // A full-screen triangle in clip space; no camera involved.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, -1, 0, 3, -1, 0, -1, 3, 0], 3,
  ));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  // Drawn last, over everything.
  mesh.renderOrder = 9999;
  mesh.visible = false;

  let elapsed = -1;
  const target = new THREE.Vector3();
  const shake = new THREE.Vector3();

  const DUR = MATCH.jumpscareDuration;

  return {
    mesh,

    trigger(ghostPos) {
      elapsed = 0;
      target.copy(ghostPos);
      mesh.visible = true;
      uniforms.uActive.value = 1;
    },

    get active() { return elapsed >= 0 && elapsed < DUR; },
    get progress() { return elapsed < 0 ? 0 : Math.min(1, elapsed / DUR); },

    update(dt, camera, baseFov) {
      if (elapsed < 0) {
        return { shake: shake.set(0, 0, 0), lookAt: null, lunge: 0 };
      }

      elapsed += dt;
      const t = Math.min(1, elapsed / DUR);
      uniforms.uTime.value = elapsed;
      uniforms.uProgress.value = t;

      // --- Stage curves. Each is a window on the same normalised clock. ---
      const seize = smoothstep(0.0, 0.055, t);
      const lunge = smoothstep(0.05, 0.30, t);
      const hold = smoothstep(0.28, 0.40, t) * (1 - smoothstep(0.70, 0.76, t));
      const collapse = smoothstep(0.73, 0.88, t);

      // --- Shake. Violent at the lunge, tapering through the hold. Driven by
      //     two out-of-phase sines rather than random, so it reads as an
      //     impact rather than as noise. ---
      const shakeAmt = (lunge * (1 - collapse)) * 0.16 + hold * 0.05;
      shake.set(
        Math.sin(elapsed * 71) * shakeAmt,
        Math.sin(elapsed * 53 + 1.3) * shakeAmt,
        Math.sin(elapsed * 37 + 2.1) * shakeAmt * 0.5,
      );

      // --- FOV punch: in hard on the lunge, so the ghost appears to close
      //     faster than it physically moves. ---
      camera.fov = baseFov - lunge * 22 * (1 - collapse) + hold * 4;
      camera.updateProjectionMatrix();

      uniforms.uAberration.value = lunge * (1 - collapse);
      uniforms.uVignette.value = Math.max(lunge * 0.85, hold);
      uniforms.uBlack.value = collapse;

      if (t >= 1) {
        elapsed = -1;
        mesh.visible = false;
        uniforms.uActive.value = 0;
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
      }

      return {
        shake,
        // The camera is dragged onto the ghost and held there.
        lookAt: seize > 0 ? target : null,
        lunge,
      };
    },

    dispose() { geo.dispose(); mat.dispose(); },
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
