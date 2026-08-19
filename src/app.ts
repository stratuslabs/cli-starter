/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE FILE YOU EDIT FIRST.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything that makes this CLI *yours* is here: the binary name, where it
 * keeps its files, and which server it signs in to. Nothing under `src/kit/`
 * knows any of it, which is what lets you pull framework improvements from
 * upstream without re-applying your branding every time.
 *
 * `scripts/rebrand.ts` rewrites this file, the manifest, and the README from a
 * few answers. You can also just edit it by hand — it is short on purpose.
 */

import type { AuthProvider } from './kit/auth/provider.ts';
import type { FlagBag } from './kit/context.ts';
import { CLI_VERSION } from './kit/version.ts';

export interface AppConfig {
  /** The binary name, exactly as typed. Appears throughout help and errors. */
  name: string;
  /**
   * Lower-case slug for on-disk locations:
   *   `~/.<brand>/credentials.json`, `~/.<brand>/config.json`, `<brand>.config.json`
   */
  brand: string;
  version: string;
  /** One line, shown at the top of `--help`. */
  summary: string;
  /** Prefix for environment variables: `KIT_TOKEN`, `KIT_BASE_URL`, … */
  envPrefix: string;
  auth: AuthProvider;
  footer?: string;
}

/**
 * The demo configuration points at a local mock server (`test/support/`), so a
 * freshly cloned template can run `kit login` and get all the way through the
 * browser flow before you have written a line of backend.
 *
 * Override the endpoint with `KIT_BASE_URL` while developing.
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';

export const APP: AppConfig = {
  name: 'kit',
  brand: 'kit',
  version: CLI_VERSION,
  summary: 'A polished CLI, ready to be made yours.',
  envPrefix: 'KIT',
  auth: {
    displayName: 'Example',
    baseUrl: DEFAULT_BASE_URL,
    authorizeUrl: `${DEFAULT_BASE_URL}/cli/authorize`,
    tokenUrl: `${DEFAULT_BASE_URL}/api/v1/cli/token`,
    deviceCodeUrl: `${DEFAULT_BASE_URL}/api/v1/cli/device/code`,
    identityUrl: `${DEFAULT_BASE_URL}/api/v1/cli/identity`,
    revokeUrl: `${DEFAULT_BASE_URL}/api/v1/cli/revoke`,
    tokenHelpUrl: `${DEFAULT_BASE_URL}/settings/tokens`,
    clientId: 'cli-kit-demo',
    scopes: ['read', 'write'],
  },
  footer: 'Built from stratuslabs/cli-kit. Start by editing src/app.ts.',
};

/** The global flag naming the API endpoint. Declared once, in main.ts. */
export const BASE_URL_FLAG = 'base-url';

/** The environment variable holding a token, e.g. `KIT_TOKEN`. */
export const tokenEnvName = (app: AppConfig = APP): string => `${app.envPrefix}_TOKEN`;

/** The environment variable overriding the API endpoint, e.g. `KIT_BASE_URL`. */
export const baseUrlEnvName = (app: AppConfig = APP): string => `${app.envPrefix}_BASE_URL`;

/** The environment variable naming a config file, e.g. `KIT_CONFIG`. */
export const configEnvName = (app: AppConfig = APP): string => `${app.envPrefix}_CONFIG`;

/**
 * The endpoint this run will talk to, and where that came from.
 *
 * The provenance is not decoration: `credentials.ts` refuses to send a stored
 * token to an endpoint chosen by an untrusted source, and the error it raises
 * has to be able to say which source that was.
 */
/**
 * The auth provider with the endpoint override applied to **every** URL.
 *
 * This is the one implementation. Rewriting only `baseUrl` and leaving the
 * derived URLs pointing at the default is a real bug with a confusing symptom:
 * sign-in succeeds against the endpoint you asked for, and then `whoami` fails
 * with a connection error to a host you never named. Every caller that needs a
 * provider goes through here.
 */
export const resolveAuthProvider = (app: AppConfig, flags: FlagBag): AuthProvider => {
  const base = resolveBaseUrl(app, flags);
  if (base.value === app.auth.baseUrl) return app.auth;

  const swap = (url: string): string =>
    url.startsWith(app.auth.baseUrl) ? `${base.value}${url.slice(app.auth.baseUrl.length)}` : url;

  return {
    ...app.auth,
    baseUrl: base.value,
    authorizeUrl: swap(app.auth.authorizeUrl),
    tokenUrl: swap(app.auth.tokenUrl),
    ...(app.auth.deviceCodeUrl === undefined ? {} : { deviceCodeUrl: swap(app.auth.deviceCodeUrl) }),
    ...(app.auth.identityUrl === undefined ? {} : { identityUrl: swap(app.auth.identityUrl) }),
    ...(app.auth.revokeUrl === undefined ? {} : { revokeUrl: swap(app.auth.revokeUrl) }),
  };
};

/**
 * Trailing slashes are stripped here, once.
 *
 * `http://localhost:3000/` is what a browser's address bar hands you, so it is
 * what people paste. Left alone it reaches `resolveAuthProvider` and produces
 * `http://localhost:3000//api/v1/identity` — which `HttpClient` happens to
 * normalise away, because it builds URLs with `new URL`, but the auth URLs,
 * built by concatenation, do not. The symptom is an endpoint where every
 * ordinary command works and only sign-in fails.
 */
const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');

export const resolveBaseUrl = (
  app: AppConfig,
  flags: FlagBag,
): { value: string; origin: string; trusted: boolean } => {
  // The environment fallback lives on the flag definition (`env: KIT_BASE_URL`)
  // and is applied by the parser, so there is exactly one place that knows the
  // precedence and exactly one that knows the provenance. Re-checking
  // process.env here would produce a second answer that disagrees with help.
  const value = flags.string(BASE_URL_FLAG);
  if (value !== undefined && value !== '') {
    return { value: normalizeBaseUrl(value), origin: flags.origin(BASE_URL_FLAG), trusted: true };
  }
  return { value: app.auth.baseUrl, origin: 'built-in default', trusted: true };
};
