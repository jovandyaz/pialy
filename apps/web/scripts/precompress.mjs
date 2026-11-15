// Writes `.br` and `.gz` siblings for the built text assets so the server can send them
// as-is (`@fastify/static` `preCompressed`). Already compressed formats (woff2, images) are skipped.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const DIST = resolve(import.meta.dirname, '..', 'dist');
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);
const MIN_BYTES = 1024;

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

let count = 0;
for (const path of files(DIST)) {
  if (!TEXT_EXTENSIONS.has(extname(path))) continue;
  const source = readFileSync(path);
  if (source.length < MIN_BYTES) continue;
  const variants = [
    ['.br', brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } })],
    ['.gz', gzipSync(source, { level: constants.Z_BEST_COMPRESSION })],
  ];
  for (const [suffix, compressed] of variants) {
    if (compressed.length < source.length) writeFileSync(path + suffix, compressed);
  }
  count += 1;
}
console.log(`precompressed ${count} files in ${DIST}`);
