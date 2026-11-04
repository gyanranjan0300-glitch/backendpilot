#!/usr/bin/env node
// BackendPilot execution engine: preview → approve → apply (with backups + journal) → verify → rollback.
// Usage:
//   node engine.mjs preview <changes.json> [--root <dir>] [--format markdown|json]
//   node engine.mjs apply   <changes.json> --approve <planId> [--root <dir>]
//   node engine.mjs rollback <runId> [--root <dir>] [--force]
//   node engine.mjs runs [--root <dir>]

import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContent, ENV_TEMPLATE, isEnvFile, resolveSafe } from './checks.mjs';
import { unifiedDiff } from './diff.mjs';
import { run, tail } from './shared/exec.mjs';
import { isClientExposedSecret, isSecretName, redact } from './shared/security.mjs';

export const ENGINE_VERSION = '0.2.0';
const STATE_DIR = '.backendpilot';
const PKG_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.^~*+-]+)?$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCKFILES = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock' };
const INSTALL_ARGS = { npm: ['install'], pnpm: ['add'], yarn: ['add'], bun: ['add'] };
const DEV_FLAG = { npm: '--save-dev', pnpm: '-D', yarn: '-D', bun: '-d' };

/**
 * CLI commands a change set may run. Anything else is refused.
 * `snapshot`: paths backed up before the command and restored on rollback (the CLI writes there).
 * @type {Record<string, Record<string, { snapshot: string[], argsRe: RegExp[], verify?: (root: string, args: string[]) => string|null }>>}
 */
const COMMANDS = {
  supabase: {
    init: { snapshot: ['supabase'], argsRe: [], verify: (root) => (existsSync(join(root, 'supabase', 'config.toml')) ? null : 'supabase/config.toml was not created') },
    link: {
      snapshot: ['supabase/.temp'],
      argsRe: [/^--project-ref$/, /^[a-z0-9]{20}$/],
      verify: (root, args) => {
        const ref = args[args.indexOf('--project-ref') + 1];
        const dir = join(root, 'supabase', '.temp');
        const files = existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)).filter((f) => statSync(f).isFile()) : [];
        // shortcut: CLI versions store the ref in project-ref or linked-project.json; checking for the ref string covers both.
        return files.some((f) => readFileSync(f, 'utf8').includes(ref)) ? null : `supabase/.temp does not record project ${ref}`;
      },
    },
  },
};

/**
 * @typedef {{ rel: string, existed: boolean, beforeHash: string|null, backup: string|null, expectedHash?: string|null, afterHash?: string|null }} FileRecord
 * @typedef {{ index: number, type: string, summary: string, status: 'pending'|'applying'|'applied'|'failed'|'rolled_back'|'rollback_conflict', files: FileRecord[], createdDirs: string[], error?: string, verification?: string, reversible: boolean }} StepRecord
 */

// ---------- change set validation & planning ----------

/**
 * Validate a change set and compute what each step will do, without writing anything.
 * @param {any} cs parsed change set
 * @param {string} rootArg
 */
