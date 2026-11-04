import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Exercise the real adoption function from the shipped auth.js, not a copy.
// The browser file is an IIFE, so the function is lifted out the same way the
// other frontend suites do it and given stubs for the three browser globals it
// touches: location, history and the token store.
const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'auth.js'), 'utf8');

const grab = (name) => {
  const key = `function ${name}`;
  const i = src.indexOf(key);
  if (i === -1) throw new Error('missing ' + name);
  let depth = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + name);
};

const constStart = src.indexOf('var PRIVILEGED_ROLES');
if (constStart === -1) throw new Error('missing PRIVILEGED_ROLES');
const constEnd = src.indexOf(';', constStart) + 1;
const constDecl = src.slice(constStart, constEnd);

const code = [constDecl, grab('claimsOf'), grab('adoptHashToken')].join('\n');

const b64u = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const token = (claims) => `${b64u({ alg: 'HS256', typ: 'PROMOTA' })}.${b64u(claims)}.sig`;

function adopt({ hash = '', token: existing = '', historyWorks = true } = {}) {
  const store = { token: existing };
  const loc = { hash, pathname: '/admin.html', search: '?from=test' };
  const hist = {
    called: false,
    replaceState() { this.called = true; if (!historyWorks) throw new Error('unsupported'); }
  };
  const fn = new Function(
    'location', 'history', 'setToken',
    code + '\nreturn adoptHashToken;'
  )(loc, hist, (t) => { store.token = t; });
  return { adopted: fn(), stored: store.token, cleaned: hist.called };
}

const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 60;

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// No fragment: nothing is touched.
check('no fragment leaves the session alone', adopt({ token: 'keep' }), { adopted: false, stored: 'keep', cleaned: false });

// A valid owner token is adopted and erased from the URL.
{
  const t = token({ sub: 'p1', role: 'owner', exp: future });
  check('owner token adopted', adopt({ hash: '#token=' + t }), { adopted: true, stored: t, cleaned: true });
}
{
  const t = token({ sub: 'p1', role: 'admin', exp: future });
  check('admin token adopted', adopt({ hash: '#token=' + t, token: 'old' }), { adopted: true, stored: t, cleaned: true });
}
{
  const t = token({ sub: 'p1', role: 'support', exp: future });
  check('support token adopted', adopt({ hash: '#token=' + t }), { adopted: true, stored: t, cleaned: true });
}

// Login-CSRF guard: an ordinary promoter token must not replace the session.
{
  const t = token({ sub: 'p2', role: 'promoter', exp: future });
  check('promoter token refused (login CSRF)', adopt({ hash: '#token=' + t, token: 'keep' }), { adopted: false, stored: 'keep', cleaned: false });
}

// Expiry is honoured before storing.
{
  const t = token({ sub: 'p1', role: 'owner', exp: past });
  check('expired owner token refused', adopt({ hash: '#token=' + t, token: 'keep' }), { adopted: false, stored: 'keep', cleaned: false });
}
{
  const t = token({ sub: 'p1', role: 'owner' });
  check('token without exp refused', adopt({ hash: '#token=' + t }), { adopted: false, stored: '', cleaned: false });
}

// Malformed input is refused, never thrown.
check('malformed token refused', adopt({ hash: '#token=not-a-token', token: 'keep' }), { adopted: false, stored: 'keep', cleaned: false });
check('two-part token refused', adopt({ hash: '#token=a.b' }), { adopted: false, stored: '', cleaned: false });
check('other fragment ignored', adopt({ hash: '#section-2' }), { adopted: false, stored: '', cleaned: false });
check('empty token refused', adopt({ hash: '#token=' }), { adopted: false, stored: '', cleaned: false });

// A browser that refuses replaceState still keeps the adopted session.
{
  const t = token({ sub: 'p1', role: 'owner', exp: future });
  check('adoption survives replaceState failure', adopt({ hash: '#token=' + t, historyWorks: false }), { adopted: true, stored: t, cleaned: true });
}

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
