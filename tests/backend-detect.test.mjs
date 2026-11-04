import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, parseEnvKeys, parsePubspecDeps, toMarkdown } from '../skills/backend-detect/scripts/scan.mjs';

const SCANNER = fileURLToPath(new URL('../skills/backend-detect/scripts/scan.mjs', import.meta.url));

/** Fixtures are built in temp dirs so .env files and git state are real but never land in this repo. */
/** @param {Record<string, string>} files */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'bp-detect-'));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}
/** @param {string} root */
const cleanup = (root) => rmSync(root, { recursive: true, force: true });
/** @param {string} root @param {string[]} args */
const git = (root, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** @param {any} report @param {string} category */
const ids = (report, category) => report.detections[category].map((/** @type {{id: string}} */ d) => d.id);

const SECRET = 'sk_live_THIS_MUST_NEVER_APPEAR';

test('React + Vite + Firebase app: stack, services, env names, no secret values', () => {
  const root = project({
    'package.json': JSON.stringify({ dependencies: { react: '^18', 'react-dom': '^18', firebase: '^10', 'react-router-dom': '^6' }, devDependencies: { vite: '^5', typescript: '^5' } }),
    'package-lock.json': '{}',
    'vite.config.ts': 'export default {}',
    'firebase.json': JSON.stringify({ firestore: { rules: 'firestore.rules' }, storage: { rules: 'storage.rules' } }),
    '.firebaserc': JSON.stringify({ projects: { default: 'demo-app' } }),
    'firestore.rules': "rules_version = '2';",
    'storage.rules': "rules_version = '2';",
    'src/lib/firebase.ts': [
      "import { initializeApp } from 'firebase/app';",
      "import { getAuth, GoogleAuthProvider, signInWithEmailAndPassword } from 'firebase/auth';",
      "import { getFirestore } from 'firebase/firestore';",
      "import { getStorage } from 'firebase/storage';",
      'const app = initializeApp({ apiKey: import.meta.env.VITE_FIREBASE_API_KEY, projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID });',
    ].join('\n'),
    '.env.local': `VITE_FIREBASE_API_KEY=${SECRET}\n`,
    '.env.example': 'VITE_FIREBASE_API_KEY=\nVITE_FIREBASE_PROJECT_ID=\n',
  });
  try {
    const r = scan(root, { git: false });
    assert.deepEqual(ids(r, 'framework').sort(), ['react', 'vite']);
    assert.deepEqual(ids(r, 'backend'), ['firebase']);
    assert.equal(r.detections.backend[0].confidence, 'high');
    assert.ok(ids(r, 'auth').includes('firebase-auth'));
    assert.deepEqual(ids(r, 'authMethod').sort(), ['email-password', 'google']);
    assert.ok(ids(r, 'database').includes('firestore'));
    assert.ok(ids(r, 'storage').includes('firebase-storage'));
    assert.ok(ids(r, 'routing').includes('react-router'));
    assert.deepEqual(r.languages, ['typescript']);
    assert.deepEqual(r.packageManagers, [{ name: 'npm', evidence: 'package-lock.json' }]);
    assert.equal(r.providers.firebase.projectId, 'demo-app');
    assert.deepEqual(r.providers.firebase.firebaseJsonKeys, ['firestore', 'storage']);
    assert.deepEqual(r.env.missing, ['VITE_FIREBASE_PROJECT_ID']);
    assert.deepEqual(r.env.documentedOnly, ['VITE_FIREBASE_PROJECT_ID']);
    const local = r.env.files.find((f) => f.path === '.env.local');
    assert.deepEqual(local?.keys, [{ name: 'VITE_FIREBASE_API_KEY', hasValue: true }]);
    assert.equal(r.providers.supabase.detected, false);
    // Redaction: the secret value must not appear in either output format.
    assert.ok(!JSON.stringify(r).includes(SECRET));
    assert.ok(!toMarkdown(r).includes(SECRET));
  } finally {
    cleanup(root);
  }
});

test('Next.js + Supabase app: app router, RLS-relevant migrations, client-exposed secret is flagged', () => {
  const root = project({
    'package.json': JSON.stringify({ dependencies: { next: '14', react: '18', '@supabase/supabase-js': '^2', '@supabase/ssr': '^0.5' }, devDependencies: { supabase: '^1' } }),
    'pnpm-lock.yaml': '',
    'next.config.mjs': 'export default {}',
    'app/layout.tsx': 'export default function L(){}',
    'app/page.tsx': 'export default function P(){}',
    'lib/supabase.ts': [
      "import { createClient } from '@supabase/supabase-js';",
      'export const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);',
      "await sb.auth.signInWithOAuth({ provider: 'github' });",
      "await sb.from('profiles').select('*');",
      "await sb.storage.from('avatars').upload('a.png', f);",
    ].join('\n'),
    'supabase/config.toml': 'project_id = "local-proj"\n',
    'supabase/migrations/20240101000000_init.sql': 'create table profiles (id uuid primary key);',
    'supabase/functions/hello/index.ts': "Deno.serve(() => new Response('hi'))",
    '.env.local': `NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon\nNEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=${SECRET}\n`,
  });
  try {
    const r = scan(root, { git: false });
    assert.deepEqual(ids(r, 'framework').sort(), ['nextjs', 'react']);
    assert.deepEqual(ids(r, 'backend'), ['supabase']);
    assert.ok(ids(r, 'auth').includes('supabase-auth'));
    assert.ok(ids(r, 'authMethod').includes('github'));
    assert.ok(ids(r, 'database').includes('supabase-postgres'));
    assert.ok(ids(r, 'storage').includes('supabase-storage'));
    assert.ok(ids(r, 'functions').includes('supabase-edge-functions'));
    assert.ok(ids(r, 'routing').includes('next-app-router'));
    assert.equal(r.packageManagers[0].name, 'pnpm');
    assert.equal(r.providers.supabase.localProjectId, 'local-proj');
    assert.equal(r.providers.supabase.migrations, 1);
    assert.deepEqual(r.schemas, [{ kind: 'supabase-migration', file: 'supabase/migrations/20240101000000_init.sql' }]);
    const exposed = r.findings.filter((f) => f.code === 'SECRET_EXPOSED_TO_CLIENT');
    assert.equal(exposed.length, 1);
    assert.match(exposed[0].message, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/);
    assert.equal(r.findings[0].severity, 'critical');
    assert.ok(!JSON.stringify(r).includes(SECRET));
  } finally {
    cleanup(root);
  }
});

test('backend configured only in code is still detected (no config files)', () => {
  const root = project({ 'src/db.js': "const { initializeApp } = require('firebase-admin/app');" });
  try {
    const r = scan(root, { git: false });
    assert.deepEqual(ids(r, 'backend'), ['firebase']);
    assert.equal(r.detections.backend[0].confidence, 'medium');
    assert.ok(r.providers.firebase.notes.some((n) => n.includes('No firebase.json')));
  } finally {
    cleanup(root);
  }
});

test('Flutter project via pubspec.yaml', () => {
  const root = project({
    'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  firebase_core: ^2.0.0\n  firebase_auth: ^4.0.0\n  cloud_firestore: ^4.0.0\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
    'pubspec.lock': '',
    'lib/main.dart': "import 'package:firebase_core/firebase_core.dart';",
  });
  try {
    const r = scan(root, { git: false });
    assert.deepEqual(ids(r, 'framework'), ['flutter']);
    assert.deepEqual(ids(r, 'backend'), ['firebase']);
    assert.ok(ids(r, 'auth').includes('firebase-auth'));
    assert.ok(ids(r, 'database').includes('firestore'));
    assert.deepEqual(r.languages, ['dart']);
    assert.equal(r.packageManagers[0].name, 'pub');
  } finally {
    cleanup(root);
  }
});

test('ignored dirs, symlinks, malformed JSON and multiple backends/package managers', () => {
  const root = project({
    'package.json': '{ not json',
    'yarn.lock': '',
    'package-lock.json': '{}',
    'node_modules/firebase/package.json': JSON.stringify({ name: 'firebase' }),
    'node_modules/firebase/index.js': "import 'firebase/app';",
    'apps/web/package.json': JSON.stringify({ dependencies: { firebase: '1', '@supabase/supabase-js': '2' } }),
  });
  try {
    try {
      symlinkSync(join(root, 'node_modules'), join(root, 'link'), 'junction');
    } catch {
      /* symlinks may be unavailable; the rest of the test still applies */
    }
    const r = scan(root, { git: false });
    const codes = r.findings.map((f) => f.code);
    assert.ok(codes.includes('INVALID_JSON'));
    assert.ok(codes.includes('MULTIPLE_BACKENDS'));
    assert.ok(codes.includes('MULTIPLE_PACKAGE_MANAGERS'));
    for (const d of r.detections.backend) for (const e of d.evidence) assert.ok(!e.file.includes('node_modules') && !e.file.startsWith('link/'), e.file);
    assert.deepEqual(r.manifests, ['apps/web/package.json', 'package.json']);
  } finally {
    cleanup(root);
  }
});

test('test files are not used as source signals', () => {
  const root = project({
    'src/app.test.ts': "import { initializeApp } from 'firebase/app';",
    '__tests__/db.js': "require('@supabase/supabase-js');",
    'tests/e.ts': "import 'firebase/app';",
  });
  try {
    assert.deepEqual(ids(scan(root, { git: false }), 'backend'), []);
  } finally {
    cleanup(root);
  }
});

test('minified bundles are skipped; Firebase RTDB URL is not treated as a secret', () => {
  const root = project({
    'android/app/src/main/assets/public/assets/index-abc123.js': `var a=1;${'x'.repeat(6000)};require('firebase-admin');`,
    '.env.local': 'NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://x.firebaseio.com\nNEXT_PUBLIC_DATABASE_URL=postgres://u:p@h/db\n',
  });
  try {
    const r = scan(root, { git: false });
    assert.deepEqual(ids(r, 'backend'), []);
    const exposed = r.findings.filter((f) => f.code === 'SECRET_EXPOSED_TO_CLIENT').map((f) => f.message.split(' ')[0]);
    assert.deepEqual(exposed, ['NEXT_PUBLIC_DATABASE_URL']);
  } finally {
    cleanup(root);
  }
});

test('truncation is reported', () => {
  const root = project({ 'a.js': '', 'b.js': '', 'c.js': '' });
  try {
    const r = scan(root, { git: false, maxFiles: 2 });
    assert.equal(r.stats.truncated, true);
    assert.ok(r.findings.some((f) => f.code === 'SCAN_TRUNCATED'));
  } finally {
    cleanup(root);
  }
});

test('git: committed env file, unignored env file, tracked service account', { skip: !hasGit && 'git not installed' }, () => {
  const root = project({
    '.gitignore': 'node_modules\n',
    '.env': `SECRET_KEY=${SECRET}\n`,
    '.env.production': 'X=1\n',
    'firebase-adminsdk-abc.json': '{}',
  });
  try {
    git(root, 'init', '-q');
    git(root, 'add', '.env', 'firebase-adminsdk-abc.json', '.gitignore');
    git(root, 'commit', '-qm', 'init');
    const r = scan(root);
    assert.equal(r.git.isRepo, true);
    const by = (/** @type {string} */ code) => r.findings.filter((f) => f.code === code);
    assert.equal(by('ENV_FILE_COMMITTED')[0]?.file, '.env');
    assert.equal(by('ENV_FILE_NOT_IGNORED')[0]?.file, '.env.production');
    assert.equal(by('ADMIN_CREDENTIAL_FILE')[0]?.severity, 'critical');
    assert.ok(!JSON.stringify(r).includes(SECRET));
  } finally {
    cleanup(root);
  }
});

test('git: ignored env file is reported as ignored', { skip: !hasGit && 'git not installed' }, () => {
  const root = project({ '.gitignore': '.env*\n', '.env.local': 'A=1\n' });
  try {
    git(root, 'init', '-q');
    const r = scan(root);
    assert.deepEqual(r.env.files[0], { path: '.env.local', template: false, keys: [{ name: 'A', hasValue: true }], gitTracked: false, gitIgnored: true });
    assert.equal(r.findings.filter((f) => f.severity !== 'info').length, 0);
  } finally {
    cleanup(root);
  }
});

test('parseEnvKeys: names only, handles export/quotes/comments/empty', () => {
  assert.deepEqual(parseEnvKeys('# c\nexport A="x"\nB=\nC=  # just a comment\nD=\'\'\nnot a line\r\nE=v\r\n'), [
    { name: 'A', hasValue: true },
    { name: 'B', hasValue: false },
    { name: 'C', hasValue: false },
    { name: 'D', hasValue: false },
    { name: 'E', hasValue: true },
  ]);
});

test('parsePubspecDeps: only top-level deps of dependency sections', () => {
  assert.deepEqual(parsePubspecDeps('name: x\ndependencies:\n  a: 1\n  b:\n    sdk: flutter\nflutter:\n  uses-material-design: true\ndev_dependencies:\n  c: 1\n'), ['a', 'b', 'c']);
});

test('CLI: json and markdown output, bad path exits 2', () => {
  const root = project({ 'package.json': JSON.stringify({ dependencies: { express: '4' } }) });
  try {
    const json = JSON.parse(execFileSync(process.execPath, [SCANNER, root], { encoding: 'utf8' }));
    assert.deepEqual(ids(json, 'runtime').sort(), ['express', 'nodejs']);
    const md = execFileSync(process.execPath, [SCANNER, root, '--format', 'markdown'], { encoding: 'utf8' });
    assert.match(md, /# Backend detection report/);
    assert.match(md, /Express/);
    assert.throws(() => execFileSync(process.execPath, [SCANNER, join(root, 'nope')], { stdio: 'pipe' }), (/** @type {any} */ e) => e.status === 2);
  } finally {
    cleanup(root);
  }
});
