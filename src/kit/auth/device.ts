/**
 * Device authorization grant (RFC 8628) — sign-in for machines with no browser.
 *
 * This is the flow for SSH sessions, containers, and headless servers, and it
 * is not a nice-to-have: without it, signing in on a remote box means pasting a
 * long-lived token over the wire by hand, which is exactly the practice this
 * CLI exists to replace.
 *
 * The CLI shows a short code, the human types it into a browser *on whatever
 * device they like*, and the CLI polls until it is approved.
 */

import { AuthError, InterruptedError, NetworkError } from '../errors.ts';
import { toAuthResult, type AuthProvider, type AuthResult, type TokenResponse } from './provider.ts';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Used when the server does not state one. RFC 8628 §3.5 names 5 seconds. */
export const DEFAULT_POLL_INTERVAL_S = 5;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Same page with the code pre-filled — worth opening when we can. */
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

export interface DeviceLoginOptions {
  provider: AuthProvider;
  fetch: typeof globalThis.fetch;
  /** Called once, with everything the human needs to see. */
  onPrompt(details: DeviceCodeResponse): void | Promise<void>;
  signal?: AbortSignal | undefined;
  /** Injected so tests do not actually wait. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/**
 * Deliberately **not** `unref`'d.
 *
 * An unref'd timer does not hold the event loop open, so once the initial HTTP
 * connection goes idle Node is free to exit while this promise is still
 * pending — the process dies mid-poll and device sign-in never completes. The
 * wait between polls is work, not background upkeep.
 */
export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const postForm = async (
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: URLSearchParams,
  signal: AbortSignal | undefined,
): Promise<{ status: number; payload: Record<string, unknown> }> => {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw new NetworkError('auth.device_unreachable', 'Could not reach the sign-in server.', {
      cause: error,
    });
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, payload };
};

export const deviceLogin = async (options: DeviceLoginOptions): Promise<AuthResult> => {
  const { provider } = options;
  if (provider.deviceCodeUrl === undefined) {
    throw new AuthError('auth.no_device_flow', `${provider.displayName} does not support device sign-in.`, {
      hint: 'Sign in without --device, or paste a token with --token -.',
    });
  }

  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  // A function, not a narrowed boolean: the flag changes while we await, and
  // TypeScript would otherwise carry a stale `false` across the sleep.
  const aborted = (): boolean => options.signal?.aborted === true;

  const start = await postForm(
    options.fetch,
    provider.deviceCodeUrl,
    new URLSearchParams({
      client_id: provider.clientId,
      ...(provider.scopes === undefined ? {} : { scope: provider.scopes.join(' ') }),
    }),
    options.signal,
  );

  if (start.status >= 400) {
    throw new AuthError(
      'auth.device_start_failed',
      String(start.payload['error_description'] ?? start.payload['error'] ?? 'Could not start device sign-in.'),
    );
  }

  const details = start.payload as unknown as DeviceCodeResponse;
  if (typeof details.device_code !== 'string' || typeof details.user_code !== 'string') {
    throw new AuthError('auth.device_start_failed', 'The server did not return a device code.');
  }

  await options.onPrompt(details);

  // The server's interval is a floor, not a suggestion: polling faster earns a
  // `slow_down`, and ignoring that earns a ban.
  let intervalS = details.interval ?? DEFAULT_POLL_INTERVAL_S;
  const deadline = now() + (details.expires_in ?? 900) * 1000;

  for (;;) {
    if (aborted()) throw new InterruptedError();
    await sleep(intervalS * 1000);
    if (aborted()) throw new InterruptedError();

    if (now() > deadline) {
      throw new AuthError('auth.device_expired', 'The sign-in code expired before it was approved.', {
        hint: 'Run the command again to get a new code.',
      });
    }

    const poll = await postForm(
      options.fetch,
      provider.tokenUrl,
      new URLSearchParams({
        grant_type: DEVICE_GRANT_TYPE,
        client_id: provider.clientId,
        device_code: details.device_code,
      }),
      options.signal,
    );

    const error = typeof poll.payload['error'] === 'string' ? poll.payload['error'] : undefined;

    if (error === 'authorization_pending') continue;

    if (error === 'slow_down') {
      // RFC 8628 §3.5: add five seconds each time we are told to back off.
      intervalS += 5;
      continue;
    }

    if (error === 'access_denied') {
      throw new AuthError('auth.denied', 'The sign-in request was declined.');
    }

    if (error === 'expired_token') {
      throw new AuthError('auth.device_expired', 'The sign-in code expired before it was approved.', {
        hint: 'Run the command again to get a new code.',
      });
    }

    if (error !== undefined) {
      throw new AuthError(
        'auth.device_failed',
        String(poll.payload['error_description'] ?? error),
      );
    }

    const result = toAuthResult(poll.payload as TokenResponse);
    if (result !== undefined) return result;

    if (poll.status >= 400) {
      throw new AuthError('auth.device_failed', `The sign-in server returned HTTP ${poll.status}.`);
    }
  }
};

/**
 * Whether this machine can plausibly open a browser.
 *
 * Used to pick the device flow automatically rather than opening a browser
 * into the void and timing out five minutes later. Conservative on purpose:
 * a wrong "yes" wastes the user's time, a wrong "no" only costs them a code
 * to type.
 */
export const canOpenBrowser = (
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): boolean => {
  if (env['SSH_CONNECTION'] !== undefined || env['SSH_TTY'] !== undefined) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  // On Linux an opener needs a display server to open onto.
  return env['DISPLAY'] !== undefined || env['WAYLAND_DISPLAY'] !== undefined;
};
