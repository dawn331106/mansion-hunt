# Assets

## ghot.webp — the source artwork

The ghost as supplied: a 240x240 RGB WebP, a face lit hard from the upper left
with half of it falling into deep shadow.

## body.png — the ghost's body

A figure in a pale gown holding an axe, shot against a dark room.

## ghost.png / ghost-body.png — what the game loads

Generated from the WebP by `tools/import-ghost.py`:

    python tools/import-ghost.py

It upscales to 512x512 and adds an alpha channel. The colours are passed
through untouched, and alpha comes from a soft oval vignette rather than a
luminance key — the source is high-contrast enough that the shadowed side of
the face is exactly as dark as the background behind it, so keying on
brightness punches holes through the cheek and the open mouth. Against the
game's near-black house the source background simply disappears, so it never
needed cutting out.

Opened in an image viewer the PNG looks like a negative, because viewers
composite transparency over white. That is the viewer, not the file.

The texture maps onto a curved plane on the ghost's built 3D head, not a flat
billboard, so the ghost has a back, turns away from you, and lunges in three
dimensions at the catch. The body is keyed differently from the face. Its gown *is* separable by
luminance — it is far brighter than the room — but the source also has a lit
window frame either side of the figure which survives a pure luminance key and
left the ghost dragging a rectangle of wall around with it. The matte is
therefore narrowed toward the centre of the frame, widening downward as the
gown flares, so bright pixels out at the edges are treated as architecture.

To swap either piece of art, replace the source and re-run the script;
`GHOST_TEXTURE_URL` and `GHOST_BODY_URL` in `src/render/ghostModel.ts` already
point at the outputs.

## ghost.glb — the modelled ghost

**Currently:** `Soldier.glb` from the three.js examples (MIT licensed, via
mrdoob/three.js). A rigged humanoid with `Idle`, `Walk` and `Run` clips and a
`mixamorig:Head` bone.

It is a soldier, not a ghost, and that is a deliberate trade. Free rigged
*ghosts* with usable animation are rare; the rig is what actually matters,
because how a figure moves is most of what sells it as alive. What it is
wearing is a material problem, and material is cheap to replace — the loader
discards the original textures for a spectral shader and hangs a robe from the
chest bone, which covers the webbing and pouches and leaves a tall hooded
silhouette.

Replacing it with a purpose-built ghost model is a straight improvement and
needs no code changes. Drop a rigged humanoid `.glb` here as `ghost.glb` and
it replaces whatever is there automatically. Nothing else needs changing: the loader
scales it to 1.78m wherever the artist left it, stands its feet on the floor,
finds the head bone so the jumpscare can frame the face, and picks animation
clips by name.

This exists because four attempts at sculpting a convincing face out of
procedural geometry each got closer and none were good. A head is a lot of
specific irregular detail, and displacement functions are a poor way to author
it — every correction to the brow moved the cheekbones.

### What to look for

A **rigged humanoid** in glTF binary format. Useful sources:

- **Mixamo** (free, Adobe account) — characters plus a large animation
  library. Download the character, then download `Walk`, `Running`, `Zombie
  Scream` and `Idle` onto it. Export as FBX and convert, or use a glTF export
  if offered.
- **Sketchfab** — filter by *Downloadable* and *glTF*, and check the licence.
  Search "ghost", "wraith", "zombie woman", "horror character".
- **Quaternius** — CC0, low-poly, no attribution required.

Anything under about 50k triangles is plenty; this is a dark house and the
silhouette does most of the work.

### Animation clips

Clips are matched on substrings of their names, so most naming conventions
work without renaming anything:

| Action | Matched on |
| --- | --- |
| idle | idle, breathing, stand, tpose, rest |
| walk | walk, shamble, limp, creep, stalk |
| chase | run, sprint, chase, charge |
| attack | attack, scream, roar, yell, lunge, strike, kill |

A model with only one clip works — every missing action falls back to whatever
the file has, because a ghost walking on its idle animation still reads far
better than one sliding along frozen. A model with no clips at all works too;
it simply does not animate.

The clip is chosen from measured movement speed rather than from a flag, so
the legs always match what is happening on screen.
