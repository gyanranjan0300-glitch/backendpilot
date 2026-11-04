# Backend plan format (version 1)

```jsonc
{
  "version": 1,
  "requirement": "What the user asked for, in their words.",
  "provider": "firebase",                       // firebase | supabase
  "rationale": "Why this provider and design fit this project.",

  "auth": {                                     // or null
    "methods": ["email-password", "google"],    // firebase: email-password, email-link, google, github, microsoft, apple, phone, anonymous
                                                // supabase: email-password, magic-link, google, github, microsoft, apple, phone, anonymous
    "features": ["password-reset", "email-verification", "session-persistence", "protected-routes", "logout", "auth-callback"],
    "integration": "Where auth state lives and how it joins the existing router/state library."
  },

  "database": {                                 // or null
    "kind": "firestore",                        // firebase: firestore | realtime-database; supabase: postgres
    "entities": [
      {
        "name": "notes",                        // postgres: snake_case identifier; firestore: collection id
        "fields": [
          { "name": "id", "type": "uuid" },
          { "name": "user_id", "type": "uuid", "references": "auth.users.id" },   // or "<entity>.<field>"
          { "name": "body", "type": "text", "required": true }
        ],
        "indexes": [["user_id", "created_at"]],
        "access": {
          "read": "owner",                      // none | owner | authenticated | public
          "write": "owner",                     // none | owner | authenticated | admin   (public is rejected)
          "ownerField": "user_id"               // required when read or write is "owner"
        }
      }
    ]
  },

  "storage": {                                  // or null
    "buckets": [
      {
        "name": "avatars",
        "public": false,                        // true requires access.read = "public"
        "maxSizeMB": 2,
        "mimeTypes": ["image/png", "image/jpeg"],
        "access": { "read": "authenticated", "write": "owner" },
        "pathPattern": "{uid}/*"                // required for owner writes
      }
    ]
  },

  "dependencies": [{ "name": "firebase", "version": "^11", "where": "client", "dev": false }],  // where: client | server
  "env": [
    { "name": "VITE_FIREBASE_API_KEY", "exposure": "client" },
    { "name": "SUPABASE_SERVICE_ROLE_KEY", "exposure": "server", "secret": true }
  ],

  "steps": [
    { "title": "Connect the Firebase project", "skill": "provider-connect" },
    { "title": "Write Firestore rules", "skill": "firestore-security-rules" },
    { "title": "Enable Google sign-in in the console", "manual": true }
  ],
  "manual_actions": ["Anything else the user must do by hand."]
}
```

## Access levels

| Level | Meaning |
|---|---|
| `none` | No client access (server/admin only) |
| `owner` | Only the user whose id is in `ownerField` (or `{uid}` path for storage) |
| `authenticated` | Any signed-in user |
| `public` | Anyone, including signed-out users (read only) |
| `admin` | Server code with admin credentials only (write only) |

## Step kinds (computed by the checker)

- `automated`: the named skill exists in this BackendPilot version (`backend-detect`, `provider-connect`, `backend-execute`, `backend-planner`).
- `planned`: the skill does not exist yet; the agent must not claim automation.
- `manual`: `"manual": true`; the user does it in a dashboard.

The checker adds the dashboard steps each sign-in method needs to `manual_actions` (e.g. OAuth redirect URIs).
