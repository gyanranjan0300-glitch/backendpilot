// Declared provider capabilities. Copied into skills by `npm run sync:shared`.
// `bp` = what BackendPilot itself implements today. Everything else is a provider feature the plan may use
// but that must be set up manually or by a planned skill.

export const PROVIDERS = {
  firebase: {
    name: 'Firebase',
    cli: { bin: 'firebase', install: 'npm install -g firebase-tools', login: 'firebase login' },
    databases: ['firestore', 'realtime-database'],
    policyModel: 'security-rules',
    authMethods: ['email-password', 'email-link', 'google', 'github', 'microsoft', 'apple', 'phone', 'anonymous'],
    storage: true,
    functions: 'cloud-functions',
    localDev: 'firebase emulators:start',
    bp: { connect: true, selectProject: true, createProject: false, sdkConfig: false, auth: false, database: false, storage: false },
  },
  supabase: {
    name: 'Supabase',
    cli: { bin: 'supabase', install: 'npm install -g supabase (or see https://supabase.com/docs/guides/local-development/cli/getting-started)', login: 'supabase login' },
    databases: ['postgres'],
    policyModel: 'row-level-security',
    authMethods: ['email-password', 'magic-link', 'google', 'github', 'microsoft', 'apple', 'phone', 'anonymous'],
    storage: true,
    functions: 'edge-functions',
    localDev: 'supabase start',
    bp: { connect: true, selectProject: true, createProject: false, sdkConfig: false, auth: false, database: false, storage: false },
  },
};

/** @typedef {keyof typeof PROVIDERS} ProviderId */

/**
 * Dashboard steps a sign-in method needs. These cannot be done from the repo.
 * @param {string} provider @param {string} method
 * @returns {string[]}
 */
export function manualActionsFor(provider, method) {
  if (provider === 'firebase') {
    const console = 'Firebase console → Authentication → Sign-in method';
    switch (method) {
      case 'email-password': return [`Enable "Email/Password" in ${console}.`];
      case 'email-link': return [`Enable "Email link (passwordless sign-in)" under Email/Password in ${console}.`, 'Add your app domain under Authentication → Settings → Authorized domains.'];
      case 'google': return [`Enable "Google" in ${console} and set a support email.`, 'Add every domain the app runs on (besides localhost) under Authentication → Settings → Authorized domains.'];
      case 'github': return ['Create a GitHub OAuth app with callback URL https://<project-id>.firebaseapp.com/__/auth/handler.', `Enable "GitHub" in ${console} and paste the client ID and secret there (never in app code).`];
      default: return [`Enable "${method}" in ${console} and complete its provider-specific setup.`];
    }
  }
  if (provider === 'supabase') {
    const dash = 'Supabase dashboard → Authentication';
    const urls = `Set Site URL and add every redirect URL the app uses in ${dash} → URL Configuration.`;
    switch (method) {
      case 'email-password': return ['Email/password is enabled by default; confirm it under ' + dash + ' → Providers.', 'Configure custom SMTP before production (the default sender is rate-limited).', urls];
      case 'magic-link': return ['Configure custom SMTP before production.', urls];
      case 'google': return ['Create a Google OAuth client with authorized redirect URI https://<project-ref>.supabase.co/auth/v1/callback.', `Enable Google in ${dash} → Providers and paste the client ID and secret there (never in app code).`, urls];
      case 'github': return ['Create a GitHub OAuth app with callback URL https://<project-ref>.supabase.co/auth/v1/callback.', `Enable GitHub in ${dash} → Providers and paste the client ID and secret there (never in app code).`, urls];
      default: return [`Enable "${method}" in ${dash} → Providers and complete its provider-specific setup.`, urls];
    }
  }
  return [];
}
