#!/usr/bin/env node
// BackendPilot backend-detect scanner. Read-only: never writes, never runs project code, never outputs env values.
// Usage: node scan.mjs [projectRoot] [--format json|markdown]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, CREDENTIAL_FILES, IGNORED_DIRS, LOCKFILES, RULES, SCHEMA_FILES } from './rules.mjs';

export const VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;

const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|astro|dart)$/;
// Test code mocks and quotes SDK calls, so it is excluded from source signals to avoid false detections.
const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress)\/|\.(test|spec)\.[^/]+$/;
const ENV_FILE = /^\.env(\..+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/;
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_|VUE_APP_)/;
// FIREBASE_DATABASE_URL is the public Realtime Database URL, unlike a Postgres DATABASE_URL connection string.
const SECRET_NAME = /(SERVICE_ROLE|SECRET|PRIVATE_KEY|ADMIN|PASSWORD|(?<!FIREBASE_)DATABASE_URL|DB_URL)/;
// Minified bundles (build output copied into e.g. Capacitor's android/ folder) contain every SDK string; skip them.
const MINIFIED = /^.{5000,}$/m;
const BUILTIN_ENV = new Set(['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'CI', 'PORT', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL']);
const ENV_REF = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
];
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_EVIDENCE = 10;

/**
 * @typedef {{ type: 'dependency'|'file'|'source', detail: string, file: string }} Evidence
 * @typedef {{ severity: 'critical'|'high'|'warning'|'info', code: string, message: string, file?: string }} Finding
 * @typedef {{ id: string, name: string, provider?: string, confidence: 'high'|'medium', evidence: Evidence[] }} Detection
 */

/**
 * Scan a project directory and return a structured, secret-free report.
 * @param {string} rootArg
 * @param {{ maxFiles?: number, git?: boolean }} [opts]
 */
