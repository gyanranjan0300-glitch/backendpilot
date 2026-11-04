// Detection rules. Each rule lists independent signals; the scanner records every signal it finds as evidence.
// deps: npm package names ("@scope/*" = prefix match). Dart/Flutter packages are prefixed "pub:".
// files: regexes tested against repo-relative POSIX paths.
// source: regexes tested against source file contents.

/**
 * @typedef {'framework'|'runtime'|'backend'|'auth'|'authMethod'|'database'|'storage'|'functions'|'routing'|'state'} Category
 * @typedef {{ id: string, name: string, category: Category, provider?: string, deps?: string[], files?: RegExp[], source?: RegExp[] }} Rule
 */

/** Match a file name or path suffix anywhere in the tree. @param {string} p */
const at = (p) => new RegExp(`(^|/)${p}$`);
const config = (/** @type {string} */ name) => at(`${name}\\.config\\.(js|mjs|cjs|ts|mts)`);
/** @param {string} mod */
const imports = (mod) => new RegExp(`(from\\s+|require\\(\\s*|import\\(\\s*|import\\s+)['"]${mod}['"]`);

/** @type {Rule[]} */
export const RULES = [
  // Frameworks
  { id: 'nextjs', name: 'Next.js', category: 'framework', deps: ['next'], files: [config('next')] },
  { id: 'react', name: 'React', category: 'framework', deps: ['react'] },
  { id: 'vue', name: 'Vue', category: 'framework', deps: ['vue'], files: [/\.vue$/] },
  { id: 'nuxt', name: 'Nuxt', category: 'framework', deps: ['nuxt'], files: [config('nuxt')] },
  { id: 'angular', name: 'Angular', category: 'framework', deps: ['@angular/core'], files: [at('angular\\.json')] },
  { id: 'svelte', name: 'Svelte', category: 'framework', deps: ['svelte'], files: [/\.svelte$/, config('svelte')] },
  { id: 'sveltekit', name: 'SvelteKit', category: 'framework', deps: ['@sveltejs/kit'] },
  { id: 'astro', name: 'Astro', category: 'framework', deps: ['astro'], files: [config('astro')] },
  { id: 'vite', name: 'Vite', category: 'framework', deps: ['vite'], files: [config('vite')] },
  { id: 'flutter', name: 'Flutter', category: 'framework', deps: ['pub:flutter'] },

  // Runtimes and server frameworks
  { id: 'nodejs', name: 'Node.js project (package.json)', category: 'runtime', files: [at('package\\.json')] },
  { id: 'express', name: 'Express', category: 'runtime', deps: ['express'] },
  { id: 'nestjs', name: 'NestJS', category: 'runtime', deps: ['@nestjs/core'], files: [at('nest-cli\\.json')] },
  { id: 'fastify', name: 'Fastify', category: 'runtime', deps: ['fastify'] },
  { id: 'hono', name: 'Hono', category: 'runtime', deps: ['hono'] },

  // Backend platforms
  {
    id: 'firebase', name: 'Firebase', category: 'backend', provider: 'firebase',
    deps: ['firebase', 'firebase-admin', 'firebase-functions', 'reactfire', 'pub:firebase_core'],
    files: [at('firebase\\.json'), at('\\.firebaserc'), at('google-services\\.json'), at('GoogleService-Info\\.plist'), at('firestore\\.rules'), at('storage\\.rules')],
    source: [imports('firebase/app'), imports('firebase-admin'), imports('firebase-admin/app'), /package:firebase_core\//],
  },
  {
    id: 'supabase', name: 'Supabase', category: 'backend', provider: 'supabase',
    deps: ['@supabase/supabase-js', '@supabase/ssr', '@supabase/auth-helpers-*', 'supabase', 'pub:supabase_flutter'],
    files: [at('supabase/config\\.toml')],
    source: [imports('@supabase/supabase-js'), imports('@supabase/ssr'), /package:supabase_flutter\//],
  },
  { id: 'appwrite', name: 'Appwrite', category: 'backend', provider: 'appwrite', deps: ['appwrite', 'node-appwrite', 'pub:appwrite'], files: [at('appwrite\\.json')] },
  { id: 'convex', name: 'Convex', category: 'backend', provider: 'convex', deps: ['convex'] },
  { id: 'pocketbase', name: 'PocketBase', category: 'backend', provider: 'pocketbase', deps: ['pocketbase', 'pub:pocketbase'] },

  // Authentication libraries / services
  { id: 'firebase-auth', name: 'Firebase Authentication', category: 'auth', provider: 'firebase', deps: ['pub:firebase_auth'], source: [imports('firebase/auth'), imports('firebase-admin/auth'), /package:firebase_auth\//] },
  { id: 'supabase-auth', name: 'Supabase Auth', category: 'auth', provider: 'supabase', source: [/\.auth\.(signInWithPassword|signUp|signInWithOAuth|signInWithOtp|getSession|getUser|onAuthStateChange)\(/] },
  { id: 'authjs', name: 'Auth.js / NextAuth', category: 'auth', deps: ['next-auth', '@auth/*'] },
  { id: 'clerk', name: 'Clerk', category: 'auth', deps: ['@clerk/*'] },
  { id: 'auth0', name: 'Auth0', category: 'auth', deps: ['auth0', '@auth0/*'] },
  { id: 'passport', name: 'Passport', category: 'auth', deps: ['passport'] },
  { id: 'better-auth', name: 'Better Auth', category: 'auth', deps: ['better-auth'] },
  { id: 'lucia', name: 'Lucia', category: 'auth', deps: ['lucia'] },

  // Sign-in methods in use (source-level only; dashboard settings are not visible from the repo)
  { id: 'email-password', name: 'Email/password sign-in', category: 'authMethod', source: [/\b(signInWithEmailAndPassword|createUserWithEmailAndPassword|signInWithPassword|CredentialsProvider)\b/] },
  { id: 'google', name: 'Google sign-in', category: 'authMethod', deps: ['pub:google_sign_in'], source: [/\bGoogleAuthProvider\b/, /provider:\s*['"]google['"]/, /\bGoogleProvider\b/, /next-auth\/providers\/google/] },
  { id: 'github', name: 'GitHub sign-in', category: 'authMethod', source: [/\bGithubAuthProvider\b/, /provider:\s*['"]github['"]/, /\bGitHubProvider\b/, /next-auth\/providers\/github/] },

  // Databases and clients
  { id: 'firestore', name: 'Cloud Firestore', category: 'database', provider: 'firebase', deps: ['pub:cloud_firestore'], files: [at('firestore\\.rules'), at('firestore\\.indexes\\.json')], source: [imports('firebase/firestore'), imports('firebase/firestore/lite'), imports('firebase-admin/firestore'), /package:cloud_firestore\//] },
  { id: 'firebase-rtdb', name: 'Firebase Realtime Database', category: 'database', provider: 'firebase', deps: ['pub:firebase_database'], files: [at('database\\.rules\\.json')], source: [imports('firebase/database'), imports('firebase-admin/database')] },
  { id: 'supabase-postgres', name: 'Supabase Postgres', category: 'database', provider: 'supabase', files: [/(^|\/)supabase\/migrations\/[^/]+\.sql$/], source: [/\.from\(\s*['"][\w.-]+['"]\s*\)\s*\.\s*(select|insert|update|upsert|delete)\(/] },
  { id: 'prisma', name: 'Prisma', category: 'database', deps: ['prisma', '@prisma/client'], files: [at('schema\\.prisma')] },
  { id: 'drizzle', name: 'Drizzle ORM', category: 'database', deps: ['drizzle-orm'], files: [config('drizzle')] },
  { id: 'mongoose', name: 'Mongoose', category: 'database', deps: ['mongoose'] },
  { id: 'mongodb', name: 'MongoDB driver', category: 'database', deps: ['mongodb'] },
  { id: 'pg', name: 'node-postgres', category: 'database', deps: ['pg', 'postgres', '@neondatabase/serverless'] },
  { id: 'mysql', name: 'MySQL client', category: 'database', deps: ['mysql2', 'mysql'] },
  { id: 'typeorm', name: 'TypeORM', category: 'database', deps: ['typeorm'] },
  { id: 'sequelize', name: 'Sequelize', category: 'database', deps: ['sequelize'] },
  { id: 'knex', name: 'Knex', category: 'database', deps: ['knex'] },
  { id: 'kysely', name: 'Kysely', category: 'database', deps: ['kysely'] },
  { id: 'sqlite', name: 'SQLite client', category: 'database', deps: ['better-sqlite3', 'sqlite3'] },
  { id: 'redis', name: 'Redis client', category: 'database', deps: ['redis', 'ioredis', '@upstash/redis'] },

  // Storage
  { id: 'firebase-storage', name: 'Cloud Storage for Firebase', category: 'storage', provider: 'firebase', deps: ['pub:firebase_storage'], files: [at('storage\\.rules')], source: [imports('firebase/storage'), imports('firebase-admin/storage'), /package:firebase_storage\//] },
  { id: 'supabase-storage', name: 'Supabase Storage', category: 'storage', provider: 'supabase', source: [/\.storage\s*\.from\(/] },
  { id: 's3', name: 'Amazon S3', category: 'storage', deps: ['@aws-sdk/client-s3'] },
  { id: 'cloudinary', name: 'Cloudinary', category: 'storage', deps: ['cloudinary'] },
  { id: 'uploadthing', name: 'UploadThing', category: 'storage', deps: ['uploadthing'] },
  { id: 'vercel-blob', name: 'Vercel Blob', category: 'storage', deps: ['@vercel/blob'] },

  // Server-side functions
  { id: 'firebase-functions', name: 'Cloud Functions for Firebase', category: 'functions', provider: 'firebase', deps: ['firebase-functions'] },
  { id: 'supabase-edge-functions', name: 'Supabase Edge Functions', category: 'functions', provider: 'supabase', files: [/(^|\/)supabase\/functions\/[^/]+\/index\.(ts|js)$/] },

  // Routing (needed later to wire protected routes into existing conventions)
  { id: 'next-app-router', name: 'Next.js App Router', category: 'routing', files: [/(^|\/)app\/(.+\/)?(page|layout)\.(jsx?|tsx?)$/] },
  { id: 'next-pages-router', name: 'Next.js Pages Router', category: 'routing', files: [/(^|\/)pages\/_app\.(jsx?|tsx?)$/] },
  { id: 'react-router', name: 'React Router', category: 'routing', deps: ['react-router-dom', 'react-router'] },
  { id: 'tanstack-router', name: 'TanStack Router', category: 'routing', deps: ['@tanstack/react-router'] },
  { id: 'vue-router', name: 'Vue Router', category: 'routing', deps: ['vue-router'] },
  { id: 'go-router', name: 'go_router', category: 'routing', deps: ['pub:go_router'] },

  // State management
  { id: 'redux', name: 'Redux', category: 'state', deps: ['redux', '@reduxjs/toolkit'] },
  { id: 'zustand', name: 'Zustand', category: 'state', deps: ['zustand'] },
  { id: 'jotai', name: 'Jotai', category: 'state', deps: ['jotai'] },
  { id: 'pinia', name: 'Pinia', category: 'state', deps: ['pinia'] },
  { id: 'mobx', name: 'MobX', category: 'state', deps: ['mobx'] },
  { id: 'tanstack-query', name: 'TanStack Query', category: 'state', deps: ['@tanstack/react-query', '@tanstack/vue-query'] },
  { id: 'riverpod', name: 'Riverpod', category: 'state', deps: ['pub:flutter_riverpod', 'pub:riverpod'] },
  { id: 'flutter-bloc', name: 'flutter_bloc', category: 'state', deps: ['pub:flutter_bloc'] },
];

/** @type {Category[]} */
export const CATEGORIES = ['framework', 'runtime', 'backend', 'auth', 'authMethod', 'database', 'storage', 'functions', 'routing', 'state'];

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit',
  '.astro', '.turbo', '.vercel', '.netlify', '.cache', 'coverage', '.dart_tool', '.angular', 'vendor', 'Pods', '.gradle', '.idea', '.vscode',
  // Agent config dirs: skills (including this one) are installed here and contain SDK names as text.
  '.claude', '.kiro', '.cursor',
  // backend-execute backups: copies of project files would duplicate detections.
  '.backendpilot',
]);

/** @type {Record<string, string>} lockfile name -> package manager */
export const LOCKFILES = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'pubspec.lock': 'pub',
};

/** Files that define a database schema or migration. */
export const SCHEMA_FILES = [
  { kind: 'prisma', pattern: at('schema\\.prisma') },
  { kind: 'supabase-migration', pattern: /(^|\/)supabase\/migrations\/[^/]+\.sql$/ },
  { kind: 'sql-migration', pattern: /(^|\/)(migrations|drizzle)\/.*\.sql$/ },
  { kind: 'firestore-indexes', pattern: at('firestore\\.indexes\\.json') },
];

/** Admin credential files that must never be committed or bundled into a client. */
export const CREDENTIAL_FILES = [/(^|\/)[^/]*service[-_]?account[^/]*\.json$/i, /(^|\/)[^/]*firebase-adminsdk[^/]*\.json$/i];
