# Development

## Requirements

- Node.js 20 or newer (CI tests 20, 22, 24)
- Git (some tests use it; they are skipped if it is missing)

## Setup

```sh
npm install
npm run check      # lint + typecheck + validate:skills + test
```

Individual commands:

| Command | What it does |
|---|---|
| `npm test` | `node --test`, runs `tests/*.test.mjs` |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --checkJs` over JSDoc types, no build output |
| `npm run validate:skills` | Checks every `skills/*/SKILL.md` against the Agent Skills spec and that shared copies are current |
| `npm run sync:shared` | Copies `shared/*.mjs` into each skill's `scripts/shared/`. Run after editing `shared/` |
| `BACKENDPILOT_LIVE=1 npm test` | Also runs `tests/live.test.mjs` against the real `firebase`/`supabase` CLIs (read-only). PowerShell: `$env:BACKENDPILOT_LIVE=1; npm test`. Set `BACKENDPILOT_LIVE_SUPABASE_REF` to also test link + rollback |
| `npm run scan -- <dir> [--format markdown]` | Runs the backend-detect scanner |

## Layout

```
skills/<name>/SKILL.md          instructions the agent reads
skills/<name>/scripts/          runtime code, Node stdlib only
skills/<name>/references/       docs the agent loads on demand
skills/<name>/scripts/shared/   GENERATED copies of shared/ (do not edit)
shared/                         source of truth for code used by several skills
scripts/                        repo tooling (skill validator, shared sync)
tests/                          node:test suites; tests/helpers/ has fake firebase/supabase/npm CLIs
```

## Conventions

- Skill runtime scripts use only the Node.js standard library, so a copied skill folder works without `npm install`. Dev tooling may use devDependencies.
- JavaScript ES modules with JSDoc types, checked by `tsc`.
- Tests build fixture projects in a temp directory. This keeps real `.env` files and git state out of the repo.
- Tests never need cloud credentials. Provider and install behaviour is tested with fake CLIs put on PATH. Live tests are opt-in.
- Any new skill that writes files must do so through a backend-execute change set.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/). Versions follow [SemVer](https://semver.org/).

## Adding a detection rule

1. Add an entry to `skills/backend-detect/scripts/rules.mjs` with at least one of `deps`, `files`, `source`.
2. Add a fixture assertion in `tests/backend-detect.test.mjs`.
3. If it adds a new category or finding code, update `skills/backend-detect/references/report-schema.md`.

## Adding a skill

1. Create `skills/<name>/SKILL.md`. `name` must equal the folder name.
2. Run `npm run validate:skills`.
3. Document real behaviour only. Planned features go in ROADMAP.md.

## Trying a skill in Claude Code

Copy or symlink the folder into `.claude/skills/` of a test project (or `~/.claude/skills/`), then ask Claude what backend the project uses.