export function scan(rootArg, opts = {}) {
  const root = resolve(rootArg);
  const st = statSync(root, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new Error(`Not a directory: ${root}`);
  const maxFiles = opts.maxFiles ?? 20000;

  /** @type {Finding[]} */
  const findings = [];
  const { files, truncated } = walk(root, maxFiles);
  if (truncated) findings.push({ severity: 'warning', code: 'SCAN_TRUNCATED', message: `Stopped after ${maxFiles} files; results may be incomplete.` });

  /** @type {Map<string, Map<string, Evidence>>} rule id -> evidence keyed for dedupe */
  const hits = new Map();
  /** @param {string} id @param {Evidence} ev */
  const hit = (id, ev) => {
    if (!hits.has(id)) hits.set(id, new Map());
    const m = /** @type {Map<string, Evidence>} */ (hits.get(id));
    if (m.size < MAX_EVIDENCE) m.set(`${ev.type}|${ev.detail}|${ev.file}`, ev);
  };

  // 1. Manifests -> dependencies
  /** @type {{ name: string, file: string }[]} */
  const deps = [];
  const manifests = [];
  /** @type {Set<string>} */
  const declaredPm = new Set();
  for (const f of files) {
    const name = basename(f);
    if (name === 'package.json') {
      manifests.push(f);
      const pkg = readJson(root, f, findings);
      if (!pkg) continue;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const dep of Object.keys(pkg[field] ?? {})) deps.push({ name: dep, file: f });
      }
      if (typeof pkg.packageManager === 'string') declaredPm.add(pkg.packageManager.split('@')[0]);
    } else if (name === 'pubspec.yaml') {
      manifests.push(f);
      for (const dep of parsePubspecDeps(read(root, f))) deps.push({ name: `pub:${dep}`, file: f });
    }
  }

  // 2. Rules: dependency + file signals
  for (const rule of RULES) {
    for (const pattern of rule.deps ?? []) {
      for (const d of deps) if (depMatches(pattern, d.name)) hit(rule.id, { type: 'dependency', detail: d.name, file: d.file });
    }
    for (const re of rule.files ?? []) {
      for (const f of files) if (re.test(f)) hit(rule.id, { type: 'file', detail: basename(f), file: f });
    }
  }

  // 3. Source files: import signals + env references
  const sourceRules = RULES.filter((r) => r.source?.length);
  /** @type {Map<string, Set<string>>} env name -> files */
  const envRefs = new Map();
  let sourceFilesRead = 0;
  const hasTs = files.some((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith('.d.ts'));
  const hasJs = files.some((f) => /\.(js|jsx|mjs|cjs)$/.test(f) && !/(^|\/)[^/]+\.config\.[cm]?js$/.test(f));
  const hasDart = files.some((f) => f.endsWith('.dart'));
  for (const f of files) {
    if (!SOURCE_EXT.test(f) || TEST_FILE.test(f)) continue;
    const text = read(root, f, MAX_SOURCE_BYTES);
    if (text === null || MINIFIED.test(text)) continue;
    sourceFilesRead++;
    for (const rule of sourceRules) {
      for (const re of /** @type {RegExp[]} */ (rule.source)) {
        const m = re.exec(text);
        if (m) hit(rule.id, { type: 'source', detail: m[0].slice(0, 80), file: f });
      }
    }
    for (const re of ENV_REF) {
      for (const m of text.matchAll(re)) {
        if (!envRefs.has(m[1])) envRefs.set(m[1], new Set());
        /** @type {Set<string>} */ (envRefs.get(m[1])).add(f);
      }
    }
  }

  // 4. Assemble detections by category
  /** @type {Record<string, Detection[]>} */
  const detections = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  for (const rule of RULES) {
    const ev = hits.get(rule.id);
    if (!ev) continue;
    const evidence = [...ev.values()];
    const types = new Set(evidence.map((e) => e.type));
    detections[rule.category].push({
      id: rule.id,
      name: rule.name,
      ...(rule.provider && { provider: rule.provider }),
      confidence: types.size >= 2 ? 'high' : 'medium',
      evidence,
    });
  }
  // Overlapping detections (Next.js + React, Vite + React) are all kept; downstream skills decide what matters.

  // 5. Package manager
  const packageManagers = [];
  for (const f of files) {
    const pm = LOCKFILES[basename(f)];
    if (pm) packageManagers.push({ name: pm, evidence: f });
  }
  for (const pm of declaredPm) if (!packageManagers.some((p) => p.name === pm)) packageManagers.push({ name: pm, evidence: 'package.json#packageManager' });
  const jsManagers = new Set(packageManagers.map((p) => p.name).filter((n) => n !== 'pub'));
  if (jsManagers.size > 1) findings.push({ severity: 'warning', code: 'MULTIPLE_PACKAGE_MANAGERS', message: `Lockfiles for several package managers found (${[...jsManagers].join(', ')}). Pick one before installing SDKs.` });

  // 6. Environment files (key names only) + git status
  const git = opts.git === false ? null : gitInfo(root);
  const envFiles = files.filter((f) => ENV_FILE.test(basename(f)));
  const ignored = git ? gitIgnored(root, envFiles) : null;
  const tracked = git ? gitTracked(root, envFiles) : null;
  const env = envFiles.map((f) => {
    const template = ENV_TEMPLATE.test(f);
    const keys = parseEnvKeys(read(root, f, MAX_SOURCE_BYTES) ?? '');
    const entry = {
      path: f,
      template,
      keys,
      gitTracked: tracked ? tracked.has(f) : null,
      gitIgnored: ignored ? ignored.has(f) : null,
    };
    if (!template && entry.gitTracked) findings.push({ severity: 'critical', code: 'ENV_FILE_COMMITTED', message: 'Environment file is tracked by git. Remove it from the index and rotate any secrets it contained.', file: f });
    else if (!template && entry.gitIgnored === false) findings.push({ severity: 'high', code: 'ENV_FILE_NOT_IGNORED', message: 'Environment file is not covered by .gitignore.', file: f });
    for (const k of keys) {
      if (PUBLIC_PREFIX.test(k.name) && SECRET_NAME.test(k.name.replace(PUBLIC_PREFIX, ''))) {
        findings.push({ severity: 'critical', code: 'SECRET_EXPOSED_TO_CLIENT', message: `${k.name} uses a client-exposed prefix but its name suggests a secret. Bundlers inline these into browser code.`, file: f });
      }
    }
    return entry;
  });
  const defined = new Set(env.filter((e) => !e.template).flatMap((e) => e.keys.map((k) => k.name)));
  const documented = new Set(env.filter((e) => e.template).flatMap((e) => e.keys.map((k) => k.name)));
  const referenced = [...envRefs].map(([name, fs]) => ({ name, files: [...fs].slice(0, MAX_EVIDENCE) })).sort((a, b) => a.name.localeCompare(b.name));
  for (const r of referenced) {
    if (PUBLIC_PREFIX.test(r.name) && SECRET_NAME.test(r.name.replace(PUBLIC_PREFIX, '')) && !defined.has(r.name)) {
      findings.push({ severity: 'critical', code: 'SECRET_EXPOSED_TO_CLIENT', message: `${r.name} uses a client-exposed prefix but its name suggests a secret.`, file: r.files[0] });
    }
  }
  const missing = referenced.map((r) => r.name).filter((n) => !BUILTIN_ENV.has(n) && !defined.has(n));
  if (missing.length) findings.push({ severity: 'info', code: 'ENV_NOT_DEFINED_LOCALLY', message: `Referenced but not set in any local env file (may be set by the host): ${missing.join(', ')}` });

  // 7. Credential files
  for (const f of files) {
    if (!CREDENTIAL_FILES.some((re) => re.test(f))) continue;
    const isTracked = git ? gitTracked(root, [f]).has(f) : null;
    findings.push({
      severity: isTracked ? 'critical' : 'high',
      code: 'ADMIN_CREDENTIAL_FILE',
      message: isTracked ? 'Service-account credential file is tracked by git. Revoke the key in Google Cloud and remove it from history.' : 'Service-account credential file inside the project. Keep it out of git and out of client bundles.',
      file: f,
    });
  }

  // 8. Provider summaries
  const providers = {
    firebase: firebaseSummary(root, files, detections, findings),
    supabase: supabaseSummary(root, files, detections),
  };
  const backends = detections.backend;
  if (backends.length > 1) findings.push({ severity: 'warning', code: 'MULTIPLE_BACKENDS', message: `More than one backend platform detected (${backends.map((b) => b.id).join(', ')}). Confirm which one is intended before adding integrations.` });

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'backendpilot/backend-detect', version: VERSION },
    root,
    scannedAt: new Date().toISOString(),
    stats: { filesListed: files.length, sourceFilesRead, truncated },
    git: git ? { isRepo: true } : { isRepo: false },
    languages: [hasTs && 'typescript', hasJs && 'javascript', hasDart && 'dart'].filter(Boolean),
    packageManagers,
    manifests,
    detections,
    providers,
    env: { files: env, referenced, missing, documentedOnly: [...documented].filter((n) => !defined.has(n)).sort() },
    schemas: files.flatMap((f) => SCHEMA_FILES.filter((s) => s.pattern.test(f)).slice(0, 1).map((s) => ({ kind: s.kind, file: f }))),
    findings: findings.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity)),
  };
}

