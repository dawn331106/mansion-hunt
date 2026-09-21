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
 * Resolve a file in `public/` against wherever the game is served from.
 *
 * A leading slash would point at the domain root, which is wrong on GitHub
 * Pages: the site lives under `/<repo>/`, so `/assets/ghost.png` 404s and the
 * ghost loses its face. Vite substitutes `BASE_URL` at build time with the
 * `base` from the config, so this is correct from the root, from a
 * subdirectory, and from a local dev server alike.
 */
function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}

/**
 * Path to the ghost artwork, served from `public/`.
 *
 * A transparent PNG of the face or upper body works best. The shader tints and
 * dissolves it, so a flat, evenly-lit source image is fine — no need to
 * pre-darken it.
 */
export const GHOST_TEXTURE_URL: string | null = assetUrl('assets/ghost.png');

/**
 * Path to the ghost's body artwork, served from `public/`.
 *
 * Generated from `body.png` by `tools/import-ghost.py`. Set to null to fall
 * back to the procedural form.
 */
export const GHOST_BODY_URL: string | null = assetUrl('assets/ghost-body.png');


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

/**
 * The head's material.
 *
 * Unlike the old face plane, this shades: a light direction gives the skull
 * form, so the brow catches the light and the far cheek falls away, and the
 * artwork is modulated by that shading instead of being pasted on flat. The
 * `aFront` attribute fades the texture out around the sides, so the face
 * belongs to the front of the head and the back is bare bone-dark.
 */
