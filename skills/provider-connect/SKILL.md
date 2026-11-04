---
name: provider-connect
description: Connects a local project to an existing Firebase or Supabase cloud project using the official CLI and the user's own login. Checks whether the CLI is installed and logged in, lists the projects the account can access, and produces a change set that sets the Firebase default project or runs supabase init/link. Use when the user wants to connect, link, or choose a Firebase or Supabase project.
license: MIT
compatibility: Requires Node.js 20+, plus the Firebase CLI (firebase-tools) and/or the Supabase CLI. Needs network access to the provider. Works with the backend-execute skill to apply changes.
metadata:
  author: backendpilot
  version: "0.2.0"
---

# provider-connect

Find out which cloud projects the user can access and link one to the local project. This skill never writes files itself; it outputs a change set for **backend-execute**.

## Prerequisites

- Firebase: `npm install -g firebase-tools`. Supabase: `npm install -g supabase` or another method from the Supabase docs.
- The user is logged in with the CLI (`firebase login` / `supabase login`), which they run **in their own terminal**. Login opens a browser.

## Workflow

1. Check status and list projects (`<provider>` is `firebase` or `supabase`):

   ```
   node <skill-dir>/scripts/connect.mjs <provider> projects --root <projectRoot>
   ```

2. Act on the result:
   - `cli.installed: false`: tell the user the install command from `next`. Stop.
   - `auth.loggedIn: false`: ask the user to run `firebase login` or `supabase login` themselves, then rerun step 1. Never ask for, type, or store their password or token.
   - `projects`: show the user the IDs and names and ask which one to use. Do not pick one for them. If none fits, they create one in the provider console (creating projects is not automated in this version).

3. Build the change set for the chosen project:

   ```
   node <skill-dir>/scripts/connect.mjs <provider> select <projectId> --root <projectRoot> --out .backendpilot/changes/connect.json
   ```

   - Firebase: a `json_merge` of `{"projects":{"default":"<id>"}}` into `.firebaserc` (same effect as `firebase use <id>`).
   - Supabase: `supabase init` (only if `supabase/config.toml` is missing), then `supabase link --project-ref <ref>`.

4. Apply it with **backend-execute** (preview, user approval, apply).

5. Report the result and every item in the change set's `manual_actions`.

## Rules

- Credentials come only from the user's CLI login. A Firebase web `apiKey` or a Supabase anon/publishable key is a public client identifier. It does not grant admin access, and it is never used for project management.
- Never pass the Supabase database password in a change set or command. If a later command needs it, the user types it at the CLI prompt.
- Do not run `firebase use --add`, `firebase init`, or other interactive commands for the user. They hang without a terminal.

## Error handling

| Output | Cause | Action |
|---|---|---|
| exit 2, "not visible to the logged-in account" | Wrong ID or wrong account | Show visible IDs; ask the user |
| `auth.loggedIn: null` with a CLI error | Network, CLI bug, or permissions | Report `auth.detail` as-is |
| engine `failed`, "project is paused" | Supabase project paused | User restores it in the dashboard; the engine already rolled back |

## Expected output

`projects`: `{ provider, cli: { installed, version }, auth: { loggedIn, detail }, projects: [{ id, name, extra }], next: [...] }`. Exit code 1 when not logged in.

`select`: a change set (see backend-execute's `references/change-set.md`) with `manual_actions`.

## Limits

- Project creation, Firebase app registration, and fetching SDK config are not automated yet.
- Verified with fake CLIs in the test suite. Against the real CLIs: Supabase project listing and a failed `link` (paused project, with rollback) have been verified. Firebase project listing against a logged-in account has not yet been verified.
