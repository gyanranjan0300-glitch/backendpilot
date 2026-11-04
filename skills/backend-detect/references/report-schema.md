# backend-detect report schema (schemaVersion 1)

All paths are relative to `root` and use `/` separators on every OS.

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "backendpilot/backend-detect", "version": "0.1.0" },
  "root": "/abs/path/to/project",
  "scannedAt": "ISO-8601 timestamp",
  "stats": { "filesListed": 412, "sourceFilesRead": 120, "truncated": false },
  "git": { "isRepo": true },
  "languages": ["typescript"],                    // typescript | javascript | dart
  "packageManagers": [{ "name": "pnpm", "evidence": "pnpm-lock.yaml" }],
  "manifests": ["package.json"],
  "detections": {
    // One array per category:
    // framework, runtime, backend, auth, authMethod, database, storage, functions, routing, state
    "backend": [
      {
        "id": "firebase",
        "name": "Firebase",
        "provider": "firebase",                   // present when tied to a backend platform
        "confidence": "high",                     // high = 2+ signal types, medium = 1
        "evidence": [
          { "type": "dependency", "detail": "firebase", "file": "package.json" },
          { "type": "file", "detail": "firebase.json", "file": "firebase.json" },
          { "type": "source", "detail": "from 'firebase/app'", "file": "src/lib/firebase.ts" }
        ]
      }
    ]
  },
  "providers": {
    "firebase": {
      "detected": true,
      "projectId": "my-app",                      // from .firebaserc "default", else null
      "configFiles": ["firebase.json", "firestore.rules"],
      "firebaseJsonKeys": ["firestore", "hosting"],
      "services": ["firebase-auth", "firestore"],
      "notes": []
    },
    "supabase": {
      "detected": false,
      "localProjectId": null,                     // project_id from supabase/config.toml
      "configFile": null,
      "migrations": 0,
      "services": [],
      "notes": []
    }
  },
  "env": {
    "files": [
      {
        "path": ".env.local",
        "template": false,                        // true for .env.example / .sample / .template
        "keys": [{ "name": "VITE_FIREBASE_API_KEY", "hasValue": true }],   // never values
        "gitTracked": false,                      // null when git is unavailable
        "gitIgnored": true
      }
    ],
    "referenced": [{ "name": "VITE_FIREBASE_API_KEY", "files": ["src/lib/firebase.ts"] }],
    "missing": [],                                // referenced, not set in a non-template env file
    "documentedOnly": []                          // in a template, not set in a real env file
  },
  "schemas": [{ "kind": "prisma", "file": "prisma/schema.prisma" }],
  "findings": [
    { "severity": "critical", "code": "ENV_FILE_COMMITTED", "message": "...", "file": ".env" }
  ]
}
```

## Finding codes

| Code | Severity | Meaning |
|---|---|---|
| `ENV_FILE_COMMITTED` | critical | A non-template `.env*` file is tracked by git. |
| `SECRET_EXPOSED_TO_CLIENT` | critical | A variable with a browser-exposed prefix (`VITE_`, `NEXT_PUBLIC_`, ...) has a secret-looking name (`SERVICE_ROLE`, `SECRET`, `PRIVATE_KEY`, ...). |
| `ADMIN_CREDENTIAL_FILE` | critical / high | A service-account JSON file is in the project (critical if git-tracked). |
| `ENV_FILE_NOT_IGNORED` | high | A non-template `.env*` file is not matched by `.gitignore`. |
| `MULTIPLE_BACKENDS` | warning | More than one backend platform detected. |
| `MULTIPLE_PACKAGE_MANAGERS` | warning | Lockfiles from more than one JS package manager. |
| `INVALID_JSON` | warning | A JSON config could not be parsed and was skipped. |
| `SCAN_TRUNCATED` | warning | File limit reached. |
| `ENV_NOT_DEFINED_LOCALLY` | info | Env vars referenced in code but not in any local env file. |
