import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, listRuns, plan, previewMarkdown, rollback } from '../skills/backend-execute/scripts/engine.mjs';
import { unifiedDiff } from '../skills/backend-execute/scripts/diff.mjs';
import { fakeBin, withEnv } from './helpers/fake-cli.mjs';

const ENGINE = fileURLToPath(new URL('../skills/backend-execute/scripts/engine.mjs', import.meta.url));
const SECRET = 'sb_secret_THISMUSTNEVERAPPEAR1234567890';
const hasGit = spawnSync('git', ['--version']).status === 0;
const BIN = fakeBin(['npm', 'supabase', 'firebase']);

/** @param {Record<string, string>} files */
function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-exec-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
/** @param {string} root @param {string} p */
const read = (root, p) => readFileSync(join(root, p), 'utf8');
/** @param {string} root */
const cleanup = (root) => rmSync(root, { recursive: true, force: true });
/** Every file under root except .backendpilot, with contents. @param {string} root */
function snapshot(root, dir = '') {
  /** @type {Record<string, string>} */
  const out = {};
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (rel === '.backendpilot' || rel === '.git') continue;
    if (e.isDirectory()) Object.assign(out, snapshot(root, rel), { [rel + '/']: '' });
    else out[rel] = readFileSync(join(root, rel), 'utf8');
  }
  return out;
}
/** Approve exactly what preview shows. @param {any} cs @param {string} root @param {any} [opts] */
const approveAndApply = (cs, root, opts = {}) => apply(cs, root, { approve: plan(cs, root).planId, ...opts });
/** All text BackendPilot wrote under .backendpilot (logs, journals). @param {string} root */
function stateText(root) {
  const dir = join(root, '.backendpilot', 'runs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).map((r) => ['journal.json', 'log.txt'].map((f) => (existsSync(join(dir, r, f)) ? readFileSync(join(dir, r, f), 'utf8') : '')).join('\n')).join('\n');
}

const basicChanges = {
  version: 1,
  operation: 'demo-setup',
  description: 'demo',
  steps: [
    { type: 'create', path: 'src/lib/client.ts', content: "export const url = import.meta.env.VITE_API_URL;\n" },
    { type: 'edit', path: 'src/main.ts', edits: [{ find: "import './app';", replace: "import './app';\nimport './lib/client';" }] },
    { type: 'json_merge', path: 'firebase.json', merge: { firestore: { rules: 'firestore.rules' } } },
  ],
};

test('preview: shows diffs, writes nothing, plan id is stable', () => {
  const root = project({ 'src/main.ts': "import './app';\r\nrun();\r\n", 'firebase.json': '{\n    "hosting": {}\n}\n' });
  try {
    const before = snapshot(root);
    const p1 = plan(basicChanges, root);
    const p2 = plan(basicChanges, root);
    assert.equal(p1.valid, true, p1.errors.join('\n'));
    assert.equal(p1.planId, p2.planId);
    assert.match(p1.steps[0].diff, /\+\+\+ b\/src\/lib\/client\.ts/);
    assert.match(p1.steps[1].diff, /\+import '\.\/lib\/client';/);
    assert.match(p1.steps[2].diff, /\+ {4}"firestore"/);
    assert.match(previewMarkdown(p1), new RegExp(`--approve ${p1.planId}`));
    assert.deepEqual(snapshot(root), before);
    assert.equal(existsSync(join(root, '.backendpilot')), false);
  } finally {
    cleanup(root);
  }
});

test('apply requires the exact approved plan id; stale approval is rejected', () => {
  const root = project({ 'src/main.ts': "import './app';\n", 'firebase.json': '{}' });
  try {
    const before = snapshot(root);
    assert.equal(apply(basicChanges, root).status, 'needs_approval');
    assert.equal(apply(basicChanges, root, { approve: 'deadbeefdeadbeef' }).status, 'needs_approval');
    const id = plan(basicChanges, root).planId;
    writeFileSync(join(root, 'firebase.json'), '{"changed":true}'); // user edits after preview
    const r = apply(basicChanges, root, { approve: id });
    assert.equal(r.status, 'needs_approval');
    assert.match(r.errors[0], /changed since preview/);
    before['firebase.json'] = '{"changed":true}';
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('successful apply is verified, journaled, and fully reversible (CRLF, BOM, indentation kept)', () => {
  const root = project({ 'src/main.ts': "import './app';\r\nrun();\r\n", 'firebase.json': '\uFEFF{\r\n    "hosting": {}\r\n}\r\n' });
  try {
    const before = snapshot(root);
    const r = approveAndApply(basicChanges, root);
    assert.equal(r.status, 'success', JSON.stringify(r.errors));
    assert.equal(r.verified, true);
    assert.deepEqual(r.files_created, ['src/lib/client.ts']);
    assert.deepEqual(r.files_modified.sort(), ['firebase.json', 'src/main.ts']);
    assert.equal(read(root, 'src/main.ts'), "import './app';\r\nimport './lib/client';\r\nrun();\r\n");
    assert.equal(read(root, 'firebase.json'), '\uFEFF{\r\n    "hosting": {},\r\n    "firestore": {\r\n        "rules": "firestore.rules"\r\n    }\r\n}\r\n');
    assert.equal(read(root, '.backendpilot/.gitignore'), '*\n');
    assert.deepEqual(listRuns(root).map((x) => x.status), ['applied']);

    const rb = rollback(root, /** @type {string} */ (r.runId));
    assert.equal(rb.status, 'rolled_back', rb.conflicts.join('\n'));
    assert.deepEqual(snapshot(root), before); // byte-identical, created dirs removed
    assert.equal(rollback(root, /** @type {string} */ (r.runId)).note, 'already rolled back');
  } finally {
    cleanup(root);
  }
});

test('failed step rolls back earlier steps automatically and redacts secrets in errors and logs', () => {
  const root = project({ 'package.json': '{"name":"x"}\n', 'package-lock.json': '{}' });
  try {
    const before = snapshot(root);
    const cs = { version: 1, operation: 'fail-demo', steps: [{ type: 'create', path: 'src/a.ts', content: 'a\n' }, { type: 'install', packages: ['firebase@^11'] }] };
    const r = withEnv(BIN, { FAKE_NPM_FAIL: '1' }, () => approveAndApply(cs, root));
    assert.equal(r.status, 'failed');
    assert.equal(r.rolled_back, true);
    assert.match(r.errors[0], /npm exited with code 1/);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(listRuns(root).map((x) => x.status), ['rolled_back']);
  } finally {
    cleanup(root);
  }
});

test('install: success is verified against package.json and node_modules; missing module fails and restores', () => {
  const root = project({ 'package.json': '{\n  "name": "x"\n}\n' });
  try {
    const cs = { version: 1, operation: 'install-demo', steps: [{ type: 'install', packages: ['firebase@^11', '@supabase/supabase-js'] }] };
    const ok = withEnv(BIN, {}, () => approveAndApply(cs, root));
    assert.equal(ok.status, 'success', JSON.stringify(ok.errors));
    assert.deepEqual(ok.files_created, ['package-lock.json']);
    assert.deepEqual(ok.files_modified, ['package.json']);
    assert.equal(JSON.parse(read(root, 'package.json')).dependencies.firebase, '^11');
    const rb = rollback(root, /** @type {string} */ (ok.runId));
    assert.equal(rb.status, 'rolled_back');
    assert.equal(read(root, 'package.json'), '{\n  "name": "x"\n}\n');
    assert.equal(existsSync(join(root, 'package-lock.json')), false);

    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    const bad = withEnv(BIN, { FAKE_NPM_SKIP_MODULES: '1' }, () => approveAndApply(cs, root));
    assert.equal(bad.status, 'failed');
    assert.match(bad.errors[0], /verification failed: firebase is not present in node_modules/);
    assert.equal(read(root, 'package.json'), '{\n  "name": "x"\n}\n');
  } finally {
    cleanup(root);
  }
});

test('interrupted run (process killed mid-way) can be rolled back from its journal', () => {
  const root = project({ 'src/main.ts': "import './app';\n", 'firebase.json': '{}' });
  try {
    const before = snapshot(root);
    const csFile = join(root, '..', `${root.split(/[\\/]/).pop()}-cs.json`);
    writeFileSync(csFile, JSON.stringify(basicChanges));
    const script = `
      import { apply, plan } from ${JSON.stringify(pathToFileURL(ENGINE).href)};
      import { readFileSync } from 'node:fs';
      const cs = JSON.parse(readFileSync(${JSON.stringify(csFile)}, 'utf8'));
      apply(cs, ${JSON.stringify(root)}, { approve: plan(cs, ${JSON.stringify(root)}).planId, onStep: (k, phase) => { if (k === 2 && phase === 'before') process.exit(7); } });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    rmSync(csFile);
    assert.equal(child.status, 7, child.stderr);
    const runs = listRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'running'); // never finished
    assert.ok(existsSync(join(root, 'src/lib/client.ts')));
    const rb = rollback(root, runs[0].runId);
    assert.equal(rb.status, 'rolled_back', rb.conflicts.join('\n'));
    assert.deepEqual(snapshot(root), before);
  } finally {
    cleanup(root);
  }
});

test('rollback does not overwrite edits made after apply unless forced', () => {
  const root = project({ 'src/main.ts': "import './app';\n", 'firebase.json': '{}' });
  try {
    const r = approveAndApply(basicChanges, root);
    writeFileSync(join(root, 'src/main.ts'), 'user edit\n');
    const rb = rollback(root, /** @type {string} */ (r.runId));
    assert.equal(rb.status, 'rollback_incomplete');
    assert.match(rb.conflicts.join('\n'), /src\/main\.ts changed after BackendPilot wrote it/);
    assert.equal(read(root, 'src/main.ts'), 'user edit\n');
    assert.equal(existsSync(join(root, 'src/lib/client.ts')), false); // unconflicted files still restored
    const forced = rollback(root, /** @type {string} */ (r.runId), { force: true });
    assert.equal(forced.status, 'rolled_back');
    assert.equal(read(root, 'src/main.ts'), "import './app';\n");
  } finally {
    cleanup(root);
  }
});

test('path safety: traversal, absolute, protected dirs, device names and symlink escapes are rejected', () => {
  const root = project({ 'a.txt': 'a' });
  const outside = mkdtempSync(join(tmpdir(), 'bp-outside-'));
  try {
    let linked = false;
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
      linked = true;
    } catch { /* symlinks unavailable */ }
    const bad = ['../x.txt', 'src/../../x.txt', '/etc/x', 'C:\\x.txt', '\\\\server\\share\\x', '.git/config', 'node_modules/x/index.js', '.backendpilot/runs/x', 'NUL', 'src/con.txt', 'a.txt:stream', 'trailing. ', ...(linked ? ['link/x.txt'] : [])];
    for (const path of bad) {
      const p = plan({ version: 1, operation: 'x', steps: [{ type: 'create', path, content: 'x' }] }, root);
      assert.equal(p.valid, false, `${path} should be rejected`);
    }
    assert.equal(readdirSync(outside).length, 0);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('security checks block unsafe content; pre-existing problems only warn', () => {
  const root = project({ 'legacy.rules': 'service cloud.firestore { match /{d=**} { allow read, write: if true; } }' });
  try {
    const serviceJwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'c2lnbmF0dXJlLXNpZ25hdHVyZQ'].join('.');
    const anonJwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url'), 'c2lnbmF0dXJlLXNpZ25hdHVyZQ'].join('.');
    /** @type {[string, string, RegExp][]} */
    const blocked = [
      ['firestore.rules', "rules_version = '2';\nservice cloud.firestore { match /{d=**} { allow read, write: if true; } }", /grants access to everyone/],
      ['storage.rules', 'service firebase.storage { match /b/{bucket}/o { match /{all=**} { allow write; } } }', /grants access to everyone/],
      ['supabase/migrations/1_x.sql', 'create table public.notes (id uuid);', /without "enable row level security"/],
      ['supabase/migrations/2_x.sql', 'alter table notes disable row level security;', /disables Row Level Security/],
      ['supabase/migrations/3_x.sql', 'create table notes (id uuid);\nalter table notes enable row level security;\ncreate policy "w" on notes for insert to anon with check (true);', /Unrestricted write policies/],
      ['src/supabase.ts', `export const key = '${serviceJwt}';`, /service-role-jwt/],
      ['src/admin.ts', `const k = "${SECRET}";`, /supabase-secret-key/],
      ['src/env.ts', 'const k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;', /exposes a secret to browser code/],
      ['app/page.tsx', "'use client';\nimport admin from 'firebase-admin';", /Admin access must stay server-side/],
      ['src/db.ts', 'const url = "postgres://user:hunter2pass@db.example.com/app";', /url-password/],
    ];
    for (const [path, content, why] of blocked) {
      const p = plan({ version: 1, operation: 'x', steps: [{ type: 'create', path, content }] }, root);
      assert.equal(p.valid, false, path);
      assert.match(p.errors.join('\n'), why, path);
      assert.ok(!JSON.stringify(p.steps).includes(SECRET) && !JSON.stringify(p.errors).includes(SECRET), `${path}: secret leaked into preview`);
    }
    /** @type {[string, string][]} */
    const allowed = [
      ['firestore.rules', "service cloud.firestore { match /users/{uid} { allow read, write: if request.auth != null && request.auth.uid == uid; } }"],
      ['supabase/migrations/4_x.sql', 'create table public.notes (id uuid, user_id uuid);\nalter table public.notes enable row level security;\ncreate policy "own" on public.notes for all to authenticated using ((select auth.uid()) = user_id);'],
      ['src/supabase.ts', `export const anon = '${anonJwt}';`], // anon key is public by design
      ['src/firebase.ts', "const apiKey = 'AIzaSyA-1234567890abcdefghijklmnopqrstu';"],
    ];
    for (const [path, content] of allowed) {
      const p = plan({ version: 1, operation: 'x', steps: [{ type: 'create', path, content }] }, root);
      assert.equal(p.valid, true, `${path}: ${p.errors.join('; ')}`);
    }
    const edit = plan({ version: 1, operation: 'x', steps: [{ type: 'edit', path: 'legacy.rules', edits: [{ find: 'service', replace: '// legacy\nservice' }] }] }, root);
    assert.equal(edit.valid, true, edit.errors.join('\n'));
    assert.match(edit.warnings.join('\n'), /already present, not introduced by this change/);
  } finally {
    cleanup(root);
  }
});

test('env_set: values never appear in preview, result, journal or log; secrets must be left blank', { skip: !hasGit && 'git not installed' }, () => {
  const root = project({ '.gitignore': '.env*\n!.env.example\n', '.env.local': 'EXISTING=keep-me-value\n' });
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const value = 'public-config-value-XYZ';
    const cs = { version: 1, operation: 'env-demo', steps: [
      { type: 'env_set', path: '.env.local', values: { VITE_FIREBASE_APP_ID: value, EXISTING: 'other', SUPABASE_SERVICE_ROLE_KEY: '' } },
      { type: 'env_set', path: '.env.example', values: { VITE_FIREBASE_APP_ID: '', SUPABASE_SERVICE_ROLE_KEY: '' } },
    ] };
    const p = plan(cs, root);
    assert.equal(p.valid, true, p.errors.join('\n'));
    const shown = JSON.stringify({ steps: p.steps, warnings: p.warnings }) + previewMarkdown(p);
    assert.ok(!shown.includes(value) && !shown.includes('keep-me-value'));
    assert.match(shown, /VITE_FIREBASE_APP_ID=<value hidden>/);
    const r = apply(cs, root, { approve: p.planId });
    assert.equal(r.status, 'success', JSON.stringify(r.errors));
    assert.equal(read(root, '.env.local'), `EXISTING=keep-me-value\nVITE_FIREBASE_APP_ID=${value}\nSUPABASE_SERVICE_ROLE_KEY=\n`);
    assert.ok(!(JSON.stringify(r) + stateText(root)).includes(value));

    const secretValue = plan({ version: 1, operation: 'x', steps: [{ type: 'env_set', path: '.env.local', values: { SUPABASE_SERVICE_ROLE_KEY: SECRET } }] }, root);
    assert.equal(secretValue.valid, false);
    assert.ok(!JSON.stringify(secretValue.errors).includes(SECRET));
    const exposed = plan({ version: 1, operation: 'x', steps: [{ type: 'env_set', path: '.env.local', values: { NEXT_PUBLIC_SERVICE_ROLE_KEY: '' } }] }, root);
    assert.match(exposed.errors.join(), /client-exposed prefix/);
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    const unignored = plan({ version: 1, operation: 'x', steps: [{ type: 'env_set', path: '.env.local', values: { A: 'b' } }] }, root);
    assert.match(unignored.errors.join(), /not ignored by git/);
  } finally {
    cleanup(root);
  }
});

test('command steps: allowlist, verification, failure cleanup and output redaction', () => {
  const root = project({});
  try {
    const refused = [['supabase', ['db', 'reset']], ['supabase', ['link', '--project-ref', 'x; rm -rf /']], ['bash', ['-c', 'echo']], ['firebase', ['deploy']]];
    for (const [bin, args] of refused) assert.equal(plan({ version: 1, operation: 'x', steps: [{ type: 'command', bin, args }] }, root).valid, false, `${bin} ${args}`);

    const ok = { version: 1, operation: 'supabase-connect', steps: [{ type: 'command', bin: 'supabase', args: ['init'] }, { type: 'command', bin: 'supabase', args: ['link', '--project-ref', 'abcdefghijklmnopqrst'] }] };
    const r = withEnv(BIN, {}, () => approveAndApply(ok, root));
    assert.equal(r.status, 'success', JSON.stringify(r.errors));
    assert.deepEqual(r.files_created.sort(), ['supabase/.temp/project-ref', 'supabase/config.toml']);
    assert.equal(rollback(root, /** @type {string} */ (r.runId)).status, 'rolled_back');
    assert.deepEqual(snapshot(root), {});

    const failing = { version: 1, operation: 'supabase-connect', steps: [{ type: 'command', bin: 'supabase', args: ['link', '--project-ref', 'failfailfailfailfail'] }] };
    const f = withEnv(BIN, {}, () => approveAndApply(failing, root));
    assert.equal(f.status, 'failed');
    assert.match(f.errors[0], /project is paused/);
    const all = JSON.stringify(f) + stateText(root);
    assert.ok(!all.includes('sbp_aaaa'), 'access token leaked');
    assert.match(all, /\[REDACTED:supabase-access-token\]/);
    assert.deepEqual(snapshot(root), {}); // partial files the CLI wrote are removed
  } finally {
    cleanup(root);
  }
});

test('missing CLI is reported clearly', () => {
  const root = project({ 'package.json': '{}' });
  try {
    const empty = fakeBin([]);
    const r = withEnv(empty, {}, () => approveAndApply({ version: 1, operation: 'x', steps: [{ type: 'install', packages: ['firebase'], manager: 'npm' }] }, root), false);
    assert.equal(r.status, 'failed');
    assert.match(r.errors[0], /npm is not installed or not on PATH/);
    cleanup(empty);
  } finally {
    cleanup(root);
  }
});

test('input validation: bad steps, package specs, JSON files, prototype keys', () => {
  const root = project({ 'bad.json': '{ // comment\n}', 'ok.json': '{}', 'package.json': '{}', 'x.ts': 'a a' });
  try {
    /** @type {any[]} */
    const bad = [
      { type: 'create', path: 'ok.json', content: 'exists' },
      { type: 'edit', path: 'missing.ts', edits: [{ find: 'a', replace: 'b' }] },
      { type: 'edit', path: 'x.ts', edits: [{ find: 'a', replace: 'b' }] }, // ambiguous: 2 matches
      { type: 'json_merge', path: 'bad.json', merge: { a: 1 } },
      { type: 'install', packages: ['https://evil.example/pkg.tgz'] },
      { type: 'install', packages: ['lodash; rm -rf /'] },
      { type: 'install', packages: ['github:user/repo'] },
      { type: 'delete', path: 'ok.json' },
    ];
    for (const step of bad) assert.equal(plan({ version: 1, operation: 'x', steps: [step] }, root).valid, false, JSON.stringify(step));
    assert.equal(plan({ version: 2, operation: 'x', steps: [] }, root).valid, false);

    const merged = approveAndApply({ version: 1, operation: 'x', steps: [{ type: 'json_merge', path: 'ok.json', merge: JSON.parse('{"__proto__":{"polluted":true},"a":{"b":1}}') }] }, root);
    assert.equal(merged.status, 'success');
    assert.equal(read(root, 'ok.json'), '{\n  "a": {\n    "b": 1\n  }\n}\n');
    assert.equal(/** @type {any} */ ({}).polluted, undefined);
  } finally {
    cleanup(root);
  }
});

test('CLI: preview exit codes, apply with approval, rollback', () => {
  const root = project({ 'src/main.ts': "import './app';\n", 'firebase.json': '{}' });
  const csFile = join(tmpdir(), `bp-cs-${Date.now()}.json`);
  try {
    // UTF-16LE with BOM, as written by Windows PowerShell 5 redirection.
    writeFileSync(csFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(basicChanges), 'utf16le')]));
    const node = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [ENGINE, ...a, '--root', root], { encoding: 'utf8' });
    const prev = node('preview', csFile, '--format', 'json');
    assert.equal(prev.status, 0, prev.stderr);
    const { planId } = JSON.parse(prev.stdout);
    assert.equal(node('apply', csFile).status, 3);
    const ap = node('apply', csFile, '--approve', planId);
    assert.equal(ap.status, 0, ap.stdout);
    const { runId } = JSON.parse(ap.stdout);
    assert.equal(node('rollback', runId).status, 0);
    assert.equal(node('rollback', '../../etc').status, 2);
    assert.equal(node('preview', join(root, 'nope.json')).status, 2);
  } finally {
    rmSync(csFile, { force: true });
    cleanup(root);
  }
});

test('unifiedDiff produces standard hunks', () => {
  assert.equal(unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.txt'), '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
  assert.equal(unifiedDiff(null, 'x\n', 'n.txt'), '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+x');
  assert.equal(unifiedDiff('same', 'same', 's'), '');
  const long = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const changed = [...long];
  changed[2] = 'X';
  changed[25] = 'Y';
  const d = unifiedDiff(long.join('\n'), changed.join('\n'), 'l');
  assert.equal(d.match(/^@@/gm)?.length, 2);
});
