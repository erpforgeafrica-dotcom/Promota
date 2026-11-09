#!/usr/bin/env node
/**
 * checkDomContract.mjs — does every element id a page script reaches for exist
 * on the page that loads it?
 *
 * This is the static half of the "dead wiring" class of bug: a script binds
 * `getElementById('x')` but the page never ships `#x`, so the handler silently
 * never runs. It cannot prove that a handler is reached at runtime — for that,
 * use `promota-ui-verify` against a live page — but it makes the cheap failure
 * loud in `npm test` instead of in a browser console on launch day.
 *
 * Resolution rules, in order, for a reference `script -> #x` on page P:
 *   1. `#x` is in P's HTML                       -> satisfied
 *   2. `#x` is created by the script itself       -> satisfied
 *      (`el.id = 'x'`, `setAttribute('id', 'x')`, or `id="x"` inside markup
 *      the script injects, e.g. an innerHTML template)
 *   3. another page that loads the same script    -> optional, reported as NOTEs
 *      ships `#x` (a shared script such as landing.js runs on pages with and
 *      without the auth modal)
 *   4. none of the above                          -> FAIL
 *
 * Exit 1 on any FAIL. Not part of the build; run by npm test.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps', 'web');

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  PASS  ${msg}`); }
function bad(msg, detail) {
  fail++;
  console.log(`  FAIL  ${msg}`);
  if (detail) console.log(`             ${detail}`);
}

const ID = '[A-Za-z0-9_:.-]+';
const refRe = new RegExp(`(?:getElementById|byId)\\(\\s*["'](${ID})["']\\s*\\)`, 'g');
const createdRes = [
  new RegExp(`\\.id\\s*=\\s*["'](${ID})["']`, 'g'),
  new RegExp(`setAttribute\\(\\s*["']id["']\\s*,\\s*["'](${ID})["']`, 'g'),
  new RegExp(`\\bid\\s*=\\s*["'](${ID})["']`, 'g'),
];

function idsIn(markup) {
  return new Set([...markup.matchAll(new RegExp(`\\bid\\s*=\\s*["'](${ID})["']`, 'g'))].map((m) => m[1]));
}
function refsIn(code) {
  return new Set([...code.matchAll(refRe)].map((m) => m[1]));
}
function createdIn(code) {
  const out = new Set();
  for (const re of createdRes) for (const m of code.matchAll(re)) out.add(m[1]);
  return out;
}

const pages = readdirSync(WEB).filter((f) => f.endsWith('.html'));

/* First pass: everything each page can offer, per script it loads. */
const pageIds = new Map();
const pageScripts = new Map();
const scriptCode = new Map();
const scriptRefs = new Map();
const scriptCreated = new Map();
const missingFiles = [];

for (const page of pages) {
  const src = readFileSync(join(WEB, page), 'utf8');
  const ids = idsIn(src);
  pageIds.set(page, ids);
  const scripts = [...new Set([...src.matchAll(/<script[^>]*\bsrc="\/([^"]+)"/g)].map((m) => m[1]))];
  pageScripts.set(page, scripts);

  for (const s of scripts) {
    if (scriptCode.has(s)) continue;
    const p = join(WEB, s);
    if (!existsSync(p)) { missingFiles.push(`${page} -> ${s}`); scriptCode.set(s, ''); continue; }
    const code = readFileSync(p, 'utf8');
    scriptCode.set(s, code);
    scriptRefs.set(s, refsIn(code));
    scriptCreated.set(s, createdIn(code));
  }
}

if (missingFiles.length === 0) ok('every <script src> resolves to a file');
else bad('a page loads a script that does not exist', [...new Set(missingFiles)].join('\n             '));

/* An id is "provided by another page" if any other page loading the same
   script can offer it (statically or through the script's own injection). */
function providedElsewhere(script, id, exceptPage) {
  for (const [page, scripts] of pageScripts) {
    if (page === exceptPage || !scripts.includes(script)) continue;
    if (pageIds.get(page).has(id)) return true;
    if ((scriptCreated.get(script) || new Set()).has(id)) return true;
  }
  return false;
}

const hardMissing = [];
const optional = new Map();
let checkedRefs = 0;

for (const page of pages) {
  for (const script of pageScripts.get(page)) {
    const refs = scriptRefs.get(script);
    if (!refs) continue;
    const ids = pageIds.get(page);
    const created = scriptCreated.get(script) || new Set();
    for (const id of refs) {
      checkedRefs++;
      if (ids.has(id) || created.has(id)) continue;
      if (providedElsewhere(script, id, page)) {
        if (!optional.has(script)) optional.set(script, new Set());
        optional.get(script).add(id);
        continue;
      }
      hardMissing.push(`${page}: ${script} -> #${id}`);
    }
  }
}

const uniqueMissing = [...new Set(hardMissing)];
if (uniqueMissing.length === 0) {
  ok(`every element lookup has a target (${pages.length} pages, ${scriptCode.size} scripts, ${checkedRefs} refs)`);
} else {
  bad('a page script reaches for an id the page does not ship',
    uniqueMissing.join('\n             '));
}

if (optional.size) {
  const lines = [];
  for (const [script, ids] of optional) {
    lines.push(`${script}: ${[...ids].sort().map((i) => '#' + i).join(', ')}`);
  }
  console.log(`  NOTE  ${optional.size} shared script(s) look up ids only some host pages ship`);
  for (const l of lines) console.log(`          -> ${l}`);
}

console.log(`\n  ${pass} PASS   ${fail} FAIL`);
console.log(`  DOM CONTRACT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exitCode = fail === 0 ? 0 : 1;
