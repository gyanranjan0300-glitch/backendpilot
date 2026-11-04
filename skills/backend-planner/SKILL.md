---
name: backend-planner
description: Turns a product requirement into a reviewable backend plan for Firebase or Supabase, covering database and schema, access policies, authentication, storage buckets, dependencies, env vars, ordered steps, and manual dashboard actions, then validates it for security and consistency before anything is changed. Use when the user describes an app or feature that needs a backend, auth, database or storage, before any setup work.
license: MIT
compatibility: Requires Node.js 20 or newer. Works best after the backend-detect skill has produced a report. No network access.
metadata:
  author: backendpilot
  version: "0.2.0"
---

# backend-planner

Design first, change nothing. You write the plan; the checker enforces the rules; the user approves it.

## Workflow

1. Run **backend-detect** on the project and save the JSON report (e.g. `.backendpilot/detect.json`).

2. Clarify before planning. Ask only what changes the design, for example:
   - Firebase or Supabase, if the project has neither, or has both.
   - Which sign-in methods.
   - Who may read and write each kind of data (owner only? shared? public?).
   - What file uploads are expected (types, max size, public or private).

3. Write the plan as JSON following [references/plan-schema.md](references/plan-schema.md) to `.backendpilot/plan.json`. Reuse what exists: the detected router, state library, package manager, and any existing backend.

4. Validate:

   ```
   node <skill-dir>/scripts/check-plan.mjs .backendpilot/plan.json --report .backendpilot/detect.json
   ```

   Exit 0 = valid, 3 = must fix. Fix every error, re-run, and repeat until it is valid. Don't remove an access rule to get past the checker. Ask the user instead.

5. Show the user the Markdown output (tables, warnings, steps, manual actions) and ask them to approve the plan.

6. After approval, carry out the steps in order:
   - `automated` steps: run that skill. Every file change goes through **backend-execute**, with its own preview and approval.
   - `planned` steps: the skill does not exist yet. Say so. If the user wants, write a backend-execute change set by hand for that step. Never claim it was automated.
   - `manual` steps and `manual_actions`: give the user the checklist; you cannot do these.

## Rules

- Every database entity and storage bucket has an explicit read and write rule. Public writes are never planned.
- Owner-based access must name the owner field; storage owner writes use a `{uid}` path.
- Secrets are `exposure: "server"` and never get a browser-exposed prefix. `firebase-admin` is server-only.
- Approving a plan does not approve changes. Each change set is previewed and approved separately.

## Expected output

Markdown summary (default) or `--format json`: `{ valid, errors, warnings, manual_actions, steps: [{ n, title, skill, kind: automated|planned|manual, approval }] }`.

## Limits

- The checker validates structure and security rules; it does not judge whether the design suits the product. That's for you and the user.
- It does not generate Firestore rules, SQL, or app code yet. Those are planned skills (`firestore-security-rules`, `supabase-schema`, `supabase-rls`, auth skills).
