import * as THREE from 'three';

/**
 * The ghost: a real body, animated, with the artwork mapped onto it.
 *
 * The important decision here is that the supplied image is *not* a billboard.
 * A camera-facing sprite is cheap but it gives the ghost no presence — it has
 * no back, it cannot turn away from you, and it cannot lunge. So the image is
 * used as a texture on built geometry: the face plate takes the artwork, and
 * the head, torso, arms and trailing shroud are actual meshes that move.
 *
 * That buys the three things the design needs. It can be seen from behind and
 * still read as the ghost. It can animate — the shroud billows, the arms
 * drift, the whole form breathes. And at the catch it can lunge *at* the
 * camera in three dimensions, which is the difference between a scare and a
 * picture of one.
 *
 * Drop the artwork at `public/assets/ghost.png` and set GHOST_TEXTURE_URL.
 * Until then the face plate uses a procedural spectral shader and every other
 * part of the body is identical, so the animation and the jumpscare can be
 * tuned now and the art swapped in later without touching anything else.
 */

/**
 * Path to the ghost artwork, served from `public/`.
 *
 * A transparent PNG of the face or upper body works best. The shader tints and
 * dissolves it, so a flat, evenly-lit source image is fine — no need to
 * pre-darken it.
 */
export const GHOST_TEXTURE_URL: string | null = '/assets/ghost.png';

/**
 * Path to the ghost's body artwork, served from `public/`.
 *
 * Generated from `body.png` by `tools/import-ghost.py`. Set to null to fall
 * back to the procedural form.
 */
export const GHOST_BODY_URL: string | null = '/assets/ghost-body.png';


export interface GhostModel {
  object: THREE.Object3D;
  /** Advance the drift, billow and breathing. */
  update(dt: number, time: number, camera: THREE.Camera): void;
  /** 0 = barely there, 1 = fully manifest. Drives opacity and glow. */
  setPresence(v: number): void;
  /**
   * Drive the lunge, 0..1, for the catch.
   *
   * The jumpscare calls this: the body surges forward and the arms sweep up,
   * in world space, so the scare happens in the scene rather than as a flat
   * image pasted over it.
   */
  setLunge(v: number): void;
  /** Current world-space Y of the face, so the scare can aim at it. */
  headWorldY(): number;
  dispose(): void;
}

/** Shared spectral uniforms, so every part of the body flickers in sync. */
interface Spectral {
  uTime: { value: number };
  uPresence: { value: number };
  /** 0..1 during a jumpscare; brightens the face so it is actually visible. */
  uLunge: { value: number };
  uColor: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  uMap: { value: THREE.Texture | null };
  uHasMap: { value: number };
}

/**
 * The body shader.
 *
 * One material serves every part, with `uHasMap` selecting whether it samples
 * the artwork. Fresnel brightens the silhouette edge and hollows the middle,
 * which is what makes the form read as a shell rather than a solid — and the
 * vertical dissolve means the ghost never quite meets the floor.
 */
