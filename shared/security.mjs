// Source of truth for secret handling. Copied into skills by `npm run sync:shared`; edit here, not in skills/*/scripts/shared/.

export const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_|VUE_APP_)/;
// FIREBASE_DATABASE_URL is the public Realtime Database URL, unlike a Postgres DATABASE_URL connection string.
const SECRET_NAME = /(SERVICE_ROLE|SECRET|PRIVATE_KEY|ADMIN|PASSWORD|(?<!FIREBASE_)DATABASE_URL|DB_URL)/;

/** Name looks like a secret. @param {string} name */
export const isSecretName = (name) => SECRET_NAME.test(name.replace(PUBLIC_PREFIX, ''));
/** Name has a bundler prefix that inlines it into browser code AND looks like a secret. @param {string} name */
export const isClientExposedSecret = (name) => PUBLIC_PREFIX.test(name) && isSecretName(name);

/**
 * Patterns for credentials. `block: true` means writing it into a non-env file is refused.
 * Google API keys are not blocked: Firebase web API keys are designed to be public.
 * @type {{ id: string, re: RegExp, block: boolean, group?: number }[]}
 */
export const SECRET_PATTERNS = [
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, block: true },
  { id: 'supabase-secret-key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g, block: true },
  { id: 'supabase-access-token', re: /\bsbp_[A-Za-z0-9]{32,}/g, block: true },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, block: true },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, block: true },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, block: false },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, block: false },
  { id: 'url-password', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:)([^\s@/'"]+)(@)/gi, block: true, group: 2 },
  { id: 'assignment', re: /((?:password|passwd|secret|token|api[_-]?key|service[_-]?role[_-]?key)["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;`]{6,})/gi, block: false, group: 2 },
];

/** Role claim of a JWT, or null. @param {string} token */
export function jwtRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role ?? null;
  } catch {
    return null;
  }
}

/**
 * Replace credentials in text with [REDACTED:<kind>]. Exact `known` values (e.g. env values being written) are removed first.
 * @param {string} text
 * @param {Iterable<string>} [known]
 */
export function redact(text, known = []) {
  let out = String(text);
  for (const v of [...known].filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(v).join('[REDACTED]');
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (...m) => (p.group ? m.slice(1, p.group).join('') + `[REDACTED:${p.id}]` + m.slice(p.group + 1, -2).filter((x) => typeof x === 'string').join('') : `[REDACTED:${p.id}]`));
  }
  return out;
}

/**
 * Credentials in `text` that must not be written to source files.
 * @param {string} text
 * @returns {string[]} pattern ids found
 */
export function findBlockedSecrets(text) {
  const found = [];
  for (const p of SECRET_PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      if (p.block || (p.id === 'jwt' && jwtRole(m[0]) === 'service_role')) found.push(p.id === 'jwt' ? 'service-role-jwt' : p.id);
    }
  }
  return found;
}
