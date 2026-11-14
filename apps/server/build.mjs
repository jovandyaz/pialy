// Bundles the server (and the @pialy/* workspace packages, which ship TS source) into dist/.
// Third-party dependencies stay external and are resolved from node_modules at runtime.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { dependencies } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(dependencies).filter((name) => !name.startsWith('@pialy/'));

await build({
  entryPoints: ['src/main.ts', 'src/migrate.ts', 'src/seed.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external,
  logLevel: 'info',
});
