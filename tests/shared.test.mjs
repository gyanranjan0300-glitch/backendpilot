import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBlockedSecrets, isClientExposedSecret, redact } from '../shared/security.mjs';
import { run } from '../shared/exec.mjs';
import { sync } from '../scripts/sync-shared.mjs';

test('shared code copies in skills are up to date', () => {
  assert.deepEqual(sync(true), []);
});

test('redact removes known credential formats and known values, keeps structure', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop';
  const input = [
    `Authorization: Bearer ${jwt}`,
    'url=postgres://postgres:s3cr3tPass@db.x.supabase.co:5432/postgres',
    `sbp_${'a'.repeat(40)}`,
    'sb_secret_abcdefghijklmnop123',
    '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----',
    'password: hunter2hunter2',
    'my custom value: VERY-SPECIFIC-123',
  ].join('\n');
  const out = redact(input, ['VERY-SPECIFIC-123']);
  for (const leaked of [jwt, 's3cr3tPass', 'a'.repeat(40), 'sb_secret_abc', 'MIIEv', 'hunter2hunter2', 'VERY-SPECIFIC-123']) assert.ok(!out.includes(leaked), leaked);
  assert.match(out, /postgres:\/\/postgres:\[REDACTED:url-password\]@db\.x\.supabase\.co/);
  assert.equal(redact(redact(input)), redact(input), 'idempotent');
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('blocked secrets and client-exposed names', () => {
  assert.deepEqual(findBlockedSecrets('const a = "AIzaSyA-1234567890abcdefghijklmnopqrstu"'), []);
  assert.deepEqual(findBlockedSecrets('AKIAABCDEFGHIJKLMNOP'), ['aws-access-key']);
  assert.equal(isClientExposedSecret('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY'), true);
  assert.equal(isClientExposedSecret('NEXT_PUBLIC_FIREBASE_DATABASE_URL'), false);
  assert.equal(isClientExposedSecret('NEXT_PUBLIC_DATABASE_URL'), true);
  assert.equal(isClientExposedSecret('SUPABASE_SERVICE_ROLE_KEY'), false);
});

test('run refuses shell metacharacters (Windows cmd.exe and POSIX)', () => {
  for (const arg of ['a&b', 'a|b', 'a b', '"x"', '%PATH%', '!x!', 'a\nb', '$(id)', '`id`', 'a>b', 'a;b']) {
    assert.throws(() => run('git', ['status', arg], { cwd: '.' }), /unsafe command argument/, arg);
  }
  assert.throws(() => run('git&calc', [], { cwd: '.' }), /unsafe name/);
  assert.equal(run('git', ['--version'], { cwd: '.' }).ok, true);
});
