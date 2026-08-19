/**
 * The credential store.
 *
 * Every rule in here was learned the hard way in one of our other CLIs, and
 * each is a one-line change away from being wrong again:
 *
 * - **0600, set twice.** `writeFile`'s `mode` only applies when the file is
 *   *created*, so a file that already exists keeps whatever permissions it had.
 *   The explicit `chmod` after the write is what actually tightens it.
 * - **Write to a temp file and rename.** A crash mid-write must not leave a
 *   truncated credentials file, and the token must never exist on disk at
 *   default permissions, not even briefly.
 * - **Merge, never clobber.** One of our CLIs writes `{apiKey}` wholesale, so
 *   the day a second setting is added, rotating a key silently deletes it.
 * - **Credentials are endpoint-bound.** A token issued by one server is never
 *   sent to another. See `resolveCredential`.
 */

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthError, ConfigError } from './errors.ts';

export const DEFAULT_PROFILE = 'default';

export interface StoredCredential {
  /** Opaque bearer token. */
  token: string;
  /**
   * The API origin this token was issued for.
   *
   * Stored so it can be checked at use time. A token for
   * `https://api.example.com` must never be sent to a host a project-local
   * config happens to name.
   */
  baseUrl: string;
  /** Display only — who the user is signed in as. Never used for authorization. */
  account?: { id?: string; name?: string; email?: string };
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, when the server said so. */
  expiresAt?: string;
}

export interface CredentialsFile {
  version: 1;
  /** Keyed by profile name, so work and personal accounts coexist. */
  profiles: Record<string, StoredCredential>;
}

const EMPTY: CredentialsFile = { version: 1, profiles: {} };

export const credentialsDir = (homeDir: string, brand: string): string =>
  join(homeDir, `.${brand}`);

export const credentialsPath = (homeDir: string, brand: string): string =>
  join(credentialsDir(homeDir, brand), 'credentials.json');

/**
 * Create the directory at 0700 **and tighten it if it already exists**.
 *
 * `mkdir`'s mode is ignored for an existing directory, so a store created
 * before this rule existed — or by an older version — would keep its loose
 * permissions forever. One of our CLIs has exactly that gap today: it hardens
 * the file on every write but the directory only on creation.
 */
const ensureDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => {
    // A directory we cannot chmod (an exotic filesystem, a mounted volume) is
    // not worth failing the command over; the file mode below is the real
    // protection.
  });
};

