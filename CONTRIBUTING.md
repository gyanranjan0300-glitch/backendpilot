# Contributing

Thanks for helping. Setup and commands are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Before opening a PR

- `npm run check` passes.
- New behaviour has a test. New detection rules have a fixture assertion.
- Docs describe only what the code does. Planned work goes in [ROADMAP.md](ROADMAP.md).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Ground rules for skills

- Skill scripts must not print secret values, follow symlinks out of the project, or run commands built from repository content.
- Never weaken security rules or RLS to make something work.
- Mutating operations must back up files and require approval.

## Security issues

Report privately, see [SECURITY.md](SECURITY.md).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