export function plan(cs, rootArg) {
  const root = resolve(rootArg);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new InputError(`Not a directory: ${root}`);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {any[]} */
  const steps = [];
  /** @type {Set<string>} env values: removed from every output */
  const secrets = new Set();

  if (!cs || typeof cs !== 'object' || Array.isArray(cs)) throw new InputError('Change set must be a JSON object.');
  if (cs.version !== 1) errors.push('version must be 1');
  if (typeof cs.operation !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(cs.operation)) errors.push('operation must be a lowercase id like "firebase-connect"');
  if (!Array.isArray(cs.steps) || !cs.steps.length) errors.push('steps must be a non-empty array');

  // Simulated file contents so later steps see earlier steps' output.
  /** @type {Map<string, string|null>} */
  const sim = new Map();
  const current = (/** @type {string} */ abs) => (sim.has(abs) ? /** @type {string|null} */ (sim.get(abs)) : readOrNull(abs));
  const git = gitRoot(root);

  for (const [i, step] of (Array.isArray(cs.steps) ? cs.steps : []).entries()) {
    const where = `step ${i + 1} (${step?.type ?? '?'})`;
    try {
      const s = planStep(step, root, current, git, secrets, warnings);
      for (const [abs, after] of s.writes ?? []) {
        const before = current(abs);
        const rel = toRel(root, abs);
        const c = checkContent(rel, after, before);
        errors.push(...c.errors.map((e) => `${where}: ${e}`));
        warnings.push(...c.warnings.map((w) => `${where}: ${w}`));
        s.diffs.push(isEnvFile(rel) ? envDiff(before, after, rel) : unifiedDiff(before, after, rel));
        sim.set(abs, after);
      }
      steps.push({ index: i, ...s });
    } catch (e) {
      if (e instanceof InputError) errors.push(`${where}: ${e.message}`);
      else throw e;
    }
  }

  // Plan id binds the approval to this exact change set AND the current state of every file it touches.
  const h = createHash('sha256').update(ENGINE_VERSION).update('\0').update(root).update('\0').update(canonical(cs));
  for (const s of steps) for (const rel of s.touches) h.update('\0' + rel + '=' + (hashFile(join(root, ...rel.split('/'))) ?? 'absent'));
  const planId = h.digest('hex').slice(0, 16);

  return {
    planId,
    root,
    operation: typeof cs.operation === 'string' ? cs.operation : null,
    description: typeof cs.description === 'string' ? redact(cs.description, secrets) : '',
    valid: errors.length === 0,
    errors: errors.map((e) => redact(e, secrets)),
    warnings: warnings.map((w) => redact(w, secrets)),
    steps: steps.map((s) => ({ index: s.index, type: s.type, summary: redact(s.summary, secrets), touches: s.touches, reversible: s.reversible, diff: redact(s.diffs.join('\n'), secrets) })),
    /** @internal used by apply; never serialised */
    _steps: steps,
    _secrets: secrets,
  };
}

/**
 * @param {any} step
 * @param {string} root
 * @param {(abs: string) => string|null} current
 * @param {string|null} git
 * @param {Set<string>} secrets
 * @param {string[]} warnings
 * @returns {any} planned step (shape depends on type)
 */
