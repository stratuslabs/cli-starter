/**
 * Shared plumbing for commands that talk to the API.
 *
 * One implementation of "which endpoint, which credential" — every command
 * calls this rather than reaching into the credential store itself. That is the
 * rule from `config.ts` applied to the thing it matters most for: a second
 * copy of credential selection is a second place for the endpoint binding to be
 * forgotten.
 */

import { APP, baseUrlEnvName, resolveAuthProvider, resolveBaseUrl, tokenEnvName } from '../app.ts';
import type { RunContext } from '../kit/context.ts';
import {
  DEFAULT_PROFILE,
  loadCredentials,
  resolveCredential,
  type CredentialsFile,
} from '../kit/credentials.ts';
import { AuthError } from '../kit/errors.ts';
import { HttpClient } from '../kit/http.ts';

export interface Session {
  http: HttpClient;
  /** The provider with the endpoint override already applied to every URL. */
  provider: ReturnType<typeof resolveAuthProvider>;
  baseUrl: string;
  baseUrlOrigin: string;
  profile: string;
  /** Undefined when nothing is signed in and `require` was not set. */
  token: string | undefined;
  /** Where the token came from, for `doctor` and for error messages. */
  tokenSource: string | undefined;
  credentials: CredentialsFile;
}

export interface OpenSessionOptions {
  /** Fail with an auth error rather than returning an unauthenticated client. */
  require?: boolean;
}

export const profileName = (ctx: RunContext): string => ctx.globals.profile ?? DEFAULT_PROFILE;

export const openSession = async (
  ctx: RunContext,
  options: OpenSessionOptions = {},
): Promise<Session> => {
  const profile = profileName(ctx);
  const base = resolveBaseUrl(APP, ctx.flags);
  const credentials = await loadCredentials(ctx.env.homeDir, APP.brand);

  const envValue = ctx.env.processEnv[tokenEnvName(APP)];
  const resolved = resolveCredential(credentials, {
    profile,
    baseUrl: base.value,
    baseUrlOrigin: base.origin,
    baseUrlTrusted: base.trusted,
    ...(envValue === undefined || envValue === ''
      ? {}
      : { envToken: { name: tokenEnvName(APP), value: envValue } }),
    now: ctx.env.now(),
  });

  if (options.require === true && resolved === undefined) {
    throw new AuthError('auth.not_signed_in', `You are not signed in to ${APP.auth.displayName}.`, {
      hint: `Run \`${APP.name} login\`, or set $${tokenEnvName(APP)}.`,
      details: { profile, baseUrl: base.value },
    });
  }

  return {
    provider: resolveAuthProvider(APP, ctx.flags),
    http: new HttpClient({
      baseUrl: base.value,
      fetch: ctx.env.fetch,
      userAgent: `${APP.name}/${APP.version}`,
      ...(resolved === undefined ? {} : { token: resolved.token }),
      signal: ctx.signal,
    }),
    baseUrl: base.value,
    baseUrlOrigin: base.origin,
    profile,
    token: resolved?.token,
    tokenSource: resolved?.source,
    credentials,
  };
};

export interface Identity {
  id?: string;
  name?: string;
  email?: string;
  account?: { id?: string; name?: string; tier?: string };
}

/**
 * Ask the server who this token belongs to.
 *
 * Used by `whoami`, and by `login` to confirm the token actually works before
 * reporting success — reporting a sign-in that then fails on the next command
 * is the worst kind of false confidence.
 */
export const fetchIdentity = async (session: Session): Promise<Identity | undefined> => {
  // session.provider, never APP.auth: the latter still points at the built-in
  // default, so under --base-url it would query a host the user never named.
  if (session.provider.identityUrl === undefined) return undefined;
  return session.http.get<Identity>(session.provider.identityUrl);
};

/** How a signed-in user is described in output. */
export const describeIdentity = (identity: Identity | undefined): string => {
  if (identity === undefined) return 'an unknown account';
  const who = identity.name ?? identity.email ?? identity.id ?? 'unknown';
  return identity.account?.name === undefined ? who : `${who} (${identity.account.name})`;
};

export { baseUrlEnvName };
