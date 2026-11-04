#!/usr/bin/env node
// Validates an AI-written backend plan (see references/plan-schema.md) and renders it for user approval.
// Read-only. Usage: node check-plan.mjs <plan.json> [--report <backend-detect.json>] [--format markdown|json]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, manualActionsFor } from './shared/providers.mjs';
import { isClientExposedSecret, isSecretName, PUBLIC_PREFIX } from './shared/security.mjs';

/** Skills that exist today and can run a step. Anything else is planned work, not automation. */
const AVAILABLE_SKILLS = new Set(['backend-detect', 'provider-connect', 'backend-execute', 'backend-planner']);
const ACCESS_READ = ['none', 'owner', 'authenticated', 'public'];
const ACCESS_WRITE = ['none', 'owner', 'authenticated', 'admin'];
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const COLLECTION = /^[A-Za-z0-9_-]{1,100}$/;
const PKG = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const ADMIN_PKGS = new Set(['firebase-admin']);
const FEATURES = ['password-reset', 'email-verification', 'session-persistence', 'protected-routes', 'logout', 'auth-callback'];

/**
 * @param {any} plan
 * @param {any} [report] backend-detect report
 */
export function checkPlan(plan, report) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const manual = [];
  const err = (/** @type {string} */ m) => errors.push(m);

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors: ['plan must be a JSON object'], warnings, manual_actions: manual, steps: [] };
  if (plan.version !== 1) err('version must be 1');
  if (typeof plan.requirement !== 'string' || !plan.requirement.trim()) err('requirement: describe what the user asked for');
  const provider = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (plan.provider)];
  if (!provider) err(`provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`);
  if (typeof plan.rationale !== 'string' || !plan.rationale.trim()) err('rationale: explain why this provider and design fit the project');

  // Auth
  if (plan.auth != null) {
    const methods = Array.isArray(plan.auth.methods) ? plan.auth.methods : [];
    if (!methods.length) err('auth.methods must list at least one sign-in method');
    for (const m of methods) {
      if (provider && !provider.authMethods.includes(m)) err(`auth.methods: ${m} is not supported by ${provider.name} (supported: ${provider.authMethods.join(', ')})`);
      else if (provider) manual.push(...manualActionsFor(plan.provider, m));
    }
    for (const f of plan.auth.features ?? []) if (!FEATURES.includes(f)) err(`auth.features: unknown feature ${f} (known: ${FEATURES.join(', ')})`);
    if (typeof plan.auth.integration !== 'string' || !plan.auth.integration.trim()) err('auth.integration: say where auth state lives and how it joins the existing app (router, state library)');
  }

  // Database
  const entityNames = new Set();
  if (plan.database != null) {
    const db = plan.database;
    if (provider && !provider.databases.includes(db.kind)) err(`database.kind must be one of ${provider.databases.join(', ')} for ${provider.name}`);
    if (!Array.isArray(db.entities) || !db.entities.length) err('database.entities must be a non-empty array');
    for (const [i, e] of (db.entities ?? []).entries()) {
      const at = `database.entities[${i}]${e?.name ? ` (${e.name})` : ''}`;
      const nameOk = db.kind === 'postgres' ? IDENT.test(e?.name ?? '') : COLLECTION.test(e?.name ?? '');
      if (!nameOk) err(`${at}: invalid ${db.kind === 'postgres' ? 'table' : 'collection'} name`);
      if (entityNames.has(e?.name)) err(`${at}: duplicate name`);
      entityNames.add(e?.name);
      const fields = Array.isArray(e?.fields) ? e.fields : [];
      if (!fields.length) err(`${at}: fields must be a non-empty array`);
      const fieldNames = new Set(fields.map((/** @type {any} */ f) => f?.name));
      for (const f of fields) {
        if (typeof f?.name !== 'string' || (db.kind === 'postgres' && !IDENT.test(f.name))) err(`${at}: invalid field name ${JSON.stringify(f?.name)}`);
        if (typeof f?.type !== 'string' || !f.type) err(`${at}.${f?.name}: type is required`);
      }
      const access = e?.access;
      if (access?.write === 'public') {
        err(`${at}: public writes are not allowed`);
        continue;
      }
      if (!access || !ACCESS_READ.includes(access.read) || !ACCESS_WRITE.includes(access.write)) {
        err(`${at}: access.read must be one of ${ACCESS_READ.join('|')} and access.write one of ${ACCESS_WRITE.join('|')}. Every entity needs an explicit policy.`);
        continue;
      }
      if (access.read === 'public') warnings.push(`${at}: readable by anyone, including signed-out users. Confirm this is intended.`);
      if (access.write === 'authenticated') warnings.push(`${at}: any signed-in user can modify any record. Prefer "owner" unless records are shared.`);
      if ((access.read === 'owner' || access.write === 'owner') && !fieldNames.has(access.ownerField)) err(`${at}: access uses "owner" but ownerField ${JSON.stringify(access.ownerField)} is not one of its fields`);
    }
    for (const [i, e] of (db.entities ?? []).entries()) {
      for (const f of e?.fields ?? []) {
        const ref = typeof f?.references === 'string' ? f.references.split('.')[0] : null;
        if (ref && ref !== 'auth' && !entityNames.has(ref)) err(`database.entities[${i}].${f.name}: references unknown entity ${ref}`);
      }
    }
  }

  // Storage
  if (plan.storage != null) {
    if (provider && !provider.storage) err(`${provider.name} storage is not supported`);
    for (const [i, b] of (plan.storage.buckets ?? []).entries()) {
      const at = `storage.buckets[${i}]${b?.name ? ` (${b.name})` : ''}`;
      if (typeof b?.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,62}$/.test(b.name)) err(`${at}: invalid bucket name`);
      if (!(typeof b?.maxSizeMB === 'number' && b.maxSizeMB > 0 && b.maxSizeMB <= 5000)) err(`${at}: maxSizeMB must be a number between 0 and 5000`);
      if (!Array.isArray(b?.mimeTypes) || !b.mimeTypes.length) err(`${at}: mimeTypes must list allowed types`);
      else if (b.mimeTypes.some((/** @type {string} */ m) => m === '*/*' || m === '*')) warnings.push(`${at}: accepts any file type`);
      const a = b?.access;
      if (a?.write === 'public') err(`${at}: public uploads are not allowed`);
      else if (!a || !ACCESS_READ.includes(a.read) || !ACCESS_WRITE.includes(a.write)) err(`${at}: access.read and access.write are required (${ACCESS_READ.join('|')} / ${ACCESS_WRITE.join('|')})`);
      else {
        if (b.public === true && a.read !== 'public') err(`${at}: public bucket but access.read is ${a.read}; a public bucket serves files to anyone`);
        if (a.read === 'public') warnings.push(`${at}: files are readable by anyone with the URL`);
        if (a.write === 'authenticated') warnings.push(`${at}: any signed-in user can overwrite any file. Prefer "owner" with a per-user path.`);
        if (a.write === 'owner' && !(typeof b.pathPattern === 'string' && b.pathPattern.includes('{uid}'))) err(`${at}: owner writes need a pathPattern containing {uid}, e.g. "{uid}/*"`);
      }
    }
  }

  // Dependencies
  for (const d of plan.dependencies ?? []) {
    if (typeof d?.name !== 'string' || !PKG.test(d.name)) err(`dependencies: invalid package name ${JSON.stringify(d?.name)}`);
    else if (ADMIN_PKGS.has(d.name) && d.where !== 'server') err(`dependencies: ${d.name} grants admin access and must have where: "server"`);
  }

  // Env
  for (const v of plan.env ?? []) {
    const name = String(v?.name ?? '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { err(`env: invalid name ${JSON.stringify(v?.name)}`); continue; }
    if (isClientExposedSecret(name)) err(`env: ${name} puts a secret behind a client-exposed prefix`);
    const secret = v.secret === true || isSecretName(name);
    if (secret && v.exposure === 'client') err(`env: ${name} is a secret but exposure is "client"`);
    if (v.exposure === 'client' && !PUBLIC_PREFIX.test(name)) warnings.push(`env: ${name} is marked client but has no framework public prefix, so the bundler will not expose it`);
    if (v.exposure === 'server' && PUBLIC_PREFIX.test(name)) err(`env: ${name} is marked server but its prefix exposes it to the browser`);
  }

  // Steps
  const steps = [];
  if (!Array.isArray(plan.steps) || !plan.steps.length) err('steps must be a non-empty ordered array');
  for (const [i, s] of (plan.steps ?? []).entries()) {
    if (typeof s?.title !== 'string' || !s.title) { err(`steps[${i}]: title is required`); continue; }
    const kind = s.manual ? 'manual' : AVAILABLE_SKILLS.has(s.skill) ? 'automated' : 'planned';
    if (kind === 'planned') warnings.push(`steps[${i}] "${s.title}": skill ${s.skill ?? '(none)'} is not available in this BackendPilot version; the agent must do this by hand with backend-execute change sets, or skip it.`);
    steps.push({ n: i + 1, title: s.title, skill: s.skill ?? null, kind, approval: s.manual ? false : true });
  }
  manual.push(...(plan.manual_actions ?? []).filter((/** @type {unknown} */ m) => typeof m === 'string'));

  // Cross-check with the detection report
  if (report?.detections) {
    const detected = report.detections.backend.map((/** @type {any} */ b) => b.id);
    if (detected.length && plan.provider && !detected.includes(plan.provider)) warnings.push(`project already uses ${detected.join(', ')}; the plan adds ${plan.provider}. Confirm this is a migration or a deliberate second backend.`);
    const otherAuth = report.detections.auth.filter((/** @type {any} */ a) => !a.provider || a.provider !== plan.provider).map((/** @type {any} */ a) => a.name);
    if (plan.auth && otherAuth.length) warnings.push(`project already has auth (${otherAuth.join(', ')}). Plan how they coexist to avoid duplicate auth state.`);
    if (plan.auth && report.detections.routing.length === 0) warnings.push('no router detected; say in auth.integration how protected routes are enforced');
  }

  return { valid: errors.length === 0, errors, warnings, manual_actions: [...new Set(manual)], steps };
}