function headMaterial(
  u: Spectral, tex: THREE.Texture | null, ready: { value: number },
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uReady: ready as unknown as THREE.IUniform,
      uPresence: u.uPresence,
      uLunge: u.uLunge,
      uTime: u.uTime,
    },
    transparent: true,
    // Depth-write is ON here, unlike every other part of this model. The head
    // is a closed solid, so it can and should occlude itself — that is what
    // stops the back of the skull showing through the face.
    depthWrite: true,
    side: THREE.FrontSide,
    vertexShader: `
      attribute float aFront;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vFront;
      varying float vY;
      void main() {
        vUv = uv;
        vFront = aFront;
        vY = uv.y;
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uReady;
      uniform float uPresence;
      uniform float uLunge;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vFront;
      varying float vY;

      void main() {
        vec3 n = normalize(vNormal);

        // A key light from above and slightly to the side, so the skull has
        // form of its own rather than relying on the room to model it.
        vec3 L = normalize(vec3(-0.35, 0.82, 0.45));
        float diff = clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0);
        // Fresnel picks out the silhouette, which is most of what you see of
        // a head in a dark room.
        float fres = pow(1.0 - abs(dot(n, normalize(vView))), 2.2);

        // Bare skull: cold, dark, faintly lit at the rim.
        vec3 bone = mix(vec3(0.045, 0.050, 0.058), vec3(0.34, 0.36, 0.38), diff);
        bone += fres * 0.22;

        vec3 col = bone;
        if (uReady > 0.5 && vFront > 0.02) {
          vec4 tex = texture2D(uMap, vUv);
          // Blend the artwork in over the front, fading around the sides so
          // there is no hard edge where the projection stops.
          float w = smoothstep(0.10, 0.55, vFront) * tex.a;
          // The artwork is already painted with its own light; this keeps a
          // little of the geometric shading so it turns with the head.
          vec3 lit = tex.rgb * (0.72 + diff * 0.55 + uLunge * 2.0);
          col = mix(bone, lit, w);
        }

        gl_FragColor = vec4(col, uPresence);
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
  torso.renderOrder = 5;
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

  /**
   * The head: a real skull, with the artwork wrapped over its front.
   *
   * Two earlier attempts failed in instructive ways. A sphere behind a flat
   * face plane rendered as a hard black disc, because with `depthWrite` off
   * the camera sees the inside of the sphere's far wall through the near one.
   * Removing the sphere fixed the disc but left the face a picture hanging in
   * the air — a bowed plane is still a plane, and at 10cm of bulge across a
   * 62cm face there is nothing for the light to model.
   *
   * So the head is now built as a solid of revolution — a proper cranium
   * profile, narrow at the crown, widest at the temples, tapering to a jaw —
   * and the face texture is projected onto its front hemisphere. The same
   * mesh carries both, so there is no seam to see and nothing to sit in front
   * of anything else. It shades like a head because it is one: turn it and
   * the cheek catches the light, the far side falls into shadow, and the
   * silhouette against a lit doorway is a skull rather than a rectangle.
   */
  const headGeo = (() => {
    const profile: THREE.Vector2[] = [];
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      // y runs from the crown (+0.21) down to under the jaw (-0.23).
      const y = 0.21 - t * 0.44;
      let r: number;
      if (t < 0.14) {
        // The dome of the skull: a circular arc, not a cone.
        r = 0.175 * Math.sqrt(Math.max(0, 1 - ((0.14 - t) / 0.15) ** 2));
      } else if (t < 0.46) {
        // Temples, the widest part of a head.
        r = 0.175 + 0.012 * Math.sin(((t - 0.14) / 0.32) * Math.PI);
      } else if (t < 0.74) {
        // Cheekbones, drawing in.
        r = 0.187 - 0.045 * ((t - 0.46) / 0.28);
      } else {
        // The jaw, tapering to the chin.
        r = 0.142 - 0.105 * ((t - 0.74) / 0.26) ** 1.5;
      }
      profile.push(new THREE.Vector2(Math.max(0.012, r), y));
    }
    const g = new THREE.LatheGeometry(profile, 28);

    /*
     * Project the face texture onto the front of the skull.
     *
     * A lathe's own UVs wrap all the way around, which would smear the face
     * across the back of the head. These are planar coordinates taken from x
     * and y, so the artwork lands on the front exactly as drawn, and the
     * `vFront` attribute lets the shader fade it out around the sides rather
     * than letting it wrap.
     */
    const pos = g.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    const front = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      /*
       * Planar projection, corrected for the head's actual extents.
       *
       * Dividing x by a guessed width smears the artwork: the skull is only
       * about 0.19 wide at the temples, so x/0.42 sampled the middle third of
       * the texture and stretched it over the whole face. Mapping x across
       * the true half-width, and y across the true crown-to-chin span, lands
       * the eyes on the eyes.
       */
      /*
       * Cylindrical projection, measured from the head's true front.
       *
       * Three separate attempts at a planar x/y mapping all smeared the face
       * into one cheek, and the reason was not the divisor: `LatheGeometry`
       * begins its sweep at +Z and rotates toward +X, so "front" in the
       * projection was ninety degrees away from the front of the model. The
       * angle around the axis is the honest coordinate here — it says exactly
       * how far round the skull a vertex sits, so the artwork wraps the front
       * hemisphere evenly and stops where the cheeks turn away.
       */
      const ang = Math.atan2(x, z);            // 0 at the front, ±PI behind
      /*
       * The face occupies the front ~100 degrees of the skull.
       *
       * Spreading it over 150 wrapped the artwork's edges round onto the
       * cheeks and squashed the features toward the middle. A real face sits
       * on the front of a head and stops at the temples, so the projection
       * should too — everything past that is bare bone.
       */
      const spread = Math.PI * 0.56;
      uv[i * 2] = ang / spread + 0.5;
      uv[i * 2 + 1] = (y + 0.230) / (0.210 + 0.230);

      // 1 on the front of the head, falling to 0 at the sides and behind.
      front[i] = Math.max(0, Math.cos(ang));
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aFront', new THREE.BufferAttribute(front, 1));
    g.computeVertexNormals();
    return track(g);
  })();

  const faceMat = track(headMaterial(u, texture, faceReady));
  const face = new THREE.Mesh(headGeo, faceMat);
  face.position.set(0, 0.02, 0);
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
    eyes.renderOrder = 11;
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
      /*
       * Turn the head toward the camera, in the body's own frame.
       *
       * This subtracted a world angle from `group.rotation.y`, which is the
       * sim's yaw after conversion — two different conventions, so the result
       * was a meaningless offset that swung the head up to forty degrees off
       * and left the face pointing at a wall. Transforming the camera into
       * the group's local space asks the question directly: which way is the
       * camera, from where the body is facing?
       */
      const local = group.worldToLocal(camera.position.clone());
      const rel = Math.atan2(local.x, local.z);
      headGroup.rotation.y = clamp(rel, -0.45, 0.45) * (0.22 + lunge * 0.55);
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