export const loadCredentials = async (
  homeDir: string,
  brand: string,
): Promise<CredentialsFile> => {
  const path = credentialsPath(homeDir, brand);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, profiles: {} };
    throw new ConfigError('credentials.unreadable', `Could not read ${path}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError('credentials.invalid', `${path} is not valid JSON.`, {
      hint: 'Delete the file and sign in again.',
      cause: error,
    });
  }

  if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY, profiles: {} };
  const file = parsed as Partial<CredentialsFile>;
  return { version: 1, profiles: file.profiles ?? {} };
};

/**
 * Persist the whole file at 0600.
 *
 * Exported for tests and for the rare caller that already holds a merged file;
 * ordinary code should use `saveCredential`/`deleteCredential`, which merge.
 */
export const writeCredentials = async (
  homeDir: string,
  brand: string,
  file: CredentialsFile,
): Promise<void> => {
  const directory = credentialsDir(homeDir, brand);
  await ensureDir(directory);

  const path = credentialsPath(homeDir, brand);
  const temporary = `${path}.${process.pid}.tmp`;

  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // Belt and braces: `mode` above is subject to the umask and is ignored
  // entirely if the temp file somehow already existed.
  await chmod(temporary, 0o600);

  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }

  // `rename` preserves the source's mode, but if `path` pre-existed with looser
  // permissions on a filesystem that merges rather than replaces, this is the
  // guarantee that matters.
  await chmod(path, 0o600);
};

/** Add or replace one profile, leaving every other profile untouched. */
export const saveCredential = async (
  homeDir: string,
  brand: string,
  profile: string,
  credential: StoredCredential,
): Promise<void> => {
  const file = await loadCredentials(homeDir, brand);
  file.profiles[profile] = credential;
  await writeCredentials(homeDir, brand, file);
};

/** Returns whether anything was removed, so `logout` can report honestly. */
export const deleteCredential = async (
  homeDir: string,
  brand: string,
  profile: string,
): Promise<boolean> => {
  const file = await loadCredentials(homeDir, brand);
  if (file.profiles[profile] === undefined) return false;
  delete file.profiles[profile];
  await writeCredentials(homeDir, brand, file);
  return true;
};

export interface ResolveCredentialOptions {
  profile: string;
  /** The endpoint this command is about to talk to. */
  baseUrl: string;
  /** Where `baseUrl` came from, for the error message. */
  baseUrlOrigin: string;
  /** False when `baseUrl` came from an auto-discovered project config. */
  baseUrlTrusted: boolean;
  /** An environment variable holding a token, which outranks the store. */
  envToken?: { name: string; value: string } | undefined;
  now: Date;
}

export interface ResolvedCredential {
  token: string;
  /** For display: the profile name, or the variable that supplied it. */
  source: string;
  /**
   * Where it came from, as data rather than prose.
   *
   * `source` is a sentence fragment meant for a human, and a caller that
   * needs to *act* on the difference must not go parsing it. `logout` is the
   * caller that needs it: with $TOKEN set it revokes the environment token,
   * and without this it went on to delete a stored profile credential that
   * was never used and is now live with no local copy left to revoke it.
   */
  origin: 'env' | 'profile';
}

/**
 * Decide which credential a request may use — the security-critical function
 * in this file.
 *
 * The endpoint binding is the point. Without it, a `kit.config.json` committed
 * to a repository can name an attacker's `baseUrl`, and simply running the CLI
 * inside that checkout posts your token to them. So:
 *
 * - a stored token is only ever sent to the origin it was issued for;
 * - if an explicit, trusted override names a different origin, we refuse
 *   loudly rather than silently signing in as nobody;
 * - if an **untrusted** project config names a different origin, the stored
 *   token is withheld entirely and the request proceeds unauthenticated.
 */
export const resolveCredential = (
  file: CredentialsFile,
  options: ResolveCredentialOptions,
): ResolvedCredential | undefined => {
  // An explicit environment variable is the operator saying "use this one",
  // and it is not bound to an endpoint because it was supplied per-invocation.
  if (options.envToken !== undefined && options.envToken.value !== '') {
    return { token: options.envToken.value, source: `$${options.envToken.name}`, origin: 'env' };
  }

  const stored = file.profiles[options.profile];
  if (stored === undefined) return undefined;

  if (stored.expiresAt !== undefined && Date.parse(stored.expiresAt) <= options.now.getTime()) {
    throw new AuthError('auth.expired', 'Your saved sign-in has expired.', {
      hint: 'Run `login` to sign in again.',
      details: { profile: options.profile, expiredAt: stored.expiresAt },
    });
  }

  if (sameOrigin(stored.baseUrl, options.baseUrl)) {
    return { token: stored.token, source: `profile "${options.profile}"`, origin: 'profile' };
  }

  if (!options.baseUrlTrusted) {
    // Withhold rather than throw: the command may not need auth at all, and a
    // hard failure here would let any checked-in config break the CLI.
    return undefined;
  }

  throw new AuthError(
    'auth.endpoint_mismatch',
    `Your saved sign-in is for ${stored.baseUrl} and will not be sent to ${options.baseUrl}.`,
    {
      hint: `Sign in again for that endpoint, or use a separate --profile. (${options.baseUrl} came from ${options.baseUrlOrigin}.)`,
      details: {
        profile: options.profile,
        boundTo: stored.baseUrl,
        requested: options.baseUrl,
        origin: options.baseUrlOrigin,
      },
    },
  );
};

/**
 * Origin comparison, not string comparison.
 *
 * `https://api.example.com` and `https://api.example.com/` are the same host
 * and must not be treated as different endpoints — that would produce a
 * baffling mismatch error from a trailing slash. Anything unparseable falls
 * back to exact equality rather than being treated as a match.
 */
export const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
};

/** Mode bits, for the `doctor` check that the store is still 0600. */
export const credentialsMode = async (
  homeDir: string,
  brand: string,
): Promise<number | undefined> => {
  try {
    const info = await stat(credentialsPath(homeDir, brand));
    return info.mode & 0o777;
  } catch {
    return undefined;
  }
};