function spectralMaterial(u: Spectral, opts: { dissolveFrom: number; useMap: boolean }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u as unknown as Record<string, THREE.IUniform>,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    defines: { USE_MAP_TEX: opts.useMap ? 1 : 0 },
    vertexShader: `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vLocalY;

      void main() {
        vUv = uv;
        vLocalY = position.y;

        // A slow, organic sway. Amplitude grows toward the hem, so the top of
        // the body stays readable while the bottom moves like cloth.
        vec3 p = position;
        float amp = max(0.0, -position.y) * 0.10 + 0.012;
        p.x += sin(uTime * 1.25 + position.y * 2.6) * amp;
        p.z += cos(uTime * 0.95 + position.y * 2.1) * amp;

        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uPresence;
      uniform float uLunge;
      uniform vec3 uColor;
      uniform vec3 uDeep;
      uniform sampler2D uMap;
      uniform float uHasMap;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vLocalY;

      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);

        /*
         * Dark body, bright edge.
         *
         * The body first rendered as a pale milky solid, which fought the
         * face for attention and made the whole figure read as a lamp rather
         * than a shroud. Keeping the interior nearly black and putting all
         * the light in the fresnel rim means the eye goes to the face, and
         * the silhouette still separates from a dark wall.
         */
        vec3 col = mix(uDeep, uColor, fres * fres);
        float alpha = 0.06 + fres * 0.62;

        #if USE_MAP_TEX
          if (uHasMap > 0.5) {
            vec4 tex = texture2D(uMap, vUv);
            /*
             * The artwork is the face: show it, do not tint it.
             *
             * This first multiplied the texture by the spectral colour and
             * faded it by fresnel, which in a house lit this dimly left the
             * face a barely-visible smudge — all the work of drawing it was
             * thrown away by the shader. The artwork now passes through at
             * full strength and is lifted a little at the silhouette, so it
             * reads across a room while still belonging to the body.
             */
            // uLunge lifts the face during a jumpscare. The house is lit at
            // the edge of visibility by design, which is right for hunting
            // and wrong for the one shot where the art has to be legible.
            col = tex.rgb * (1.25 + fres * 0.55 + uLunge * 2.6);
            alpha = tex.a * (0.94 + fres * 0.06);
            // Skip the dissolve and ripple below: the face is not cloth.
            gl_FragColor = vec4(col, alpha * uPresence);
            return;
          }
        #endif

        // Dissolve below the cut-off, so the lower body trails into nothing.
        float dissolve = smoothstep(${opts.dissolveFrom.toFixed(2)}, ${(opts.dissolveFrom + 0.55).toFixed(2)}, vLocalY);
        // A travelling ripple, so no surface is ever perfectly still.
        float ripple = 0.86 + 0.14 * sin(vLocalY * 14.0 - uTime * 2.6);

        gl_FragColor = vec4(col, alpha * dissolve * ripple * uPresence);
      }
    `,
  });
}

/**
 * The material for the photographed body.
 *
 * Deliberately simpler than the face and cloth shader: the artwork is already
 * lit, so relighting it only muddies it. This shows the texture, tints it very
 * slightly cold to match the head, and dissolves the hem so the figure trails
 * into the floor instead of standing on a visible edge.
 */