const SEVERITY = ['critical', 'high', 'warning', 'info'];

/** Iterative walk. Skips symlinks so the scan cannot leave the root. @param {string} root @param {number} maxFiles */
function walk(root, maxFiles) {
  /** @type {string[]} */
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip, don't abort the scan
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1)); // stack pops in ascending order -> deterministic output
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (files.length >= maxFiles) return { files: files.sort(), truncated: true };
        files.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  return { files: files.sort(), truncated: false };
}

/** @param {string} root @param {string} rel @param {number} [maxBytes] */
function read(root, rel, maxBytes = Infinity) {
  try {
    const full = join(root, rel);
    if (statSync(full).size > maxBytes) return null;
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} root @param {string} rel @param {Finding[]} findings */
function readJson(root, rel, findings) {
  const text = read(root, rel, MAX_SOURCE_BYTES);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    findings.push({ severity: 'warning', code: 'INVALID_JSON', message: 'File is not valid JSON and was skipped.', file: rel });
    return null;
  }
}

/** @param {string} pattern @param {string} name */
const depMatches = (pattern, name) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

/**
 * Top-level keys of `dependencies:` and `dev_dependencies:` in a pubspec.yaml.
 * shortcut: line-based, assumes standard 2-space indentation; switch to a YAML parser if real pubspecs break it.
 * @param {string|null} text
 */
