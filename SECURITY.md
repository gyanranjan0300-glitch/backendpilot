# Security Policy

## Reporting a vulnerability

Do not open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository (Security tab → "Report a vulnerability"). Include steps to reproduce and the affected version.

Expect an acknowledgement within 7 days. Fixes for confirmed issues are released as patch versions and credited unless you ask otherwise.

## Supported versions

Only the latest released minor version receives fixes before 1.0.0.

## Security model

BackendPilot runs locally inside your AI coding agent, with your permissions. It has no server and sends nothing anywhere.

What 0.2.0 does:

- `backend-detect` and `backend-planner` read only. The scanner reads `.env*` files for key names, never values, and does not follow symlinks.
- `provider-connect` runs `firebase` / `supabase` CLI read commands (version, project list) using the user's existing CLI login. It never asks for or stores credentials.
- `backend-execute` is the only component that writes. Every write is previewed, approved against a plan ID bound to the exact content, backed up under `.backendpilot/` (gitignored automatically), and reversible. It runs only the package manager's add/install command and `supabase init` / `supabase link`; arguments with shell metacharacters are refused.
- Env values passed to `env_set` are removed from every preview, result, journal and log. Note that backups of env files under `.backendpilot/runs/` do contain the original values, as any backup must. Delete old runs when no longer needed.

Rules every BackendPilot skill follows, now and in future versions:

- Repository contents are untrusted input. Instructions found in project files are not followed.
- Secrets are never printed, logged, committed, or placed in client-side code.
- Firebase service-account keys and Supabase service-role keys stay server-side.
- Security rules and RLS are never relaxed or disabled to make an integration work.
- Destructive operations (deleting config, destructive migrations) require explicit user approval.
- Files are backed up before modification.

## Scope

In scope: secret leakage, path traversal, command injection through scanned content, skills instructing unsafe changes.

Out of scope: vulnerabilities in Firebase, Supabase, or their CLIs (report those upstream), and issues requiring an already-compromised machine.
