// Behaviour of the fake CLIs. argv: <name> ...args. cwd = project dir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [name, ...args] = process.argv.slice(2);
const env = process.env;
const out = (/** @type {unknown} */ v) => process.stdout.write(JSON.stringify(v));

if (args[0] === '--version') {
  console.log(name === 'firebase' ? '15.0.0' : '2.100.0');
  process.exit(0);
}

if (name === 'firebase') {
  if (args[0] === 'projects:list') {
    if (env.FAKE_FIREBASE_LOGGED_IN !== '1') {
      out({ status: 'error', error: 'Failed to authenticate, have you run firebase login?' });
      process.exit(1);
    }
    out({ status: 'success', result: [{ projectId: 'demo-app-123', displayName: 'Demo App', projectNumber: '42' }] });
    process.exit(0);
  }
}

if (name === 'supabase') {
  if (args[0] === 'projects') {
    if (env.FAKE_SUPABASE_LOGGED_IN !== '1') {
      process.stderr.write('Access token not provided. Supply an access token by running supabase login');
      process.exit(1);
    }
    process.stderr.write('Cannot find project ref. Have you run supabase link?');
    out({ projects: [{ id: 'abcdefghijklmnopqrst', ref: 'abcdefghijklmnopqrst', name: 'Demo', region: 'eu-west-1', status: 'ACTIVE_HEALTHY', organization_slug: 'org' }] });
    process.exit(0);
  }
  if (args[0] === 'init') {
    mkdirSync('supabase', { recursive: true });
    writeFileSync(join('supabase', 'config.toml'), 'project_id = "demo"\n');
    process.exit(0);
  }
  if (args[0] === 'link') {
    const ref = args[args.indexOf('--project-ref') + 1];
    mkdirSync(join('supabase', '.temp'), { recursive: true });
    if (ref === 'failfailfailfailfail') {
      writeFileSync(join('supabase', '.temp', 'partial'), 'x');
      process.stderr.write(`project is paused. token=sbp_${'a'.repeat(40)}`);
      process.exit(1);
    }
    writeFileSync(join('supabase', '.temp', 'project-ref'), ref);
    process.exit(0);
  }
}

if (name === 'npm') {
  // npm install [--save-dev] pkg...
  const dev = args.includes('--save-dev');
  const pkgs = args.slice(1).filter((a) => !a.startsWith('-'));
  if (env.FAKE_NPM_FAIL === '1') {
    process.stderr.write('npm ERR! 404 Not Found');
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const field = dev ? 'devDependencies' : 'dependencies';
  pkg[field] = pkg[field] ?? {};
  for (const spec of pkgs) {
    const at = spec.lastIndexOf('@');
    const n = at > 0 ? spec.slice(0, at) : spec;
    pkg[field][n] = at > 0 ? spec.slice(at + 1) : '^1.0.0';
    if (env.FAKE_NPM_SKIP_MODULES !== '1') {
      mkdirSync(join('node_modules', ...n.split('/')), { recursive: true });
      writeFileSync(join('node_modules', ...n.split('/'), 'package.json'), JSON.stringify({ name: n, version: '1.0.0' }));
    }
  }
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3, existed: existsSync('package-lock.json') }));
  process.exit(0);
}

process.stderr.write(`fake ${name}: unsupported ${args.join(' ')}`);
process.exit(9);
