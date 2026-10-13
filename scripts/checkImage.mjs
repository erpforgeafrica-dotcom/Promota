#!/usr/bin/env node
/**
 * checkImage.mjs — regression guard for the Docker image contents.
 *
 * HISTORY: the image once COPYed only apps/web + server.mjs, while server.mjs
 * imports ./api/routes.mjs and ./api/worker.mjs, which in turn import
 * ../providers/*. The container therefore died at boot with
 * ERR_MODULE_NOT_FOUND and the Railway /healthz check failed — a silent deploy
 * failure that only shows up as "unhealthy", not as a build error.
 *
 * This test walks every local (./ or ../) import reachable from server.mjs,
 * asserts each imported file actually exists, and asserts every top-level path
 * it needs is COPYed into the image by the Dockerfile.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

function localImports(src) {
  const out = [];
  let m;
  while ((m = IMPORT_RE.exec(src)) !== null) out.push(m[1]);
  return out;
}

function resolveSpec(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  if (existsSync(base)) return base;
  if (existsSync(`${base}.mjs`)) return `${base}.mjs`;
  if (existsSync(`${base}.js`)) return `${base}.js`;
  return base;
}

/* Walk the import graph from server.mjs. */
const seen = new Set();
const missing = [];
const neededTop = new Set();

function walk(file) {
  const abs = resolve(file);
  if (seen.has(abs)) return;
  seen.add(abs);
  if (!abs.startsWith(ROOT + sep)) return;
  if (!existsSync(abs)) { missing.push(relative(ROOT, abs)); return; }

  const rel = relative(ROOT, abs);
  neededTop.add(rel.split(sep)[0]);

  const src = readFileSync(abs, 'utf8');
  for (const spec of localImports(src)) walk(resolveSpec(abs, spec));
}

walk(join(ROOT, 'server.mjs'));

/* Parse what the Dockerfile actually copies. */
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const copied = new Set();
for (const line of dockerfile.split(/\r?\n/)) {
  const m = /^\s*COPY\s+(?:--[^\s]+\s+)*(\S+)\s+\S+/.exec(line);
  if (m) copied.add(m[1].replace(/^\.\//, '').replace(/\/+$/, ''));
}

const isCovered = (top) => [...copied].some(c => c === top || top.startsWith(c + sep) || c.startsWith(top + sep));

console.log('image contents (server.mjs import graph vs Dockerfile COPY)\n');

check('every imported local file exists',
  missing.length === 0, `missing: ${missing.join(', ')}`);

check('server.mjs imports are discovered', neededTop.size >= 2, [...neededTop].join(', '));

for (const top of [...neededTop].sort()) {
  check(`the image ships "${top}"`, isCovered(top),
    `Dockerfile COPY sources: ${[...copied].join(', ') || '(none)'}`);
}

check('api/ is copied (server.mjs imports ./api/routes.mjs)',
  [...copied].includes('api'), [...copied].join(', '));
check('providers/ is copied (routes + worker import ../providers/*)',
  [...copied].includes('providers'), [...copied].join(', '));

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
console.log(`  IMAGE CONTENTS: ${fail === 0 ? 'ALL HOLD' : 'BREACHED'}`);
process.exit(fail === 0 ? 0 : 1);
