/**
 * Bundles worker/index.ts for Cloudflare Workers.
 *
 * Aliases applied so the shared parser code runs unmodified:
 *   ../utils/axiosClient -> src/utils/fetchClient  (fetch instead of axios)
 *   axios                -> worker/shims/axios     (AxiosError class only)
 *   http-errors          -> worker/shims/http-errors (no Node `util`)
 *
 * Usage: node worker/build.mjs
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('esbuild').Plugin} */
const aliasPlugin = {
  name: 'worker-aliases',
  setup(b) {
    b.onResolve({ filter: /axiosClient$/ }, args => ({
      path: path.resolve(root, 'src/utils/fetchClient.ts'),
    }));
    b.onResolve({ filter: /^axios$/ }, () => ({
      path: path.resolve(root, 'worker/shims/axios.ts'),
    }));
    b.onResolve({ filter: /^http-errors$/ }, () => ({
      path: path.resolve(root, 'worker/shims/http-errors.ts'),
    }));
  },
};

const result = await build({
  entryPoints: [path.resolve(root, 'worker/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: path.resolve(root, 'worker/dist/index.js'),
  plugins: [aliasPlugin],
  conditions: ['worker', 'browser'],
  mainFields: ['browser', 'module', 'main'],
  logLevel: 'info',
  minify: true,
});

console.log('Worker bundle written to worker/dist/index.js');
