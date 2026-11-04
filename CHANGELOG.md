# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [0.2.0] - Unreleased

### Added

- `backend-execute` skill: change-set engine with diff preview, approval bound to the previewed content, file backups, atomic writes, run journal and log, per-step verification, automatic rollback on failure, and `rollback <runId>` with conflict detection. Steps: `create`, `edit`, `json_merge`, `env_set`, `install`, allowlisted `supabase init` / `supabase link`.
- Safety checks: path traversal and symlink escapes, credentials in source files, client-exposed secrets, open Firebase rules, RLS disabled, open write policies, public tables without RLS, unignored env files.
- `provider-connect` skill: Firebase/Supabase CLI and login detection, project listing, change sets to link an existing project.
- `backend-planner` skill: plan schema and validator for auth, database access rules, storage limits, dependencies, env exposure; derives dashboard steps.
- `shared/` modules (redaction, safe CLI runner, provider capabilities) synced into skills by `npm run sync:shared`.
- Opt-in live tests (`BACKENDPILOT_LIVE=1`).

### Changed

- `backend-detect` skips `.backendpilot/`.

## [0.1.0] - Unreleased

### Added

- `backend-detect` skill: read-only scanner for frameworks, runtimes, languages, package managers, backend platforms, auth, databases, schema files, storage, functions, routing, state management and env var names, with security findings. JSON (`schemaVersion: 1`) and Markdown output.
- Agent Skills frontmatter validator (`npm run validate:skills`).
- Test suite, ESLint, `tsc --checkJs`, GitHub Actions CI on Linux, macOS and Windows.