/** @param {any} plan @param {ReturnType<typeof checkPlan>} r */
export function planMarkdown(plan, r) {
  const o = [`# Backend plan: ${plan.provider ?? '?'}`, '', `**Requirement:** ${plan.requirement ?? ''}`, '', `**Why:** ${plan.rationale ?? ''}`, ''];
  if (r.errors.length) o.push('## Must fix before approval', '', ...r.errors.map((e) => `- ${e}`), '');
  if (r.warnings.length) o.push('## Review', '', ...r.warnings.map((w) => `- ${w}`), '');
  if (plan.auth) o.push('## Authentication', '', `- Methods: ${(plan.auth.methods ?? []).join(', ')}`, `- Features: ${(plan.auth.features ?? []).join(', ') || 'none'}`, `- Integration: ${plan.auth.integration ?? ''}`, '');
  if (plan.database) {
    o.push(`## Database (${plan.database.kind})`, '', '| Entity | Fields | Read | Write |', '|---|---|---|---|');
    for (const e of plan.database.entities ?? []) o.push(`| ${e.name} | ${(e.fields ?? []).map((/** @type {any} */ f) => `${f.name}: ${f.type}${f.references ? ` → ${f.references}` : ''}`).join(', ')} | ${e.access?.read ?? '?'} | ${e.access?.write ?? '?'}${e.access?.ownerField ? ` (${e.access.ownerField})` : ''} |`);
    o.push('');
  }
  if (plan.storage?.buckets?.length) {
    o.push('## Storage', '', '| Bucket | Public | Max MB | Types | Read | Write | Path |', '|---|---|---|---|---|---|---|');
    for (const b of plan.storage.buckets) o.push(`| ${b.name} | ${b.public ? 'yes' : 'no'} | ${b.maxSizeMB} | ${(b.mimeTypes ?? []).join(', ')} | ${b.access?.read} | ${b.access?.write} | ${b.pathPattern ?? ''} |`);
    o.push('');
  }
  if (plan.dependencies?.length) o.push('## Dependencies', '', ...plan.dependencies.map((/** @type {any} */ d) => `- \`${d.name}${d.version ? '@' + d.version : ''}\` (${d.where ?? 'client'}${d.dev ? ', dev' : ''})`), '');
  if (plan.env?.length) o.push('## Environment variables', '', ...plan.env.map((/** @type {any} */ v) => `- \`${v.name}\` (${v.exposure ?? '?'}${v.secret ? ', secret: user fills in' : ''})`), '');
  o.push('## Steps', '', ...r.steps.map((s) => `${s.n}. ${s.title} (${s.kind === 'automated' ? `automated: ${s.skill}` : s.kind}${s.approval ? ', needs approval' : ''})`), '');
  if (r.manual_actions.length) o.push('## Manual actions for the user', '', ...r.manual_actions.map((m) => `- [ ] ${m}`), '');
  o.push(r.valid ? 'Plan is valid. Nothing has been changed. Each automated step still gets its own preview and approval.' : 'Plan is not valid yet.');
  return o.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @type {Record<string, string>} */
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  const load = (/** @type {string} */ f) => {
    const buf = readFileSync(f);
    const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  };
  try {
    if (!pos[0]) throw new Error('Usage: check-plan.mjs <plan.json> [--report <detect.json>] [--format markdown|json]');
    const plan = load(pos[0]);
    const r = checkPlan(plan, flags.report ? load(flags.report) : undefined);
    process.stdout.write(flags.format === 'json' ? JSON.stringify(r, null, 2) + '\n' : planMarkdown(plan, r));
    process.exitCode = r.valid ? 0 : 3;
  } catch (e) {
    console.error(`backend-planner: ${/** @type {Error} */ (e).message}`);
    process.exitCode = 2;
  }
}