function planStep(step, root, current, git, secrets, warnings) {
  if (!step || typeof step !== 'object') throw new InputError('step must be an object');
  const base = { type: step.type, diffs: /** @type {string[]} */ ([]), reversible: true };
  const safe = (/** @type {unknown} */ p) => {
    try {
      return resolveSafe(root, p);
    } catch (e) {
      throw new InputError(/** @type {Error} */ (e).message);
    }
  };

  switch (step.type) {
    case 'create': {
      const { abs, rel } = safe(step.path);
      if (typeof step.content !== 'string') throw new InputError('content must be a string');
      if (current(abs) !== null) throw new InputError(`${rel} already exists; use "edit" or "json_merge" to change it`);
      return { ...base, summary: `create ${rel}`, touches: [rel], writes: [[abs, step.content]] };
    }

    case 'edit': {
      const { abs, rel } = safe(step.path);
      let text = current(abs);
      if (text === null) throw new InputError(`${rel} does not exist`);
      if (!Array.isArray(step.edits) || !step.edits.length) throw new InputError('edits must be a non-empty array of { find, replace }');
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      for (const [k, e] of step.edits.entries()) {
        if (typeof e?.find !== 'string' || !e.find || typeof e.replace !== 'string') throw new InputError(`edit ${k + 1}: find (non-empty) and replace must be strings`);
        const find = toEol(e.find, eol);
        const count = text.split(find).length - 1;
        if (count !== 1) throw new InputError(`edit ${k + 1}: "find" text must occur exactly once in ${rel}, found ${count}`);
        text = text.replace(find, () => toEol(e.replace, eol));
      }
      return { ...base, summary: `edit ${rel} (${step.edits.length} change${step.edits.length > 1 ? 's' : ''})`, touches: [rel], writes: [[abs, text]] };
    }

    case 'json_merge': {
      const { abs, rel } = safe(step.path);
      if (!isPlainObject(step.merge)) throw new InputError('merge must be an object');
      const before = current(abs);
      let obj = {};
      let indent = 2, eol = '\n', bom = '';
      if (before !== null) {
        bom = before.startsWith('\uFEFF') ? '\uFEFF' : '';
        try {
          obj = JSON.parse(before.slice(bom.length));
        } catch {
          throw new InputError(`${rel} is not plain JSON (comments or syntax error); edit it with "edit" instead`);
        }
        if (!isPlainObject(obj)) throw new InputError(`${rel} does not contain a JSON object`);
        indent = /^\t/m.test(before) ? /** @type {any} */ ('\t') : (/^( +)"/m.exec(before)?.[1].length ?? 2);
        eol = before.includes('\r\n') ? '\r\n' : '\n';
      } else if (step.create === false) throw new InputError(`${rel} does not exist and create is false`);
      const after = bom + toEol(JSON.stringify(deepMerge(obj, step.merge), null, indent), eol) + eol;
      return { ...base, summary: `${before === null ? 'create' : 'update'} ${rel} (JSON merge)`, touches: [rel], writes: [[abs, after]], merge: step.merge };
    }

    case 'env_set': {
      const { abs, rel } = safe(step.path);
      if (!isEnvFile(rel)) throw new InputError(`${rel} is not a .env file`);
      if (!isPlainObject(step.values) || !Object.keys(step.values).length) throw new InputError('values must be a non-empty object');
      const template = ENV_TEMPLATE.test(rel);
      if (!template && git && !gitIgnored(git, abs)) throw new InputError(`${rel} is not ignored by git. Add it to .gitignore first (an "edit" or "create" step on .gitignore).`);
      if (!template && !git) warnings.push(`${rel}: not a git repository, so gitignore coverage could not be checked.`);
      const before = current(abs) ?? '';
      const existing = new Set([...before.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]));
      const eol = before.includes('\r\n') ? '\r\n' : '\n';
      const added = [];
      const skipped = [];
      let after = before;
      for (const [key, value] of Object.entries(step.values)) {
        if (!ENV_KEY.test(key)) throw new InputError(`invalid env var name: ${key}`);
        if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new InputError(`${key}: value must be a single-line string`);
        if (isClientExposedSecret(key)) throw new InputError(`${key}: secret-looking name with a client-exposed prefix would be bundled into browser code`);
        if (isSecretName(key) && value !== '') throw new InputError(`${key}: secret values are never written by the agent. Set it to "" and let the user fill it in.`);
        if (template && value !== '') throw new InputError(`${key}: template files (${rel}) must not contain values`);
        if (value) secrets.add(value);
        if (existing.has(key)) {
          skipped.push(key);
          continue;
        }
        if (after && !after.endsWith('\n')) after += eol;
        after += `${key}=${/[\s#"'$]/.test(value) ? JSON.stringify(value) : value}${eol}`;
        added.push(key);
      }
      if (skipped.length) warnings.push(`${rel}: already defines ${skipped.join(', ')}; existing values are kept.`);
      const writes = added.length ? [[abs, after]] : [];
      return { ...base, summary: `env ${rel}: add ${added.join(', ') || 'nothing'}`, touches: [rel], writes, envKeys: added };
    }

    case 'install': {
      if (!Array.isArray(step.packages) || !step.packages.length) throw new InputError('packages must be a non-empty array');
      for (const p of step.packages) if (typeof p !== 'string' || !PKG_SPEC.test(p)) throw new InputError(`invalid package spec ${JSON.stringify(p)} (registry names with optional version only; no URLs, paths or git refs)`);
      const dir = typeof step.cwd === 'string' ? safeDir(root, step.cwd) : { abs: root, rel: '.' };
      const pkgRel = dir.rel === '.' ? 'package.json' : `${dir.rel}/package.json`;
      if (!existsSync(join(dir.abs, 'package.json'))) throw new InputError(`${pkgRel} not found`);
      const manager = step.manager ?? detectManager(dir.abs);
      if (!(manager in INSTALL_ARGS)) throw new InputError(`unknown package manager ${manager}`);
      const prefix = dir.rel === '.' ? '' : dir.rel + '/';
      const touches = [pkgRel, ...['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].map((f) => prefix + f)];
      const args = [...INSTALL_ARGS[/** @type {keyof typeof INSTALL_ARGS} */ (manager)], ...(step.dev ? [DEV_FLAG[/** @type {keyof typeof DEV_FLAG} */ (manager)]] : []), ...step.packages];
      warnings.push(`install: rollback restores ${pkgRel} and the lockfile; it does not remove files from node_modules. Run "${manager} install" afterwards to resync.`);
      return { ...base, summary: `${manager} ${args.join(' ')}${dir.rel === '.' ? '' : ` (in ${dir.rel})`}`, touches, bin: manager, args, cwd: dir.abs, packages: step.packages, dev: !!step.dev };
    }

    case 'command': {
      const spec = COMMANDS[step.bin]?.[step.args?.[0]];
      if (!spec) throw new InputError(`command not allowed: ${[step.bin, ...(step.args ?? [])].join(' ')}. Allowed: ${Object.entries(COMMANDS).flatMap(([b, c]) => Object.keys(c).map((s) => `${b} ${s}`)).join(', ')}`);
      const rest = step.args.slice(1);
      if (rest.length !== spec.argsRe.length || rest.some((/** @type {unknown} */ a, /** @type {number} */ k) => typeof a !== 'string' || !spec.argsRe[k].test(a))) throw new InputError(`invalid arguments for ${step.bin} ${step.args[0]}`);
      const touches = spec.snapshot.flatMap((p) => listFiles(root, p));
      return { ...base, summary: `run ${step.bin} ${step.args.join(' ')}`, touches, snapshot: spec.snapshot, bin: step.bin, args: step.args, cwd: root, verify: spec.verify };
    }

    default:
      throw new InputError(`unknown step type ${JSON.stringify(step.type)}. Supported: create, edit, json_merge, env_set, install, command`);
  }
}

// ---------- apply ----------

/**
 * Apply an approved change set. Never throws for operational failures; returns an ExecutionResult.
 * @param {any} cs
 * @param {string} rootArg
 * @param {{ approve?: string, onStep?: (index: number, phase: 'before'|'after') => void }} [opts]
 * @returns {{ operation: string, planId: string, status: 'success'|'failed'|'rejected'|'needs_approval', verified: boolean, runId: string|null, errors: string[], warnings: string[], files_created: string[], files_modified: string[], requires_manual_action: boolean, manual_actions: string[], rolled_back?: boolean, rollback?: string }}
 */
export function apply(cs, rootArg, opts = {}) {
  const p = plan(cs, rootArg);
  const base = { operation: p.operation ?? 'unknown', planId: p.planId, files_created: /** @type {string[]} */ ([]), files_modified: /** @type {string[]} */ ([]), warnings: p.warnings, requires_manual_action: false, manual_actions: /** @type {string[]} */ ([]) };
  if (!p.valid) return { ...base, status: 'rejected', verified: false, errors: p.errors, runId: null };
  if (opts.approve !== p.planId) {
    return { ...base, status: 'needs_approval', verified: false, runId: null, errors: [opts.approve ? `Approval ${opts.approve} does not match plan ${p.planId}. The change set or the files it touches changed since preview; preview again.` : `Not approved. Show the preview to the user, then pass --approve ${p.planId}.`] };
  }

  const root = p.root;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const runDir = join(ensureStateDir(root), 'runs', runId);
  mkdirSync(join(runDir, 'backups'), { recursive: true });
  const log = (/** @type {string} */ msg) => appendLog(runDir, redact(msg, p._secrets));
  /** @type {StepRecord[]} */
  const records = p._steps.map((s) => ({ index: s.index, type: s.type, summary: redact(s.summary, p._secrets), status: 'pending', files: [], createdDirs: [], reversible: s.reversible }));
  const journal = { engine: ENGINE_VERSION, runId, operation: p.operation, planId: p.planId, root, status: 'running', startedAt: new Date().toISOString(), finishedAt: /** @type {string|null} */ (null), steps: records };
  const save = () => writeAtomic(join(runDir, 'journal.json'), JSON.stringify(journal, null, 2));
  save();
  log(`apply ${p.operation} plan=${p.planId}`);

  let backupN = 0;
  /** Back up a file before touching it; journal is saved before the caller writes. @param {StepRecord} rec @param {string} rel @param {string|null} expected */
  const record = (rec, rel, expected) => {
    if (rec.files.some((f) => f.rel === rel)) return;
    const abs = join(root, ...rel.split('/'));
    const existed = existsSync(abs);
    let backup = null;
    if (existed) {
      backup = `backups/${++backupN}-${basename(rel)}`;
      copyFileSync(abs, join(runDir, ...backup.split('/')));
    }
    rec.files.push({ rel, existed, beforeHash: existed ? hashFile(abs) : null, backup, expectedHash: expected });
  };

  for (const [k, s] of p._steps.entries()) {
    const rec = records[k];
    try {
      opts.onStep?.(k, 'before');
      rec.status = 'applying';
      if (s.writes) {
        for (const [abs, after] of s.writes) {
          const rel = toRel(root, abs);
          record(rec, rel, sha(after));
          rec.createdDirs.push(...missingDirs(root, dirname(abs)));
        }
        save();
        for (const [abs, after] of s.writes) {
          mkdirSync(dirname(abs), { recursive: true });
          writeAtomic(abs, after);
        }
      } else {
        for (const rel of s.touches) record(rec, rel, null);
        // Snapshot dirs that did not exist are recorded with a trailing "/" so rollback removes them if left empty.
        for (const d of s.snapshot ?? []) for (const md of missingDirs(root, join(root, ...d.split('/')))) rec.files.push({ rel: md + '/', existed: false, beforeHash: null, backup: null });
        save();
        log(`run ${s.bin} ${s.args.join(' ')}`);
        const r = run(s.bin, s.args, { cwd: s.cwd, timeoutMs: s.type === 'install' ? 600_000 : 180_000 });
        log(`exit ${r.code}${r.error ? ' ' + r.error : ''}\n${tail(r.stdout, p._secrets)}\n${tail(r.stderr, p._secrets)}`);
        // Files the command created under its snapshot dirs (even if it then failed), so rollback can remove them.
        for (const d of s.snapshot ?? []) for (const rel of listFiles(root, d)) if (!rec.files.some((f) => f.rel === rel)) rec.files.push({ rel, existed: false, beforeHash: null, backup: null });
        save();
        if (!r.ok) throw new StepError(r.error === 'not_found' ? `${s.bin} is not installed or not on PATH` : r.error === 'timeout' ? `${s.bin} timed out` : `${s.bin} exited with code ${r.code}: ${tail(r.stderr || r.stdout, p._secrets, 500)}`);
      }
      const problem = verifyStep(s, root);
      if (problem) throw new StepError(`verification failed: ${problem}`);
      for (const f of rec.files) if (!f.rel.endsWith('/')) f.afterHash = hashFile(join(root, ...f.rel.split('/')));
      rec.status = 'applied';
      rec.verification = 'passed';
      save();
      log(`step ${k + 1} applied and verified: ${rec.summary}`);
      opts.onStep?.(k, 'after');
    } catch (e) {
      rec.status = 'failed';
      rec.error = redact(/** @type {Error} */ (e).message, p._secrets);
      save();
      log(`step ${k + 1} failed: ${rec.error}`);
      const rb = rollbackRecords(root, runDir, records, { force: false, log });
      journal.status = rb.conflicts.length ? 'rollback_incomplete' : 'rolled_back';
      journal.finishedAt = new Date().toISOString();
      save();
      return { ...base, status: 'failed', verified: false, runId, errors: [`Step ${k + 1} (${rec.summary}) failed: ${rec.error}`, ...rb.conflicts], rolled_back: rb.conflicts.length === 0, files_created: [], files_modified: [] };
    }
  }

  journal.status = 'applied';
  journal.finishedAt = new Date().toISOString();
  save();
  log('all steps applied and verified');
  const files = records.flatMap((r) => r.files).filter((f) => !f.rel.endsWith('/') && f.afterHash !== f.beforeHash);
  return {
    ...base,
    status: 'success',
    verified: true,
    runId,
    errors: [],
    files_created: [...new Set(files.filter((f) => !f.existed && f.afterHash).map((f) => f.rel))],
    files_modified: [...new Set(files.filter((f) => f.existed).map((f) => f.rel))],
    rollback: `node engine.mjs rollback ${runId}`,
  };
}

/** Check the step's effect actually happened. Returns a problem string or null. @param {any} s @param {string} root */
function verifyStep(s, root) {
  if (s.writes) {
    for (const [abs, after] of s.writes) if (hashFile(abs) !== sha(after)) return `${toRel(root, abs)} does not have the expected content`;
    if (s.merge) {
      const [[abs]] = s.writes;
      const got = JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
      if (!contains(got, s.merge)) return `${toRel(root, abs)} is missing merged keys`;
    }
    return null;
  }
  if (s.type === 'install') {
    const pkg = JSON.parse(readFileSync(join(s.cwd, 'package.json'), 'utf8'));
    const pnp = existsSync(join(s.cwd, '.pnp.cjs'));
    for (const spec of s.packages) {
      const name = spec.replace(/(?!^)@.*$/, '');
      const listed = (s.dev ? pkg.devDependencies : pkg.dependencies)?.[name];
      if (!listed) return `${name} is not listed in package.json ${s.dev ? 'devDependencies' : 'dependencies'}`;
      if (!pnp && !existsSync(join(s.cwd, 'node_modules', ...name.split('/'), 'package.json'))) return `${name} is not present in node_modules`;
    }
    return null;
  }
  return s.verify ? s.verify(root, s.args) : null;
}

// ---------- rollback ----------

/**
 * Roll back a run using its journal. Files changed by someone else since the run are left alone unless force.
 * @param {string} rootArg @param {string} runId @param {{ force?: boolean }} [opts]
 */
export function rollback(rootArg, runId, opts = {}) {
  const root = resolve(rootArg);
  if (!/^[\w-]+$/.test(runId)) throw new InputError('invalid run id');
  const runDir = join(root, STATE_DIR, 'runs', runId);
  const jf = join(runDir, 'journal.json');
  if (!existsSync(jf)) throw new InputError(`run ${runId} not found in ${STATE_DIR}/runs`);
  const journal = JSON.parse(readFileSync(jf, 'utf8'));
  if (journal.status === 'rolled_back') return { runId, status: 'rolled_back', restored: [], conflicts: [], note: 'already rolled back' };
  const log = (/** @type {string} */ m) => appendLog(runDir, m);
  log(`rollback requested${opts.force ? ' (force)' : ''}`);
  const rb = rollbackRecords(root, runDir, journal.steps, { force: !!opts.force, log });
  journal.status = rb.conflicts.length ? 'rollback_incomplete' : 'rolled_back';
  journal.rolledBackAt = new Date().toISOString();
  writeAtomic(jf, JSON.stringify(journal, null, 2));
  return { runId, status: journal.status, restored: rb.restored, conflicts: rb.conflicts };
}

/**
 * @param {string} root @param {string} runDir @param {StepRecord[]} steps
 * @param {{ force: boolean, log: (m: string) => void }} opts
 */
function rollbackRecords(root, runDir, steps, { force, log }) {
  const restored = [];
  const conflicts = [];
  for (const rec of [...steps].reverse()) {
    if (!['applying', 'applied', 'failed', 'rollback_conflict'].includes(rec.status)) continue;
    let conflict = false;
    for (const f of [...rec.files].reverse()) {
      if (f.rel.endsWith('/')) continue;
      const abs = join(root, ...f.rel.split('/'));
      const now = hashFile(abs);
      if (now === f.beforeHash) continue; // already in original state (e.g. step interrupted before writing)
      const ours = f.afterHash ?? f.expectedHash;
      // Unknown after-state (interrupted tool step) is restored; a known after-state that changed means a user edit.
      if (ours && now !== ours && !force) {
        conflicts.push(`${f.rel} changed after BackendPilot wrote it; not restored (use --force to overwrite).`);
        conflict = true;
        continue;
      }
      if (f.existed && f.backup) {
        mkdirSync(dirname(abs), { recursive: true });
        writeAtomic(abs, readFileSync(join(runDir, ...f.backup.split('/'))));
      } else if (now !== null) unlinkSync(abs);
      if (hashFile(abs) !== f.beforeHash) conflicts.push(`${f.rel}: restore did not reproduce the original file.`);
      else restored.push(f.rel);
      log(`restored ${f.rel}`);
    }
    for (const d of [...rec.createdDirs].reverse()) removeIfEmpty(join(root, ...d.split('/')));
    for (const f of rec.files) if (f.rel.endsWith('/') && !f.existed) removeTreeIfEmpty(join(root, ...f.rel.slice(0, -1).split('/')));
    rec.status = conflict ? 'rollback_conflict' : 'rolled_back';
  }
  return { restored, conflicts };
}

/** @param {string} rootArg */
export function listRuns(rootArg) {
  const dir = join(resolve(rootArg), STATE_DIR, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((id) => {
      try {
        const j = JSON.parse(readFileSync(join(dir, id, 'journal.json'), 'utf8'));
        return { runId: id, operation: j.operation, status: j.status, startedAt: j.startedAt, steps: j.steps.length };
      } catch {
        return { runId: id, operation: null, status: 'unreadable', startedAt: null, steps: 0 };
      }
    });
}

// ---------- helpers ----------

class InputError extends Error {}
class StepError extends Error {}

/** @param {string} root */
function ensureStateDir(root) {
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  // Backups can contain env values; keep the whole directory out of git.
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
  return dir;
}

/** Write via temp file + rename so a crash never leaves a half-written file. Retries transient Windows locks. @param {string} file @param {string|Buffer} data */
function writeAtomic(file, data) {
  const tmp = `${file}.bp-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
      else {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw e;
      }
    }
  }
}

/** @param {string} runDir @param {string} msg */
function appendLog(runDir, msg) {
  writeFileSync(join(runDir, 'log.txt'), `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' });
}

/** @param {string} abs */
function readOrNull(abs) {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
/** @param {string} abs */
function hashFile(abs) {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}
/** @param {string|Buffer} s */
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** @param {string} root @param {string} abs */
const toRel = (root, abs) => relative(root, abs).split(sep).join('/');
/** @param {string} s @param {string} eol */
const toEol = (s, eol) => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);
/** @param {unknown} v @returns {v is Record<string, any>} */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Objects merge recursively; arrays and scalars replace. @param {Record<string, any>} a @param {Record<string, any>} b */
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(v) && isPlainObject(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}
/** @param {any} got @param {any} want @returns {boolean} */
function contains(got, want) {
  if (isPlainObject(want)) return isPlainObject(got) && Object.entries(want).every(([k, v]) => k === '__proto__' || contains(got[k], v));
  return JSON.stringify(got) === JSON.stringify(want);
}
/** Stable JSON for hashing. @param {any} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Directories between root and dir that don't exist yet (deepest last). @param {string} root @param {string} dir */
function missingDirs(root, dir) {
  const out = [];
  for (let d = dir; d.length > root.length && !existsSync(d); d = dirname(d)) out.unshift(toRel(root, d));
  return out;
}
/** @param {string} dir */
function removeIfEmpty(dir) {
  try {
    if (!readdirSync(dir).length) rmdirSync(dir);
  } catch { /* already gone or not empty */ }
}
/** @param {string} dir */
function removeTreeIfEmpty(dir) {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeTreeIfEmpty(join(dir, e.name));
    removeIfEmpty(dir);
  } catch { /* gone */ }
}
/** Files under a root-relative path (file or directory). @param {string} root @param {string} rel @returns {string[]} */
function listFiles(root, rel) {
  const abs = join(root, ...rel.split('/'));
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) return [];
  if (st.isFile()) return [rel];
  return readdirSync(abs, { withFileTypes: true }).filter((e) => !e.isSymbolicLink()).flatMap((e) => (e.isDirectory() ? listFiles(root, `${rel}/${e.name}`) : e.isFile() ? [`${rel}/${e.name}`] : []));
}
/** @param {string} root @param {string} rel */
function safeDir(root, rel) {
  if (rel === '.' || rel === '') return { abs: root, rel: '.' };
  try {
    const r = resolveSafe(root, rel);
    if (!statSync(r.abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${rel} is not a directory`);
    return r;
  } catch (e) {
    throw new InputError(/** @type {Error} */ (e).message);
  }
}
/** @param {string} dir */
function detectManager(dir) {
  const found = Object.entries(LOCKFILES).filter(([, f]) => existsSync(join(dir, f))).map(([m]) => m);
  if (existsSync(join(dir, 'bun.lockb')) && !found.includes('bun')) found.push('bun');
  if (found.length > 1) throw new InputError(`several lockfiles found (${found.join(', ')}); set "manager" on the install step`);
  return found[0] ?? 'npm';
}
/** @param {string} root */
function gitRoot(root) {
  const r = run('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 15_000 });
  return r.ok ? root : null;
}
/** @param {string} root @param {string} abs */
function gitIgnored(root, abs) {
  return run('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '-q', '--no-index', '--', toRel(root, abs)], { cwd: root, timeoutMs: 15_000 }).ok;
}

/** Env diffs list keys only. @param {string|null} before @param {string} after @param {string} rel */
function envDiff(before, after, rel) {
  const keys = (/** @type {string|null} */ s) => new Set([...(s ?? '').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/gm)].map((m) => `${m[1]}=${m[2].trim() ? '<value hidden>' : ''}`));
  const a = keys(before);
  const added = [...keys(after)].filter((k) => !a.has(k));
  return [`--- ${before === null ? '/dev/null' : 'a/' + rel}`, `+++ b/${rel}`, '@@ values hidden @@', ...added.map((k) => '+' + k)].join('\n');
}

/** @param {ReturnType<typeof plan>} p */
export function previewMarkdown(p) {
  const out = [`# Change preview: ${p.operation ?? '(invalid)'}`, '', p.description, '', `Root: \`${p.root}\`  `, `Plan ID: \`${p.planId}\``, ''];
  if (p.errors.length) out.push('## Blocked', '', ...p.errors.map((e) => `- ${e}`), '');
  if (p.warnings.length) out.push('## Warnings', '', ...p.warnings.map((w) => `- ${w}`), '');
  out.push('## Steps', '');
  for (const s of p.steps) {
    out.push(`### ${s.index + 1}. ${s.summary}`, '');
    if (s.diff) out.push('```diff', s.diff, '```', '');
  }
  out.push(p.valid ? `Approve with: \`apply <changes.json> --approve ${p.planId}\`` : 'Not applicable until the blocked items are fixed.');
  return out.join('\n') + '\n';
}

/** @param {ReturnType<typeof plan>} p */
const publicPlan = (p) => {
  const { _steps, _secrets, ...rest } = p;
  void _steps; void _secrets;
  return rest;
};

// ---------- CLI ----------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--force') flags.force = true;
    else if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
    else pos.push(rest[i]);
  }
  const root = typeof flags.root === 'string' ? flags.root : '.';
  const out = (/** @type {unknown} */ v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  const load = (/** @type {string} */ f) => {
    if (!f) throw new InputError('missing <changes.json>');
    try {
      const buf = readFileSync(f);
      // Windows PowerShell 5 `>` writes UTF-16LE with a BOM.
      const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8');
      return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new InputError(`cannot read change set ${f}: ${/** @type {Error} */ (e).message}`);
    }
  };
  try {
    if (cmd === 'preview') {
      const p = plan(load(pos[0]), root);
      if (flags.format === 'json') out(publicPlan(p));
      else process.stdout.write(previewMarkdown(p));
      process.exitCode = p.valid ? 0 : 3;
    } else if (cmd === 'apply') {
      const r = apply(load(pos[0]), root, { approve: typeof flags.approve === 'string' ? flags.approve : undefined });
      out(r);
      process.exitCode = r.status === 'success' ? 0 : r.status === 'failed' ? 1 : 3;
    } else if (cmd === 'rollback') {
      if (!pos[0]) throw new InputError('missing <runId>');
      const r = rollback(root, pos[0], { force: !!flags.force });
      out(r);
      process.exitCode = r.status === 'rolled_back' ? 0 : 1;
    } else if (cmd === 'runs') out(listRuns(root));
    else {
      console.error('Usage: engine.mjs preview|apply|rollback|runs ... (see SKILL.md)');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`backend-execute: ${redact(/** @type {Error} */ (e).message)}`);
    process.exitCode = 2;
  }
}
