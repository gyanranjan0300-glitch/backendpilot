// Safety checks run before any change is approved. Errors block; warnings are shown in the preview.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { PUBLIC_PREFIX, findBlockedSecrets, isClientExposedSecret } from './shared/security.mjs';

const FORBIDDEN_TOP = new Set(['.git', '.backendpilot', 'node_modules']);
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
export const ENV_FILE = /^\.env(\..+)?$/;
export const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/;
// PUBLIC_PREFIX is /^(A_|B_|...)/; reuse its alternatives to find such variable names anywhere in text.
const CLIENT_VAR = new RegExp(`\\b(?:${PUBLIC_PREFIX.source.slice(2, -1)})[A-Z0-9_]+`, 'g');
/** @param {string} rel */
export const isEnvFile = (rel) => ENV_FILE.test(basename(rel));

const winFold = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
/** @param {string} parent @param {string} child */
const inside = (parent, child) => {
  const r = relative(winFold(parent), winFold(child));
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

/**
 * Resolve a change-set path to an absolute path inside root, or throw.
 * Rejects absolute paths, `..`, NUL, Windows device names and streams, protected dirs, and symlink escapes.
 * @param {string} root absolute project root
 * @param {unknown} rel
 * @returns {{ abs: string, rel: string }}
 */
export function resolveSafe(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('path must be a non-empty string');
  if (rel.includes('\0')) throw new Error('path contains NUL');
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || /^[\\/]/.test(rel)) throw new Error(`absolute paths are not allowed: ${rel}`);
  const parts = normalize(rel).split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..')) throw new Error(`path escapes the project root: ${rel}`);
  if (parts.some((p) => p.includes(':') || WIN_RESERVED.test(p) || /[. ]$/.test(p) && p !== '.')) throw new Error(`path is not portable or safe on Windows: ${rel}`);
  const clean = parts.filter((p) => p !== '.');
  if (!clean.length) throw new Error(`path resolves to the project root: ${rel}`);
  if (FORBIDDEN_TOP.has(clean[0].toLowerCase())) throw new Error(`writing inside ${clean[0]}/ is not allowed: ${rel}`);
  const abs = resolve(root, ...clean);
  if (!inside(root, abs)) throw new Error(`path escapes the project root: ${rel}`);

  // Symlink checks: the target must not be a link, and its nearest existing ancestor must resolve inside root.
  if (isLink(abs)) throw new Error(`path is a symlink: ${rel}`);
  let probe = dirname(abs);
  while (!existsSync(probe)) probe = dirname(probe);
  const realRoot = realpathSync(root);
  const realProbe = realpathSync(probe);
  if (winFold(realProbe) !== winFold(realRoot) && !inside(realRoot, realProbe)) throw new Error(`path resolves outside the project root through a symlink: ${rel}`);
  return { abs, rel: clean.join('/') };
}

/** @param {string} p */
function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Content rules for a file about to be written.
 * @param {string} rel posix path
 * @param {string} after new content
 * @param {string|null} before current content
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkContent(rel, after, before) {
  // Problems the file already had are reported as warnings; only problems this change introduces block it.
  const now = contentProblems(rel, after);
  const prev = new Set(before === null ? [] : contentProblems(rel, before).errors);
  return {
    errors: now.errors.filter((e) => !prev.has(e)),
    warnings: [...now.warnings, ...now.errors.filter((e) => prev.has(e)).map((e) => `already present, not introduced by this change: ${e}`)],
  };
}

/** @param {string} rel @param {string} after */
function contentProblems(rel, after) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const name = basename(rel);

  if (!isEnvFile(rel)) {
    for (const id of new Set(findBlockedSecrets(after))) errors.push(`${rel}: contains a credential (${id}) in a source file. Use an env var the user fills in.`);
  }

  for (const n of new Set([...after.matchAll(CLIENT_VAR)].map((m) => m[0]))) {
    if (isClientExposedSecret(n)) errors.push(`${rel}: ${n} exposes a secret to browser code (client-exposed prefix on a secret name).`);
  }
  if (/^\s*['"]use client['"]/m.test(after) && /(SERVICE_ROLE|['"]firebase-admin)/.test(after)) {
    errors.push(`${rel}: client component references a service-role key or firebase-admin. Admin access must stay server-side.`);
  }

  if (name.endsWith('.rules')) checkRules(rel, after, errors, warnings);
  if (name.endsWith('.sql')) checkSql(rel, after, errors, warnings);
  return { errors, warnings };
}

/** Firebase security rules. @param {string} rel @param {string} text @param {string[]} errors @param {string[]} warnings */
function checkRules(rel, text, errors, warnings) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const m of code.matchAll(/allow\s+([a-z,\s]+?)\s*(?::\s*if\s+([^;]+))?;/g)) {
    const methods = m[1].split(/[\s,]+/).filter(Boolean);
    const cond = m[2]?.trim();
    if (cond !== undefined && cond !== 'true') continue;
    const writes = methods.some((x) => ['write', 'create', 'update', 'delete'].includes(x));
    const msg = `${rel}: "allow ${methods.join(', ')}${cond ? ': if true' : ''}" grants access to everyone`;
    if (writes) errors.push(`${msg}. Unrestricted writes are never generated.`);
    else warnings.push(`${msg}. Confirm this data is meant to be public.`);
  }
}

/** Postgres / Supabase migrations. @param {string} rel @param {string} sql @param {string[]} errors @param {string[]} warnings */
function checkSql(rel, sql, errors, warnings) {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
  if (/disable\s+row\s+level\s+security/i.test(code)) errors.push(`${rel}: disables Row Level Security. BackendPilot never disables RLS.`);
  for (const stmt of code.split(';')) {
    const p = /create\s+policy\s+[\s\S]*?\bon\s+([\w."]+)([\s\S]*)$/i.exec(stmt);
    if (!p) continue;
    const rest = p[2];
    const cmd = (/\bfor\s+(all|select|insert|update|delete)\b/i.exec(rest)?.[1] ?? 'all').toLowerCase();
    const roles = (/\bto\s+([\w\s,"]+?)(?=\s+(?:using|with)\b|$)/i.exec(rest)?.[1] ?? 'public').toLowerCase().split(/[\s,"]+/).filter(Boolean);
    if (!/\b(using|with\s+check)\s*\(\s*true\s*\)/i.test(rest)) continue;
    const open = roles.includes('public') || roles.includes('anon');
    const msg = `${rel}: policy on ${p[1]} (${cmd}) allows every row to ${roles.join(', ')}`;
    if (cmd !== 'select' && open) errors.push(`${msg}. Unrestricted write policies are never generated.`);
    else if (cmd !== 'select') warnings.push(`${msg}. Any signed-in user can change any row; prefer an ownership check.`);
    else if (open) warnings.push(`${msg}. Confirm this table is meant to be publicly readable.`);
  }
  if (/(^|\/)supabase\/migrations\//.test(rel)) {
    for (const m of code.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?(\w+)"?\.)?"?(\w+)"?)/gi)) {
      const schema = (m[2] ?? 'public').toLowerCase();
      if (schema !== 'public') continue;
      const table = m[3];
      const rls = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:"?public"?\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`, 'i');
      if (!rls.test(code)) errors.push(`${rel}: table public.${table} is created without "enable row level security". Tables in the public schema are reachable through the Supabase API.`);
    }
  }
}