function bodyMaterial(
  u: Spectral, tex: THREE.Texture | null, ready: { value: number },
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uReady: ready as unknown as THREE.IUniform,
      uPresence: u.uPresence,
      uTime: u.uTime,
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      uniform float uTime;
      varying vec2 vUv;
      varying float vY;
      void main() {
        vUv = uv;
        vY = uv.y;
        vec3 p = position;
        // The hem sways; the shoulders barely move.
        float amp = pow(1.0 - uv.y, 2.0) * 0.045;
        p.x += sin(uTime * 1.15 + position.y * 2.2) * amp;
        p.z += cos(uTime * 0.9 + position.y * 1.7) * amp;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uReady;
      uniform float uPresence;
      varying vec2 vUv;
      varying float vY;
      void main() {
        if (uReady < 0.5) discard;
        vec4 tex = texture2D(uMap, vUv);
        // A touch cold, so the body belongs with the head.
        vec3 col = tex.rgb * vec3(0.93, 0.97, 1.06);
        // Dissolve the last of the hem into the floor.
        float hem = smoothstep(0.0, 0.16, vY);
        gl_FragColor = vec4(col, tex.a * hem * uPresence);
      }
    `,
  });
}

export function createGhost(): GhostModel {
  const group = new THREE.Object3D();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  /**
   * Load the artwork, tolerating its absence.
   *
   * The texture arrives asynchronously and the file may simply not be there
   * yet. Loading it straight into the material would show a white plane in the
   * meantime — the usual failure mode for runtime-loaded art, and a
   * particularly bad one on a face. So `uHasMap` stays at 0 until the image
   * actually decodes, the procedural face carries the ghost until then, and a
   * missing file just means the placeholder is permanent.
   */
  let texture: THREE.Texture | null = null;
  const faceReady = { value: 0 };
  if (GHOST_TEXTURE_URL) {
    texture = new THREE.TextureLoader().load(
      GHOST_TEXTURE_URL,
      () => { faceReady.value = 1; },
      undefined,
      () => { faceReady.value = 0; },
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    disposables.push(texture);
  }

  let bodyTexture: THREE.Texture | null = null;
  const bodyReady = { value: 0 };
  if (GHOST_BODY_URL) {
    bodyTexture = new THREE.TextureLoader().load(
      GHOST_BODY_URL,
      () => { bodyReady.value = 1; },
      undefined,
      () => { bodyReady.value = 0; },
    );
    bodyTexture.colorSpace = THREE.SRGBColorSpace;
    disposables.push(bodyTexture);
  }

  const u: Spectral = {
    uTime: { value: 0 },
    uPresence: { value: 1 },
    uLunge: { value: 0 },
    uColor: { value: new THREE.Color(0x9aa8ad) },
    uDeep: { value: new THREE.Color(0x0b0f12) },
    uMap: { value: texture },
    uHasMap: faceReady,
  };

  // Body parts hang off a torso pivot, so the lunge moves everything at once.
  const body = new THREE.Object3D();
  group.add(body);

  /**
   * The body: the supplied photograph on a curved, solid panel.
   *
   * The ghost was previously a translucent lathe — a spectral wisp you could
   * see the room through, which read as a special effect rather than a person
   * standing in the dark. A hunter has to have mass. So the body is now an
   * opaque panel carrying the body artwork, bowed around the vertical axis so
   * it is not obviously flat from an angle, with the hem dissolving into the
   * floor so it still moves like something that does not quite walk.
   */
  const bodyGeo = track(new THREE.PlaneGeometry(1.15, 1.85, 16, 20));
  {
    const pos = bodyGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      // A cylindrical bow: the edges fall away from the viewer.
      pos.setZ(i, -((x / 0.575) ** 2) * 0.22);
    }
    pos.needsUpdate = true;
    bodyGeo.computeVertexNormals();
  }
  const bodyMat = track(bodyMaterial(u, bodyTexture, bodyReady));
  const torso = new THREE.Mesh(bodyGeo, bodyMat);
  // Panel centre sits below the head (pivot 1.15 + 0.92 = 2.07m).
  torso.position.y = -0.10;
  body.add(torso);

  /**
   * A dark volume behind the panel.
   *
   * Without it the body vanishes when seen from behind or at a steep angle,
   * and you can see the room through the ghost's back. This is never really
   * looked at — it only has to stop the figure being a hole in space.
   */
  const bulkProfile: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const y = -0.02 + t * 1.62;
    const flare = Math.pow(1 - t, 1.3) * 0.34;
    bulkProfile.push(new THREE.Vector2(0.13 + flare, y));
  }
  const bulkGeo = track(new THREE.LatheGeometry(bulkProfile, 20));
  /*
   * `BackSide` only, and drawn first.
   *
   * As a double-sided opaque lathe this filled the screen with a black
   * silhouette and hid both the body artwork and the face behind it — the
   * jumpscare fired and the player saw a dark rectangle. Rendering only the
   * far wall of the volume gives the figure a back without ever putting
   * geometry between the camera and the front of it.
   */
  const bulkMat = track(new THREE.MeshBasicMaterial({
    color: 0x06080c, transparent: true, opacity: 0.92, side: THREE.BackSide,
  }));
  const shroud = new THREE.Mesh(bulkGeo, bulkMat);
  shroud.position.y = -0.95;
  shroud.renderOrder = -2;
  body.add(shroud);

  // --- Head. ---
  const headGroup = new THREE.Object3D();
  headGroup.position.y = 0.92;
  body.add(headGroup);

  const headGeo = track(new THREE.SphereGeometry(0.19, 18, 16));
  const headMat = track(spectralMaterial(u, { dissolveFrom: -0.4, useMap: false }));
  const head = new THREE.Mesh(headGeo, headMat);
  headGroup.add(head);

  /**
   * The face plate: where the artwork lands.
   *
   * A slightly curved plane sitting just proud of the head sphere, so the
   * image sits on a face rather than floating. It is a child of the head, so
   * it turns with the body and is genuinely absent when the ghost faces away
   * — which is what makes turning around and finding it there work at all.
   */
  /**
   * The face is a gently curved plane, not a patch of the head sphere.
   *
   * A `SphereGeometry` patch was the obvious choice and it was wrong twice
   * over. Its phi range put the face on the side of the head rather than the
   * front, and — less obviously — a patch inherits its slice of the sphere's
   * global UV map, so the texture was sampled through a narrow band instead
   * of across its whole width. The result was a blank grey head.
   *
   * A plane owns a clean 0..1 UV square, so the artwork lands exactly as
   * drawn. Bowing it forward at the centre keeps it sitting on a face rather
   * than floating in front of one.
   */
  const faceGeo = track(new THREE.PlaneGeometry(0.62, 0.72, 12, 14));
  {
    const pos = faceGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // Push the middle of the plane out into a shallow dome.
      const bulge = Math.cos((x / 0.31) * Math.PI * 0.5) * Math.cos((y / 0.36) * Math.PI * 0.5);
      pos.setZ(i, Math.max(0, bulge) * 0.10);
    }
    pos.needsUpdate = true;
    faceGeo.computeVertexNormals();
  }
  const faceMat = track(spectralMaterial(u, { dissolveFrom: -1.0, useMap: true }));
  const face = new THREE.Mesh(faceGeo, faceMat);
  // Sit just proud of the head sphere, facing the model's forward (+Z).
  face.position.set(0, 0.04, 0.21);
  headGroup.add(face);

  // --- The eyes. Drawn while the face is still procedural; hidden once the
  //     artwork loads, since it brings its own and two sets would fight. ---
  const eyes = new THREE.Object3D();
  {
    const eyeGeo = track(new THREE.SphereGeometry(0.045, 12, 12));
    // Red, to match the artwork's eyes, and self-lit so they hold in the dark.
    const eyeMat = track(new THREE.MeshBasicMaterial({ color: 0x8b1a1a }));
    for (const dx of [-0.082, 0.082]) {
      const e = new THREE.Mesh(eyeGeo, eyeMat);
      e.position.set(dx, 0.03, 0.225);
      eyes.add(e);
    }
    headGroup.add(eyes);
  }

  /*
   * No separate arms.
   *
   * The body artwork already has arms in it, and a pair of modelled limbs
   * sticking out of a photograph of a person reads as a glitch rather than a
   * ghost. The lunge animates the whole body instead.
   */
  const arms: THREE.Object3D[] = [];

  // --- Light. The ghost carries its own faint glow, so it separates from a
  //     dark wall and so survivors get a half-second of warning. ---
  const glow = new THREE.PointLight(0xa04444, 6.0, 6.0, 1.7);
  glow.position.y = 0.8;
  group.add(glow);

  let presence = 1;
  let lunge = 0;

  return {
    object: group,

    update(_dt, time, camera) {
      u.uTime.value = time;
      u.uPresence.value = presence;

      // --- Idle motion: a slow vertical drift and a breathing scale. It
      //     never stands still, which is most of what sells it as alive. ---
      const drift = Math.sin(time * 1.05) * 0.075;
      const breathe = 1 + Math.sin(time * 1.6) * 0.022;
      body.position.y = 1.15 + drift + lunge * 0.18;
      body.scale.set(breathe, 1 / breathe, breathe);

      // --- The head tracks the camera slightly, independently of the body.
      //     A ghost whose head is already turned toward you when you round a
      //     corner is far worse than one that has to turn. ---
      const toCam = Math.atan2(
        camera.position.x - group.position.x,
        camera.position.z - group.position.z,
      );
      const rel = wrapAngle(toCam - group.rotation.y);
      headGroup.rotation.y = clamp(rel, -0.7, 0.7) * (0.35 + lunge * 0.65);
      // Once the artwork is in, it supplies the eyes; drop the stand-ins.
      eyes.visible = faceReady.value < 0.5;
      headGroup.rotation.x = Math.sin(time * 0.8) * 0.05 - lunge * 0.22;

      // --- Arms. They sway while hunting and sweep up and forward on the
      //     lunge, which is the motion the catch is built around. ---
      for (let i = 0; i < arms.length; i++) {
        const side = i === 0 ? -1 : 1;
        const sway = Math.sin(time * 1.3 + i * 1.9) * 0.14;
        arms[i].rotation.z = side * (0.18 + sway * 0.5) - side * lunge * 0.75;
        arms[i].rotation.x = sway * 0.6 - lunge * 1.45;
      }

      // The whole form leans in as it lunges.
      body.rotation.x = -lunge * 0.28;

      glow.intensity = presence * (5.0 + Math.sin(time * 4.1) * 1.2 + lunge * 16);
    },

    setPresence(v) { presence = clamp(v, 0, 1); },
    setLunge(v) { lunge = clamp(v, 0, 1); u.uLunge.value = lunge; },
    headWorldY() {
      const v = new THREE.Vector3();
      face.getWorldPosition(v);
      return v.y;
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function wrapAngle(a: number): number {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