export function parsePubspecDeps(text) {
  const out = [];
  let inDeps = false;
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (/^\S/.test(line)) inDeps = /^(dev_)?dependencies:\s*$/.test(line);
    else if (inDeps) {
      const m = /^ {2}([a-zA-Z0-9_]+):/.exec(line);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

/**
 * Key names from a dotenv file. Values are inspected only to report whether one is set; they are never returned.
 * @param {string} text
 */
export function parseEnvKeys(text) {
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/(^|\s+)#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    keys.push({ name: m[1], hasValue: value.length > 0 });
  }
  return keys;
}

// Git is invoked with fixed arguments and fsmonitor disabled, so a hostile repo config cannot run commands through it.
const GIT = ['-c', 'core.fsmonitor=false'];

/** @param {string} root */
function gitInfo(root) {
  try {
    execFileSync('git', [...GIT, 'rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return null;
  }
}

/** @param {string} root @param {string[]} paths @returns {Set<string>} */
function gitIgnored(root, paths) {
  if (!paths.length) return new Set();
  try {
    return lines(execFileSync('git', [...GIT, 'check-ignore', '--no-index', '--', ...paths], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    // exit 1 = none ignored; stdout still holds partial output on other errors
    return lines(/** @type {{ stdout?: Buffer }} */ (e).stdout);
  }
}

/** @param {string} root @param {string[]} paths @returns {Set<string>} */
function gitTracked(root, paths) {
  if (!paths.length) return new Set();
  try {
    return lines(execFileSync('git', [...GIT, 'ls-files', '--', ...paths], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return new Set();
  }
}

/** @param {Buffer|undefined} buf */
const lines = (buf) => new Set((buf?.toString('utf8') ?? '').split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean));

/** @param {Record<string, Detection[]>} detections @param {string} provider */
const servicesFor = (detections, provider) =>
  ['auth', 'database', 'storage', 'functions'].flatMap((c) => detections[c].filter((d) => d.provider === provider).map((d) => d.id));

/** @param {string} root @param {string[]} files @param {Record<string, Detection[]>} detections @param {Finding[]} findings */
function firebaseSummary(root, files, detections, findings) {
  const detected = detections.backend.some((d) => d.id === 'firebase');
  const configFiles = files.filter((f) => /(^|\/)(firebase\.json|\.firebaserc|firestore\.rules|firestore\.indexes\.json|storage\.rules|database\.rules\.json)$/.test(f));
  /** @type {string|null} */
  let projectId = null;
  const rc = files.find((f) => basename(f) === '.firebaserc');
  if (rc) projectId = readJson(root, rc, findings)?.projects?.default ?? null;
  /** @type {string[]} */
  let configured = [];
  const fj = files.find((f) => basename(f) === 'firebase.json');
  if (fj) configured = Object.keys(readJson(root, fj, findings) ?? {});
  const notes = [];
  if (detected && !fj) notes.push('No firebase.json: the Firebase CLI has not been initialised here. The app may still use a console-configured project.');
  if (detected && !projectId) notes.push('No default project in .firebaserc; project ID must come from app config or the user.');
  return { detected, projectId, configFiles, firebaseJsonKeys: configured, services: servicesFor(detections, 'firebase'), notes };
}

/** @param {string} root @param {string[]} files @param {Record<string, Detection[]>} detections */
function supabaseSummary(root, files, detections) {
  const detected = detections.backend.some((d) => d.id === 'supabase');
  const cfg = files.find((f) => /(^|\/)supabase\/config\.toml$/.test(f));
  const projectId = cfg ? (/^\s*project_id\s*=\s*"([^"]+)"/m.exec(read(root, cfg) ?? '')?.[1] ?? null) : null;
  const migrations = files.filter((f) => /(^|\/)supabase\/migrations\/[^/]+\.sql$/.test(f));
  const notes = [];
  if (detected && !cfg) notes.push('No supabase/config.toml: the Supabase CLI has not been initialised here. The app may still use a hosted project via URL + anon key.');
  return { detected, localProjectId: projectId, configFile: cfg ?? null, migrations: migrations.length, services: servicesFor(detections, 'supabase'), notes };
}

/** Human-readable summary of a report. @param {ReturnType<typeof scan>} r */
export function toMarkdown(r) {
  const out = [`# Backend detection report`, '', `Root: \`${r.root}\`  `, `Scanned ${r.stats.filesListed} files (${r.stats.sourceFilesRead} source)${r.stats.truncated ? ', TRUNCATED' : ''}.`, ''];
  out.push(`**Languages:** ${r.languages.join(', ') || 'none detected'}  `);
  out.push(`**Package manager:** ${r.packageManagers.map((p) => p.name).join(', ') || 'none detected'}`, '');
  for (const c of CATEGORIES) {
    const items = r.detections[c];
    if (!items.length) continue;
    out.push(`## ${c}`, '');
    for (const d of items) out.push(`- **${d.name}** (${d.confidence}): ${d.evidence.slice(0, 3).map((e) => `${e.type} \`${e.detail}\` in ${e.file}`).join('; ')}`);
    out.push('');
  }
  if (r.env.files.length || r.env.referenced.length) {
    out.push('## Environment', '');
    for (const f of r.env.files) out.push(`- \`${f.path}\`${f.template ? ' (template)' : ''}: ${f.keys.map((k) => k.name + (k.hasValue ? '' : ' (empty)')).join(', ') || 'no keys'}`);
    if (r.env.missing.length) out.push(`- Referenced in code but not set locally: ${r.env.missing.join(', ')}`);
    out.push('');
  }
  if (r.schemas.length) out.push('## Schemas', '', ...r.schemas.map((s) => `- ${s.kind}: \`${s.file}\``), '');
  out.push('## Findings', '');
  if (!r.findings.length) out.push('None.');
  for (const f of r.findings) out.push(`- **${f.severity.toUpperCase()}** \`${f.code}\`${f.file ? ` (${f.file})` : ''}: ${f.message}`);
  return out.join('\n') + '\n';
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let format = 'json';
  let root = '.';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') format = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node scan.mjs [projectRoot] [--format json|markdown]');
      process.exit(0);
    } else root = args[i];
  }
  if (format !== 'json' && format !== 'markdown') {
    console.error(`Unknown format "${format}". Use json or markdown.`);
    process.exit(2);
  }
  try {
    const report = scan(root);
    process.stdout.write(format === 'json' ? JSON.stringify(report, null, 2) + '\n' : toMarkdown(report));
  } catch (e) {
    console.error(`backend-detect: ${/** @type {Error} */ (e).message}`);
    process.exit(2);
  }
}
