# Assets

## ghost.png

Drop the ghost artwork here as `ghost.png` — a transparent PNG works best.

It is mapped onto the face of the ghost's built 3D head (see
`src/render/ghostModel.ts`), not used as a flat billboard, so the ghost still
has a back, still turns away from you, and still lunges in three dimensions at
the catch.

Until the file exists the game draws a procedural spectral face instead and
everything else about the body is identical, so nothing blocks on the art.
`GHOST_TEXTURE_URL` in `ghostModel.ts` is the only line to change if you want
it somewhere else.
