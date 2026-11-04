// Fake npm / firebase / supabase executables for tests. Put on PATH with fakeBin(); behaviour is driven by env vars.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPL = fileURLToPath(new URL('./fake-impl.mjs', import.meta.url));

/** Create a bin dir with the named fakes. @param {string[]} names */
export function fakeBin(names) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-bin-'));
  for (const n of names) {
    if (process.platform === 'win32') writeFileSync(join(dir, `${n}.cmd`), `@"${process.execPath}" "${IMPL}" ${n} %*\r\n`);
    else {
      writeFileSync(join(dir, n), `#!/bin/sh\nexec "${process.execPath}" "${IMPL}" ${n} "$@"\n`);
      chmodSync(join(dir, n), 0o755);
    }
  }
  return dir;
}

/**
 * Run fn with PATH = binDir (+ the real PATH when keepPath) and extra env vars, then restore.
 * @template T @param {string} binDir @param {Record<string, string>} env @param {() => T} fn @param {boolean} [keepPath]
 */
export function withEnv(binDir, env, fn, keepPath = true) {
  const saved = { ...process.env };
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  process.env[pathKey] = keepPath ? binDir + delimiter + saved[pathKey] : binDir;
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
