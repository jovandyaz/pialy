import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { problemNotFoundHandler } from './problem.js';

const INDEX_FILE = 'index.html';
const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Default location of the built SPA. Both `src/http/` (tests, tsx) and the esbuild bundle at
 * `apps/server/dist/` sit two or three levels under `apps/`, so walk up to the `apps/` folder.
 */
export function defaultWebRoot(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  while (basename(dir) !== 'apps' && dirname(dir) !== dir) dir = dirname(dir);
  return resolve(dir, 'web', 'dist');
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** Hashed bundle files never change; the HTML shell must always be revalidated. */
function cacheControlFor(root: string, filePath: string): string {
  return filePath.startsWith(resolve(root, 'assets') + sep)
    ? `public, max-age=${ONE_YEAR_SECONDS}, immutable`
    : 'no-cache';
}

/** A request for a file (last segment has an extension) must 404 rather than fall back to the shell. */
function looksLikeFile(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return basename(path).includes('.');
}

const API_PATH = /^\/api(?:[/?]|$)/;

/**
 * Serves the built SPA at `/` with an `index.html` fallback for client-side routes.
 * Unknown `/api` paths, unknown files and non GET/HEAD requests keep the problem+json 404.
 * Returns false (after one info log) when the directory is missing, e.g. in server tests.
 */
export function registerWeb(app: FastifyInstance, webRoot: string): boolean {
  const root = resolve(webRoot);
  if (!isDirectory(root) || !existsSync(resolve(root, INDEX_FILE))) {
    app.log.info({ webRoot: root }, 'web root not found; serving the API only');
    return false;
  }

  void app.register(fastifyStatic, {
    root,
    index: INDEX_FILE,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      res.header('cache-control', cacheControlFor(root, filePath));
    },
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || API_PATH.test(request.url) || looksLikeFile(request.url)) {
      return problemNotFoundHandler(request, reply);
    }
    return reply.status(200).sendFile(INDEX_FILE);
  });
  return true;
}
