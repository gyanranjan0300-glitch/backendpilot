#!/usr/bin/env node
// Connects a project to an existing Firebase or Supabase project using the user's own CLI login.
// Read-only: `select` emits a change set for backend-execute; it never writes files itself.
// Usage:
//   node connect.mjs <firebase|supabase> status   [--root <dir>]
//   node connect.mjs <firebase|supabase> projects [--root <dir>]
//   node connect.mjs <firebase|supabase> select <projectId> [--root <dir>] [--out <changes.json>]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, tail } from './shared/exec.mjs';
import { PROVIDERS } from './shared/providers.mjs';
import { redact } from './shared/security.mjs';

const FIREBASE_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SUPABASE_REF = /^[a-z0-9]{20}$/;

/**
 * @typedef {{ id: string, name: string, extra: Record<string, string> }} RemoteProject
 * @typedef {{ provider: string, cli: { installed: boolean, version: string|null }, auth: { loggedIn: boolean|null, detail: string }, projects?: RemoteProject[], next: string[] }} Status
 */

/** Parse the first JSON value in CLI stdout (some CLIs print banners first). @param {string} s */
function parseJson(s) {
  const i = s.search(/[[{]/);
  if (i < 0) return null;
  try {
    return JSON.parse(s.slice(i));
  } catch {
    return null;
  }
}

/** @param {'firebase'|'supabase'} provider @param {string} cwd */
function cliVersion(provider, cwd) {
  const r = run(PROVIDERS[provider].cli.bin, ['--version'], { cwd, timeoutMs: 60_000 });
  return r.ok ? (/\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? r.stdout.trim()) : null;
}

/** @param {string} cwd @returns {{ ok: boolean, projects: RemoteProject[], detail: string, loggedIn: boolean|null }} */
function firebaseProjects(cwd) {
  const r = run('firebase', ['projects:list', '--json'], { cwd, timeoutMs: 90_000 });
  const j = parseJson(r.stdout);
  if (j?.status === 'success' && Array.isArray(j.result)) {
    return { ok: true, loggedIn: true, detail: 'authenticated', projects: j.result.map((/** @type {any} */ p) => ({ id: String(p.projectId), name: String(p.displayName ?? p.projectId), extra: { projectNumber: String(p.projectNumber ?? '') } })) };
  }
  const msg = String(j?.error ?? (r.stderr || r.stdout));
  const unauth = /authenticate|firebase login|credentials/i.test(msg);
  return { ok: false, loggedIn: unauth ? false : null, detail: tail(msg, [], 300), projects: [] };
}

/** @param {string} cwd @returns {{ ok: boolean, projects: RemoteProject[], detail: string, loggedIn: boolean|null }} */
function supabaseProjects(cwd) {
  const r = run('supabase', ['projects', 'list', '--output-format', 'json'], { cwd, timeoutMs: 90_000 });
  const j = parseJson(r.stdout);
  const list = Array.isArray(j) ? j : Array.isArray(j?.projects) ? j.projects : null;
  if (r.ok && list) {
    return { ok: true, loggedIn: true, detail: 'authenticated', projects: list.map((/** @type {any} */ p) => ({ id: String(p.ref ?? p.id), name: String(p.name ?? ''), extra: { region: String(p.region ?? ''), status: String(p.status ?? ''), organization: String(p.organization_slug ?? p.organization_id ?? '') } })) };
  }
  const msg = r.stderr || r.stdout;
  const unauth = /access token|supabase login|not logged in|unauthorized/i.test(msg);
  return { ok: false, loggedIn: unauth ? false : null, detail: tail(msg, [], 300), projects: [] };
}

/**
 * @param {'firebase'|'supabase'} provider
 * @param {string} cwd
 * @param {boolean} withProjects
 * @returns {Status}
 */
export function status(provider, cwd, withProjects = false) {
  const meta = PROVIDERS[provider];
  const version = cliVersion(provider, cwd);
  if (!version) {
    return { provider, cli: { installed: false, version: null }, auth: { loggedIn: null, detail: 'CLI not found' }, next: [`Ask the user to install the ${meta.name} CLI: ${meta.cli.install}`] };
  }
  const r = provider === 'firebase' ? firebaseProjects(cwd) : supabaseProjects(cwd);
  /** @type {Status} */
  const s = { provider, cli: { installed: true, version }, auth: { loggedIn: r.loggedIn, detail: r.detail }, next: [] };
  if (r.loggedIn === false) s.next.push(`Ask the user to run "${meta.cli.login}" in their own terminal (it opens a browser). Do not handle their credentials.`);
  else if (!r.ok) s.next.push(`The ${meta.name} CLI failed: ${r.detail}`);
  else {
    if (withProjects) s.projects = r.projects;
    s.next.push(r.projects.length ? `Ask the user which project to use, then run: connect.mjs ${provider} select <id>` : `No ${meta.name} projects are visible to this account. The user can create one in the ${meta.name} console.`);
  }
  return s;
}

/**
 * Build a change set that links the local project to an existing remote project.
 * @param {'firebase'|'supabase'} provider @param {string} id @param {string} root
 */
export function select(provider, id, root) {
  if (provider === 'firebase' && !FIREBASE_ID.test(id)) throw new UsageError(`"${id}" is not a valid Firebase project ID`);
  if (provider === 'supabase' && !SUPABASE_REF.test(id)) throw new UsageError(`"${id}" is not a valid Supabase project ref (20 lowercase letters/digits)`);
  const s = status(provider, root, true);
  if (!s.projects) throw new UsageError(`Cannot list ${PROVIDERS[provider].name} projects: ${s.next.join(' ')}`);
  const project = s.projects.find((p) => p.id === id);
  if (!project) throw new UsageError(`Project ${id} is not visible to the logged-in account. Visible: ${s.projects.map((p) => p.id).join(', ') || 'none'}`);

  if (provider === 'firebase') {
    return {
      version: 1,
      operation: 'firebase-connect',
      description: `Set Firebase project "${project.name}" (${id}) as the default for this directory. Same effect as "firebase use ${id}".`,
      steps: [{ type: 'json_merge', path: '.firebaserc', merge: { projects: { default: id } } }],
      manual_actions: [],
    };
  }
  const steps = [];
  if (!existsSync(join(root, 'supabase', 'config.toml'))) steps.push({ type: 'command', bin: 'supabase', args: ['init'] });
  steps.push({ type: 'command', bin: 'supabase', args: ['link', '--project-ref', id] });
  const paused = project.extra.status && !/^ACTIVE/.test(project.extra.status);
  return {
    version: 1,
    operation: 'supabase-connect',
    description: `Link this directory to Supabase project "${project.name}" (${id}) with "supabase link".`,
    steps,
    manual_actions: [
      ...(paused ? [`Project status is ${project.extra.status}. Linking fails until it is restored from the Supabase dashboard.`] : []),
      'Commands that touch the remote database (db push, db pull) ask for the database password. The user enters it themselves; never put it in a change set.',
    ],
  };
}

class UsageError extends Error {}

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @type {Record<string, string>} */
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  const [provider, cmd, id] = pos;
  const root = resolve(flags.root ?? '.');
  try {
    if (provider !== 'firebase' && provider !== 'supabase') throw new UsageError('first argument must be firebase or supabase');
    let result;
    if (cmd === 'status') result = status(provider, root, false);
    else if (cmd === 'projects') result = status(provider, root, true);
    else if (cmd === 'select') {
      if (!id) throw new UsageError('missing <projectId>');
      result = select(provider, id, root);
      if (flags.out) {
        const out = resolve(root, flags.out);
        if (existsSync(out) && readFileSync(out, 'utf8').trim()) throw new UsageError(`${flags.out} already exists; choose another --out path`);
        writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
      }
    } else throw new UsageError('command must be status, projects or select');
    process.stdout.write(redact(JSON.stringify(result, null, 2)) + '\n');
    if (cmd !== 'select' && result && 'auth' in result && !result.auth.loggedIn) process.exitCode = 1;
  } catch (e) {
    console.error(`provider-connect: ${redact(/** @type {Error} */ (e).message)}`);
    process.exitCode = 2;
  }
}
