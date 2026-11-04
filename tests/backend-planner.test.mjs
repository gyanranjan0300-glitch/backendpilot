import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, planMarkdown } from '../skills/backend-planner/scripts/check-plan.mjs';

const valid = () => ({
  version: 1,
  requirement: 'Users sign in with email or Google, keep private notes, and upload an avatar.',
  provider: 'supabase',
  rationale: 'Relational notes with per-user ownership fit Postgres + RLS.',
  auth: { methods: ['email-password', 'google'], features: ['password-reset', 'protected-routes'], integration: 'Extend the existing React Router layout with a session provider in src/auth.' },
  database: {
    kind: 'postgres',
    entities: [
      { name: 'profiles', fields: [{ name: 'id', type: 'uuid', references: 'auth.users.id' }, { name: 'display_name', type: 'text' }], access: { read: 'authenticated', write: 'owner', ownerField: 'id' } },
      { name: 'notes', fields: [{ name: 'id', type: 'uuid' }, { name: 'user_id', type: 'uuid', references: 'profiles.id' }, { name: 'body', type: 'text' }], indexes: [['user_id']], access: { read: 'owner', write: 'owner', ownerField: 'user_id' } },
    ],
  },
  storage: { buckets: [{ name: 'avatars', public: false, maxSizeMB: 2, mimeTypes: ['image/png', 'image/jpeg'], access: { read: 'authenticated', write: 'owner' }, pathPattern: '{uid}/*' }] },
  dependencies: [{ name: '@supabase/supabase-js', version: '^2', where: 'client' }],
  env: [{ name: 'VITE_SUPABASE_URL', exposure: 'client' }, { name: 'VITE_SUPABASE_ANON_KEY', exposure: 'client' }, { name: 'SUPABASE_SERVICE_ROLE_KEY', exposure: 'server', secret: true }],
  steps: [
    { title: 'Link the Supabase project', skill: 'provider-connect' },
    { title: 'Create tables with RLS', skill: 'supabase-database' },
    { title: 'Enable Google in dashboard', manual: true },
  ],
});

test('valid plan passes, derives manual dashboard steps, and labels unbuilt skills as planned', () => {
  const r = checkPlan(valid());
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
  assert.deepEqual(r.steps.map((s) => s.kind), ['automated', 'planned', 'manual']);
  assert.ok(r.manual_actions.some((m) => /auth\/v1\/callback/.test(m)));
  assert.match(r.warnings.join('\n'), /supabase-database is not available/);
  const md = planMarkdown(valid(), r);
  assert.match(md, /\| notes \|/);
  assert.match(md, /Nothing has been changed/);
});

test('rejects insecure or inconsistent plans', () => {
  /** @type {[(p: any) => void, RegExp][]} */
  const cases = [
    [(p) => { p.database.entities[1].access = undefined; }, /Every entity needs an explicit policy/],
    [(p) => { p.database.entities[1].access.write = 'public'; }, /public writes are not allowed/],
    [(p) => { p.database.entities[1].access.ownerField = 'owner'; }, /ownerField "owner" is not one of its fields/],
    [(p) => { p.database.kind = 'firestore'; }, /database.kind must be one of postgres/],
    [(p) => { p.database.entities[1].fields[1].references = 'users.id'; }, /references unknown entity users/],
    [(p) => { p.storage.buckets[0].public = true; }, /public bucket but access.read is authenticated/],
    [(p) => { p.storage.buckets[0].access.write = 'public'; }, /public uploads are not allowed/],
    [(p) => { delete p.storage.buckets[0].pathPattern; }, /pathPattern containing \{uid\}/],
    [(p) => { delete p.storage.buckets[0].maxSizeMB; }, /maxSizeMB/],
    [(p) => { p.env.push({ name: 'VITE_SUPABASE_SERVICE_ROLE_KEY', exposure: 'client' }); }, /client-exposed prefix/],
    [(p) => { p.env[2].exposure = 'client'; }, /is a secret but exposure is "client"/],
    [(p) => { p.dependencies.push({ name: 'firebase-admin', where: 'client' }); }, /must have where: "server"/],
    [(p) => { p.auth.methods = ['carrier-pigeon']; }, /not supported by Supabase/],
    [(p) => { p.provider = 'mongodb'; }, /provider must be one of/],
  ];
  for (const [mutate, why] of cases) {
    const p = valid();
    mutate(p);
    const r = checkPlan(p);
    assert.equal(r.valid, false, String(why));
    assert.match(r.errors.join('\n'), why);
  }
});

test('cross-checks against the backend-detect report', () => {
  const report = { detections: { backend: [{ id: 'firebase' }], auth: [{ id: 'clerk', name: 'Clerk' }], routing: [] } };
  const r = checkPlan(valid(), report);
  assert.equal(r.valid, true);
  const w = r.warnings.join('\n');
  assert.match(w, /already uses firebase/);
  assert.match(w, /already has auth \(Clerk\)/);
  assert.match(w, /no router detected/);
});
