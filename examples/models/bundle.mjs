// #region esbuild-bundle
import { golem } from '@exprtlabs/golem/esbuild';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: '.build/bundle/main.js',
  plugins: [golem()],
});
// #endregion esbuild-bundle
