# BackendPilot

**Your AI Agent. Your Backend. Fully Configured.**

BackendPilot is a set of [Agent Skills](https://agentskills.io/) that let an AI coding agent (Claude Code first) inspect, set up and verify Firebase and Supabase backends in existing apps. Skills contain real scripts that do and check the work; the agent plans and explains.

> **Status: 0.2.0, early.** Detection, planning, a safe change engine, and linking to an existing Firebase/Supabase project work. BackendPilot does not yet set up auth, databases or storage for you. That is on the [roadmap](ROADMAP.md).

## The problem

Wiring a backend into an existing app means SDK installs, config files, env vars, auth providers, security rules or RLS policies, storage policies, and dashboard settings, all of which must match what the app already does. Agents asked to do this tend to guess. BackendPilot's first job is to stop the guessing by giving the agent an accurate picture of the project.

## What works today

### `backend-detect`

A read-only scanner that reports, with evidence for every claim:

- **Frameworks:** React, Next.js, Vue, Nuxt, Angular, Svelte, SvelteKit, Astro, Vite, Flutter
- **Runtimes:** Node.js, Express, NestJS, Fastify, Hono
- **Language and package manager:** TypeScript / JavaScript / Dart; npm, yarn, pnpm, bun, pub
- **Backends:** Firebase, Supabase (plus detection only for Appwrite, Convex, PocketBase)
- **Auth:** Firebase Auth, Supabase Auth, Auth.js, Clerk, Auth0, Passport, Better Auth, Lucia; sign-in methods used in code (email/password, Google, GitHub)
- **Databases:** Firestore, Realtime Database, Supabase Postgres, Prisma, Drizzle, Mongoose, MongoDB, pg, MySQL, TypeORM, Sequelize, Knex, Kysely, SQLite, Redis; schema and migration files
- **Storage and functions:** Firebase Storage, Supabase Storage, S3, Cloudinary, UploadThing, Vercel Blob; Cloud Functions, Edge Functions
- **Routing and state:** Next.js App/Pages Router, React Router, TanStack Router, Vue Router, go_router; Redux, Zustand, Jotai, Pinia, MobX, TanStack Query, Riverpod, flutter_bloc
- **Environment:** env var names referenced in code vs. defined in `.env*` files. Values are never output.
- **Security findings:** committed or unignored `.env` files, service-account JSON in the repo, secrets behind client-exposed prefixes like `NEXT_PUBLIC_` or `VITE_`

Detection combines dependencies, config files and source imports, so a backend configured only in code is still found.

### `backend-planner`

The agent writes a backend plan (database entities with read/write rules, auth methods, storage buckets with size/type limits, dependencies, env vars, steps) as JSON. `check-plan.mjs` rejects insecure plans (public writes, missing policies, secrets exposed to the browser, `firebase-admin` in client code), adds the dashboard steps each sign-in method needs, and labels each step `automated`, `planned` or `manual`. It changes nothing.

### `backend-execute`

The engine every change goes through: **preview** (diff, env values hidden) → **approve** with a plan ID tied to that exact preview and the current file contents → **apply** with backups, an atomic write per file, and a journal → **verify** each step → automatic **rollback** on failure, or `rollback <runId>` later. Step types: `create`, `edit`, `json_merge`, `env_set`, `install` (npm/pnpm/yarn/bun), and allowlisted `supabase init` / `supabase link`. It blocks path traversal, credentials in source files, open Firebase rules, RLS being disabled, and unrestricted write policies.

### `provider-connect`

Uses the official `firebase` and `supabase` CLIs with **the user's own login** to check install and login state, list accessible projects, and build a change set that links one: `.firebaserc` default project, or `supabase init` + `supabase link`. API keys are never used for admin access.

## Install

Requires Node.js 20+. No npm install needed for the skills themselves.

**Claude Code:** copy the folders under `skills/` into your project's `.claude/skills/` (or `~/.claude/skills/` for all projects). Each folder is self-contained. Then ask:

> What backend does this project use?

Any agent that supports the Agent Skills format can load the same folder. Only Claude Code has been considered during design; other agents are untested.

**Directly:**

```sh
node skills/backend-detect/scripts/scan.mjs /path/to/app --format markdown
node skills/backend-detect/scripts/scan.mjs /path/to/app            # JSON
```

Example output (abridged):

```
## backend
- **Firebase** (high): dependency `firebase` in package.json; file `firebase.json` in firebase.json
## Findings
- **CRITICAL** `SECRET_EXPOSED_TO_CLIENT` (.env.local): NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY uses a client-exposed prefix ...
```

Report format: [skills/backend-detect/references/report-schema.md](skills/backend-detect/references/report-schema.md).

## Architecture

```
Agent ──reads──▶ SKILL.md (what to do, rules)
      ──runs───▶ scripts/  (deterministic work, structured JSON out)
      ◀─result── verified outcome + findings
```

Details, the planned provider model and open design questions: [ARCHITECTURE.md](ARCHITECTURE.md).

## Skill catalog

| Skill | Status |
|---|---|
| `backend-detect` | Available |
| `backend-planner` | Available (validates plans; does not generate rules, SQL or code) |
| `backend-execute` | Available |
| `provider-connect` | Available (links existing projects; no project creation) |
| `firebase-setup`, `firebase-auth`, `firestore-setup` | Planned 0.3.0 |
| `supabase-setup`, `supabase-auth`, `supabase-database`, `supabase-rls` | Planned 0.4.0 |
| Storage skills, `security-audit`, `backend-doctor` | Planned 0.5.0 |

## Security model

Local only, no server, no telemetry. Credentials come only from the user's own CLI login. Secret values are never written by the agent and never appear in previews, results or logs. Every change is previewed, approved, backed up and reversible. See [SECURITY.md](SECURITY.md).

## Limitations

- Static analysis only. It cannot see provider dashboard state: enabled sign-in methods, OAuth redirect URLs, deployed rules, live RLS status.
- Source detection is regex-based and misses computed dynamic imports and build-time generated code.
- Only `package.json` and `pubspec.yaml` ecosystems are covered.
- No auth, database, storage or rules setup yet. No project creation.
- Firebase project listing has been tested only with a fake CLI. Against the real CLI, only the "not logged in" path is verified.
- Rolling back an install restores `package.json` and the lockfile but leaves `node_modules`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [DEVELOPMENT.md](DEVELOPMENT.md).

## License

[MIT](LICENSE)
