# Roadmap

Each version ships only what is implemented, tested and documented. Done items move to [CHANGELOG.md](CHANGELOG.md).

## 0.1.0: Detection (done)

- [x] Repository layout, MIT license, CI, skill validator
- [x] `backend-detect` skill

## 0.2.0: Execution foundation (current)

- [x] `backend-execute`: preview, content-bound approval, backups, atomic writes, journal, verification, rollback, logs
- [x] `provider-connect`: CLI and login checks, project listing, link to an existing Firebase/Supabase project
- [x] `backend-planner`: plan schema and security validator
- [x] Shared code synced into skills; opt-in live CLI tests
- [ ] Live verification of Firebase project listing with a logged-in account
- [ ] Live verification of a successful `supabase link` (needs an active project)
- [ ] Release workflow (deferred until there is something to publish)

## 0.3.0: Firebase setup

- `firebase-setup`: register a web app and fetch its SDK config (`firebase apps:sdkconfig`), write client init, env vars
- `firebase-auth`: email/password and Google, wired into the detected router/state library
- `firestore-setup`: rules + indexes from the plan, emulator config, rules tests in the emulator

## 0.4.0: Supabase setup

- `supabase-setup`, `supabase-auth` (email/password, OAuth), `supabase-database` (migrations from the plan, destructive-change detection), `supabase-rls`
- Verification with `supabase start` and `supabase db lint`

## 0.5.0: Storage, audit, doctor

- Storage skills with size/MIME limits and policies
- `security-audit`, `backend-doctor`

## 1.0.0

- Stable change-set, plan and report schemas; full docs; public release after owner approval

## Future providers

Appwrite, Convex, PocketBase, custom REST. Detection exists for the first three.
