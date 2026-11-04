import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { select, status } from '../skills/provider-connect/scripts/connect.mjs';
import { apply, plan, rollback } from '../skills/backend-execute/scripts/engine.mjs';
import { fakeBin, withEnv } from './helpers/fake-cli.mjs';

// Fake CLIs only: these tests never reach Firebase or Supabase. See tests/live.test.mjs for real CLIs.
const BIN = fakeBin(['firebase', 'supabase']);
const EMPTY = fakeBin([]);
const tmp = () => mkdtempSync(join(tmpdir(), 'bp-conn-'));

test('CLI not installed: says how to install, no crash', () => {
  const root = tmp();
  try {
    const s = withEnv(EMPTY, {}, () => status('firebase', root), false);
    assert.equal(s.cli.installed, false);
    assert.match(s.next[0], /npm install -g firebase-tools/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('not logged in: tells the agent to have the user log in themselves', () => {
  const root = tmp();
  try {
    for (const provider of /** @type {const} */ (['firebase', 'supabase'])) {
      const s = withEnv(BIN, {}, () => status(provider, root));
      assert.equal(s.cli.installed, true, provider);
      assert.equal(s.auth.loggedIn, false, provider);
      assert.match(s.next[0], new RegExp(`${provider} login`));
      assert.throws(() => withEnv(BIN, {}, () => select(provider, provider === 'firebase' ? 'demo-app-123' : 'abcdefghijklmnopqrst', root)), /Cannot list/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('firebase: list projects, select emits a change set the engine applies and rolls back', () => {
  const root = tmp();
  try {
    const env = { FAKE_FIREBASE_LOGGED_IN: '1' };
    const s = withEnv(BIN, env, () => status('firebase', root, true));
    assert.deepEqual(s.projects?.map((p) => p.id), ['demo-app-123']);
    assert.throws(() => withEnv(BIN, env, () => select('firebase', 'other-project', root)), /not visible/);
    assert.throws(() => select('firebase', 'BAD ID', root), /not a valid Firebase project ID/);

    writeFileSync(join(root, '.firebaserc'), '{\n  "projects": {\n    "staging": "demo-staging"\n  }\n}\n');
    const cs = withEnv(BIN, env, () => select('firebase', 'demo-app-123', root));
    assert.deepEqual(cs.steps, [{ type: 'json_merge', path: '.firebaserc', merge: { projects: { default: 'demo-app-123' } } }]);
    const p = plan(cs, root);
    const r = apply(cs, root, { approve: p.planId });
    assert.equal(r.status, 'success', JSON.stringify(r.errors));
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.firebaserc'), 'utf8')), { projects: { staging: 'demo-staging', default: 'demo-app-123' } });
    rollback(root, /** @type {string} */ (r.runId));
    assert.equal(readFileSync(join(root, '.firebaserc'), 'utf8'), '{\n  "projects": {\n    "staging": "demo-staging"\n  }\n}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('supabase: parses JSON despite stderr noise; select runs init + link through the engine', () => {
  const root = tmp();
  try {
    const env = { FAKE_SUPABASE_LOGGED_IN: '1' };
    const s = withEnv(BIN, env, () => status('supabase', root, true));
    assert.equal(s.auth.loggedIn, true);
    assert.deepEqual(s.projects?.[0], { id: 'abcdefghijklmnopqrst', name: 'Demo', extra: { region: 'eu-west-1', status: 'ACTIVE_HEALTHY', organization: 'org' } });
    assert.throws(() => select('supabase', 'short', root), /not a valid Supabase project ref/);

    const cs = withEnv(BIN, env, () => select('supabase', 'abcdefghijklmnopqrst', root));
    assert.deepEqual(cs.steps.map((/** @type {any} */ x) => x.args.join(' ')), ['init', 'link --project-ref abcdefghijklmnopqrst']);
    const r = withEnv(BIN, env, () => apply(cs, root, { approve: plan(cs, root).planId }));
    assert.equal(r.status, 'success', JSON.stringify(r.errors));
    assert.equal(readFileSync(join(root, 'supabase/.temp/project-ref'), 'utf8'), 'abcdefghijklmnopqrst');
    assert.equal(rollback(root, /** @type {string} */ (r.runId)).status, 'rolled_back');
    assert.equal(existsSync(join(root, 'supabase')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
