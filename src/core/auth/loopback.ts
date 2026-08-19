/**
 * Browser sign-in over a loopback redirect (OAuth 2.0 authorization code +
 * PKCE, as RFC 8252 recommends for native apps).
 *
 * Shape of the flow:
 *
 *   1. listen on 127.0.0.1:0 — the OS picks a free port
 *   2. open the browser at the authorize URL, carrying the port and challenge
 *   3. the human approves in a session they already trust
 *   4. the server redirects back to the loopback with a one-time code
 *   5. exchange code + verifier for a token, over TLS, out of band
 *
 * The browser only ever sees the code, never the token.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AuthError, InterruptedError, NetworkError } from '../errors.ts';
import { createPkce, createState, safeEqual } from './pkce.ts';
import { toAuthResult, type AuthProvider, type AuthResult, type TokenResponse } from './provider.ts';

/** Long enough to find a password manager and a 2FA code; short enough to give up. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const CALLBACK_PATH = '/callback';

export interface LoopbackLoginOptions {
  provider: AuthProvider;
  fetch: typeof globalThis.fetch;
  openExternal(url: string): Promise<void>;
  /** Told the URL as soon as it is known, so the CLI can print it. */
  onUrl(url: string, opened: boolean): void;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  /** Fixed port, for tests. Production always uses an ephemeral one. */
  port?: number;
}

/**
 * Escape before interpolating into the page.
 *
 * `error_description` arrives in the callback query string, so it is attacker-
 * influenced: anyone who can get the user's browser to hit this loopback can
 * choose it. It is rendered back to them, which is a reflected-XSS shape — and
 * the page runs on a local origin, so it is worth being strict about.
 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const page = (rawTitle: string, rawMessage: string, tone: 'ok' | 'error'): string => {
  const title = escapeHtml(rawTitle);
  const message = escapeHtml(rawMessage);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background:Canvas; color:CanvasText; }
  .card { max-width:32rem; padding:2.5rem; text-align:center; }
  .mark { width:3rem; height:3rem; margin:0 auto 1.25rem; border-radius:999px;
          display:grid; place-items:center; font-size:1.5rem; color:#fff;
          background:${tone === 'ok' ? '#16a34a' : '#dc2626'}; }
  h1 { font-size:1.375rem; margin:0 0 .5rem; }
  p { margin:0; opacity:.75; }
</style></head>
<body><div class="card">
  <div class="mark">${tone === 'ok' ? '✓' : '!'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div></body></html>`;
};

const send = (response: ServerResponse, status: number, html: string): void => {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  // This page reflects nothing user-controlled, but the headers cost nothing
  // and stop a stray extension from framing or sniffing it.
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
  response.end(html);
};

/**
 * Run the flow to completion and return a token.
 *
 * Concurrency is not a problem: each invocation binds its own ephemeral port
 * and carries its own `state`, so two sign-ins running at once cannot collide
 * or steal each other's callback.
 */
