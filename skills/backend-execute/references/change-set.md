# Change set format (version 1)

```json
{
  "version": 1,
  "operation": "firebase-connect",
  "description": "One sentence the user will read in the preview.",
  "steps": [ ... ]
}
```

`operation`: lowercase id, letters, digits and hyphens. Paths are relative to the project root and use `/`.

## Step types

### create: new file (fails if it exists)

```json
{ "type": "create", "path": "src/lib/firebase.ts", "content": "..." }
```

### edit: exact find/replace in an existing file

```json
{ "type": "edit", "path": "src/main.tsx", "edits": [{ "find": "import App from './App';", "replace": "import App from './App';\nimport './lib/firebase';" }] }
```

Each `find` must occur exactly once. Include enough surrounding text to make it unique. `\n` in find/replace matches the file's own line endings (CRLF files stay CRLF).

### json_merge: deep-merge into a JSON file (creates it unless `"create": false`)

```json
{ "type": "json_merge", "path": "firebase.json", "merge": { "firestore": { "rules": "firestore.rules" } } }
```

Objects merge recursively; arrays and scalars replace. Indentation, line endings and BOM are preserved. Files with comments (JSONC) are refused; use `edit`.

### env_set: add missing keys to a .env file

```json
{ "type": "env_set", "path": ".env.local", "values": { "VITE_FIREBASE_PROJECT_ID": "my-app", "SUPABASE_SERVICE_ROLE_KEY": "" } }
```

- Existing keys are never overwritten (reported as a warning).
- Secret-looking names (`SECRET`, `SERVICE_ROLE`, `PASSWORD`, `PRIVATE_KEY`, `DATABASE_URL`, ...) must have `""`. The user fills them in.
- Template files (`.env.example`, `.sample`, `.template`) must have `""` for every key.
- In a git repo, non-template env files must already be ignored by git.
- Values never appear in previews, results or logs.

### install: add npm packages

```json
{ "type": "install", "packages": ["firebase@^11"], "dev": false, "manager": "npm", "cwd": "apps/web" }
```

`manager` (npm, pnpm, yarn, bun) defaults to the one whose lockfile is present. Packages must be registry names with an optional version range; URLs, paths and git refs are refused. Verified by checking `package.json` and `node_modules`.

### command: allowlisted CLI commands

```json
{ "type": "command", "bin": "supabase", "args": ["init"] }
{ "type": "command", "bin": "supabase", "args": ["link", "--project-ref", "abcdefghijklmnopqrst"] }
```

Nothing else is allowed. Files the command writes under `supabase/` (init) or `supabase/.temp/` (link) are recorded so rollback can remove or restore them.

## Order and simulation

Steps run in order. Later steps see earlier steps' output in the preview, so `create` then `edit` on the same file works.
