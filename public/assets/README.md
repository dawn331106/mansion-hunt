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

## werewolf-howl.mp3 — the wolf outside

A recorded howl, 4.8s, which replaced the synthesised one in
`src/audio/ambience.ts`. It takes turns with the owl and the scream: it opens
the rotation 7s into every match, then each call follows 7-12s after the last, starting past the quarter-second of silence the file opens with,
rolled off above 3.4kHz so it sounds like it is outside the walls, and pitched
slightly differently each time. `npm run ambiencetest` checks it stays clearly
above the ambient bed.

## ghost-chant.mp3 — the ghost's voice

A demon speaking Latin, 26.5s, which replaced the synthesised taunts. It loops
continuously for the whole match, from the ghost's mouth through a panner, so
survivors hear it faintly across the house and loud and placed when the ghost
is close. The loop skips the file's short fade-in and fade-out. The ghost's
own player does not hear it.

## jumpscare.mp3 — the catch

Played on the frame the ghost catches you. The file opens with 2.44s of
silence, so playback always starts just before the scream.

## footsteps.mp3 — every footstep

Eight single footfalls about 0.6s apart. The audio engine cuts them apart
when it loads the file, by finding each step's attack, and plays a random one
(slightly re-pitched) for every step anyone takes, placed where they took it.
Replacing the file with another take of separate steps works without code
changes. Until it has loaded, the synthesised steps play instead.

## owl-hoot.mp3 — the owl in the grounds

An owl hooting, 4.8s, which replaced the synthesised dog barks. It follows
the howl in the rotation, 7-12s after it, starting past the 0.84s of silence
the file opens with, rolled off above 3kHz for distance and pitched
slightly differently each time.

## spotted.mp3 — the ghost sees you

Played the moment the ghost's eyes land on a survivor, for that survivor only,
in place of the synthesised shriek. A new spot restarts it rather than
stacking a second copy, and a catch fades it out so the jumpscare plays clean.

## demon-scream.mp3 — something screaming in the house

A demon scream, 4.5s, in the slot the synthesised crying had. Third in the
rotation after the howl and the owl, 7-12s after the hoot, starting past the
short silence the file opens with, rolled off above 4.2kHz and pitched
slightly differently each time.
