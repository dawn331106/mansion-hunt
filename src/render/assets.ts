/**
 * Resolve a file in `public/` against wherever the game is served from.
 *
 * A leading slash would point at the domain root, which is wrong on GitHub
 * Pages: the site lives under `/<repo>/`, so `/assets/ghost.glb` 404s and the
 * house is empty. Vite substitutes `BASE_URL` at build time with the `base`
 * from the config, so this is correct from the root, from a subdirectory, and
 * from a local dev server alike.
 */
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}
