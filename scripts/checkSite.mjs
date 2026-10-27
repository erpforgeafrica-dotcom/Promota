#!/usr/bin/env node
/**
 * checkSite — static integrity for www/.
 * Fails on: dead anchors, missing local assets, dummy phone numbers,
 * unsanctioned testimonials, missing lang/title/description, broken internal links.
 * Exit 0 = pass. This does NOT judge beauty; layout/contrast need HUMAN-VERIFY.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'apps', 'web');
let fail = 0, pass = 0;
const say = s => console.log(s);
const ok = s => { pass++; say(`  PASS  ${s}`); };
const bad = (s, w) => { fail++; say(`  FAIL  ${s}\n          -> ${w}`); };

if (!existsSync(WWW)) { bad('www/', 'directory missing'); process.exit(1); }

const files = readdirSync(WWW);
const html = files.filter(f => f.endsWith('.html'));
if (!html.length) { bad('www/*.html', 'no html found'); process.exit(1); }

for (const f of html) {
  const c = readFileSync(join(WWW, f), 'utf8');
  say(`\n${f}`);

  if (!/<html[^>]+lang="/i.test(c)) bad('lang attribute', 'missing on <html>');
  else ok('html lang set');

  const title = (c.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  if (!title.trim()) bad('title', 'empty');
  else if (title.length > 70) bad('title length', `${title.length} chars (>70 truncates in SERP)`);
  else ok(`title ${title.length} chars`);

  const desc = (c.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i) || [])[1] || '';
  if (!desc.trim()) bad('meta description', 'empty');
  else if (desc.length > 165) bad('meta description length', `${desc.length} chars (>165)`);
  else ok(`meta description ${desc.length} chars`);

  if (!/name="viewport"/i.test(c)) bad('viewport meta', 'missing');
  else ok('viewport meta present');

  const ids = new Set([...c.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const anchors = [...c.matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
  const dead = [...new Set(anchors.filter(a => !ids.has(a)))];
  if (dead.length) bad('anchors', `dead: ${dead.join(', ')}`);
  else ok(`${anchors.length} anchor(s) resolve`);

  const dupes = [...c.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const dupeSet = dupes.filter((v, i) => dupes.indexOf(v) !== i);
  if (dupeSet.length) bad('duplicate ids', [...new Set(dupeSet)].join(', '));
  else ok('no duplicate ids');

  const assets = [...c.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map(m => m[1])
    .filter(u => !/^(https?:|mailto:|tel:)/.test(u));
  // config.js is intentionally optional: it carries the live publishable key
  // and is created at deploy time, never committed. Without it the form says
  // it is not connected; it never fakes a successful sign-up.
  const required = assets.filter(u => u !== 'config.js');
  const missing = [...new Set(required.filter(u => {
    // A query string is not part of the file path: /?next=/admin.html is the
    // landing page with a return destination, not a missing asset.
    const pathname = u.split('?')[0].split('#')[0];
    if (!pathname || pathname === '/') return false;
    return !existsSync(join(WWW, pathname.replace(/^\/+/, '')));
  }))];
  if (missing.length) bad('local assets', `missing: ${missing.join(', ')}`);
  else if (required.length) ok(`${required.length} local asset(s) exist (+ optional config.js)`);

  const buttons = (c.match(/<button\b/g) || []).length;
  const anchorBtns = (c.match(/class="[^"]*btn[^"]*"/g) || []).length;
  if (buttons + anchorBtns === 0) bad('calls to action', 'no buttons or .btn elements');
  else ok(`${buttons} button(s), ${anchorBtns} .btn element(s)`);

  const phones = c.match(/\+234[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{4}/g) || [];
  const dummy = phones.filter(p => /000[\s-]?000|1111|1234/.test(p));
  if (dummy.length) bad('contact phone', `dummy number(s): ${dummy.join(', ')}`);
  else if (phones.length) warnLine(f, 'phone present — must be a real monitored line');
  else ok('no phone hardcoded (use a form or real line)');

  const quotes = (c.match(/[“"][^”"]{18,}[”"]/g) || [])
    .filter(q => /\b(said|says|told us|I funded|I earned|made ₦|earned ₦)\b/i.test(q));
  const marked = /SAMPLE|DEMO|fictional|example copy/i.test(c);
  if (quotes.length && !marked) bad('testimonials', `${quotes.length} unsanctioned quote(s) — mark SAMPLE or remove`);
  else if (quotes.length) ok(`${quotes.length} quote(s) in a section marked SAMPLE`);
  else ok('no unsanctioned testimonials');

  const imgs = [...c.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const noAlt = imgs.filter(t => !/\balt=/i.test(t));
  if (noAlt.length) bad('img alt', `${noAlt.length} image(s) missing alt text`);
  else ok(`${imgs.length} image(s) have alt`);

  if (!/prefers-reduced-motion/.test(readFileSync(join(WWW, 'styles.css'), 'utf8'))) {
    bad('reduced motion', 'styles.css has no prefers-reduced-motion handling');
  } else ok('reduced-motion respected');

  // Theme switch: structural proof that the toggle exists, is labelled, and
  // the no-flash boot script runs before first paint. Behaviour (persistence,
  // OS preference) is asserted by convention, not proven here.
  if (!/name="theme-color"/i.test(c)) bad('theme-color meta', 'missing - mobile chrome will not match the theme');
  else ok('theme-color meta present');

  const themeBtns = [...c.matchAll(/<button[^>]*id="themeBtn\w*"[^>]*>/gi)].map(m => m[0]);
  const labelled = themeBtns.filter(t => /aria-pressed=/i.test(t) && /aria-label=/i.test(t));
  if (themeBtns.length === 0) bad('theme toggle', 'no #themeBtn control found');
  else if (labelled.length !== themeBtns.length) bad('theme toggle', `${themeBtns.length - labelled.length} toggle(s) missing aria-pressed or aria-label`);
  else ok(`${themeBtns.length} theme toggle(s) labelled with aria-pressed`);

  // The boot script may be inline or external, but it must run before the
  // stylesheet (render-blocking, no defer/async) so the first paint is themed.
  const beforeCss = c.split(/<link[^>]+rel=["']?stylesheet/i)[0];
  const bootSources = [];
  for (const m of beforeCss.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) bootSources.push(m[1]);
  for (const m of beforeCss.matchAll(/<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    if (/defer|async/i.test(m[0]) || /^(https?:)?\/\//i.test(m[1])) continue;
    const p = join(WWW, m[1].replace(/^\//, ''));
    if (existsSync(p)) bootSources.push(readFileSync(p, 'utf8'));
  }
  const boot = bootSources.join('\n');
  if (!/localStorage\.getItem\(['"]owoworks-theme['"]\)/.test(boot)) bad('theme boot', 'no-flash script does not read the stored theme before paint');
  else if (!/data-theme/.test(boot)) bad('theme boot', 'boot script does not set data-theme');
  else ok('no-flash theme boot present');

  const css = readFileSync(join(WWW, 'styles.css'), 'utf8');
  if (!/\[data-theme="light"\]/.test(css)) bad('light theme', 'styles.css has no [data-theme="light"] overrides');
  else ok('light theme tokens present');
  if (!/:root\s*\{\s*color-scheme:\s*dark/i.test(css) && !/color-scheme:\s*dark/i.test(css)) bad('color-scheme', 'no color-scheme declaration - form controls render in the wrong chrome');
  else ok('color-scheme declared');
}

function warnLine(f, msg) { say(`  WARN  ${f}: ${msg}`); }

say(`\n${'-'.repeat(60)}\n  PASS ${pass}  FAIL ${fail}`);
say(`  SITE CHECK: ${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);