import { defineConfig } from 'vite';

/**
 * Build configuration.
 *
 * The only thing that needs saying here is `base`. GitHub Pages serves a
 * project site from `https://<user>.github.io/<repo>/`, not from the root, so
 * every asset reference has to carry that prefix — otherwise the page loads
 * and the script, the model and the textures all 404, which looks exactly
 * like a broken game rather than a misconfigured path.
 *
 * `./` makes every reference relative to the page, which works from the root,
 * from a subdirectory, and from a local `file://` open. That is more robust
 * than hard-coding the repository name, and it means nothing here has to
 * change if the repo is renamed or the game is served from somewhere else.
 */
export default defineConfig({
  base: './',
  build: {
    // Source maps are worth the few hundred kilobytes: without them a stack
    // trace from someone else's browser is unreadable minified output.
    sourcemap: true,
  },
});