export const loopbackLogin = async (options: LoopbackLoginOptions): Promise<AuthResult> => {
  const { provider } = options;
  const pkce = createPkce();
  const state = createState();

  const server = createServer();
  // 127.0.0.1, never 0.0.0.0 and never ::. Binding to a wildcard would accept
  // the callback — and therefore the authorization code — from the network.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo | null;
  if (address === null) {
    server.close();
    throw new NetworkError('loopback.bind', 'Could not open a local port to receive the sign-in.');
  }

  const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;

  const authorizeUrl = new URL(provider.authorizeUrl);
  authorizeUrl.searchParams.set('client_id', provider.clientId);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizeUrl.searchParams.set('code_challenge_method', pkce.method);
  if (provider.scopes !== undefined && provider.scopes.length > 0) {
    authorizeUrl.searchParams.set('scope', provider.scopes.join(' '));
  }

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      server.close();
      action();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new AuthError('auth.timeout', 'Timed out waiting for the browser sign-in to finish.', {
            hint: 'Run the command again, or use --device if this machine has no browser.',
          }),
        ),
      );
    }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    timer.unref?.();

    const onAbort = (): void => finish(() => reject(new InterruptedError()));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${address.port}`);

      // Browsers ask for /favicon.ico unprompted; answering it keeps the tab
      // from showing an error while the real callback is still in flight.
      if (url.pathname !== CALLBACK_PATH) {
        send(response, 404, page('Not found', 'Nothing to see here.', 'error'));
        return;
      }

      // Guard against DNS rebinding: a hostile page can point a name it
      // controls at 127.0.0.1 and have the victim's browser reach this server.
      // Loopback callers send a literal-IP Host, so anything else is not ours.
      const host = (request.headers.host ?? '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') {
        send(response, 400, page('Bad request', 'Unexpected host.', 'error'));
        return;
      }

      const error = url.searchParams.get('error');
      if (error !== null) {
        const description = url.searchParams.get('error_description') ?? error;
        send(response, 400, page('Sign-in was not completed', description, 'error'));
        finish(() =>
          reject(
            new AuthError('auth.denied', `Sign-in was not completed: ${description}`, {
              details: { error },
            }),
          ),
        );
        return;
      }

      const returnedState = url.searchParams.get('state') ?? '';
      const returnedCode = url.searchParams.get('code') ?? '';

      // Check state before anything else. A mismatch means this callback did
      // not come from the request we started, so it is not ours to act on.
      if (!safeEqual(returnedState, state)) {
        send(response, 400, page('Sign-in could not be verified', 'Please start again.', 'error'));
        finish(() =>
          reject(
            new AuthError(
              'auth.state_mismatch',
              'The sign-in response did not match the request. Nothing was saved.',
              { hint: 'Run the command again.' },
            ),
          ),
        );
        return;
      }

      if (returnedCode === '') {
        send(response, 400, page('Sign-in could not be completed', 'No code was returned.', 'error'));
        finish(() => reject(new AuthError('auth.no_code', 'The server returned no authorization code.')));
        return;
      }

      send(
        response,
        200,
        page('You are signed in', 'You can close this tab and return to your terminal.', 'ok'),
      );
      finish(() => resolve(returnedCode));
    });

    void (async () => {
      let opened = true;
      try {
        await options.openExternal(authorizeUrl.toString());
      } catch {
        // No browser, no DISPLAY, no opener binary. Not fatal: the URL still
        // works if the user can get it to a browser themselves, so keep
        // listening and let the caller print it.
        opened = false;
      }
      options.onUrl(authorizeUrl.toString(), opened);
    })();
  });

  return exchangeCode({
    provider,
    fetch: options.fetch,
    code,
    verifier: pkce.verifier,
    redirectUri,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
};

export interface ExchangeOptions {
  provider: AuthProvider;
  fetch: typeof globalThis.fetch;
  code: string;
  verifier: string;
  redirectUri: string;
  signal?: AbortSignal;
}

/** Redeem the one-time code for a token. Never goes through the browser. */
export const exchangeCode = async (options: ExchangeOptions): Promise<AuthResult> => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: options.provider.clientId,
    code: options.code,
    code_verifier: options.verifier,
    redirect_uri: options.redirectUri,
  });

  let response: Response;
  try {
    response = await options.fetch(options.provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new NetworkError('auth.exchange_failed', 'Could not reach the sign-in server.', {
      cause: error,
    });
  }

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || payload.error !== undefined) {
    throw new AuthError(
      'auth.exchange_rejected',
      payload.error_description ?? payload.error ?? `The sign-in server returned HTTP ${response.status}.`,
      { hint: 'Run the command again to start a new sign-in.' },
    );
  }

  const result = toAuthResult(payload);
  if (result === undefined) {
    throw new AuthError('auth.no_token', 'The sign-in server did not return a token.');
  }
  return result;
};
