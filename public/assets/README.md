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
