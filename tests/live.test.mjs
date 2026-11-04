// Opt-in tests against the REAL Firebase / Supabase CLIs and the user's own login. Skipped by default.
// Run: BACKENDPILOT_LIVE=1 npm test           (PowerShell: $env:BACKENDPILOT_LIVE=1; npm test)
// Optional: BACKENDPILOT_LIVE_SUPABASE_REF=<ref of an ACTIVE project> to also test `supabase link` end to end.
// Read-only against the cloud. `supabase link` writes only to a temp directory, which is then rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { select, status } from '../skills/provider-connect/scripts/connect.mjs';
import { apply, plan, rollback } from '../skills/backend-execute/scripts/engine.mjs';

const LIVE = process.env.BACKENDPILOT_LIVE === '1';
const skip = !LIVE && 'set BACKENDPILOT_LIVE=1 to run against real CLIs';

for (const provider of /** @type {const} */ (['firebase', 'supabase'])) {
  test(`live ${provider}: CLI found and login state reported`, { skip }, (t) => {
    const s = status(provider, process.cwd(), true);
    assert.equal(s.cli.installed, true, `${provider} CLI not installed`);
    assert.notEqual(s.auth.loggedIn, null, `unexpected CLI error: ${s.auth.detail}`);
    if (!s.auth.loggedIn) return t.skip(`not logged in to ${provider}; run "${provider} login" to test project listing`);
    assert.ok(Array.isArray(s.projects));
    for (const p of s.projects ?? []) assert.ok(p.id && typeof p.name === 'string');
  });
}

test('live supabase: link and roll back in a temp dir', { skip: skip || (!process.env.BACKENDPILOT_LIVE_SUPABASE_REF && 'set BACKENDPILOT_LIVE_SUPABASE_REF') }, () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-live-'));
  try {
    const cs = select('supabase', /** @type {string} */ (process.env.BACKENDPILOT_LIVE_SUPABASE_REF), root);
    const r = apply(cs, root, { approve: plan(cs, root).planId });
    assert.equal(r.status, 'success', JSON.stringify(r.errors));
    assert.equal(rollback(root, /** @type {string} */ (r.runId)).status, 'rolled_back');
    assert.equal(existsSync(join(root, 'supabase')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
