// Bundles the extension host, the analysis worker and the map webview.
//   node scripts/build.mjs               development build
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --production  minified, no source maps
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // Prefer ES module builds: UMD builds (jsonc-parser) hide their internal
  // requires from the bundler and fail at runtime.
  mainFields: ['module', 'main'],
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/extension/worker.ts'],
    outfile: 'dist/worker.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  },
  {
    ...common,
    entryPoints: ['src/webview/main.tsx'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
