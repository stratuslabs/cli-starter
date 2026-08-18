/**
 * A minimal implementation of the sign-in endpoints this CLI expects.
 *
 * Two jobs:
 *
 * 1. **Tests.** The loopback and device flows run against it over real HTTP on
 *    localhost, so the code under test is the real code — real sockets, real
 *    redirects, real form encoding — with no network.
 * 2. **The template's first five minutes.** `npm run mock-server` makes
 *    `kit login` work end to end in a fresh clone, before the adopter has
 *    written any backend at all.
 *
 * It is also the executable specification for `docs/auth-server.md`: whatever
 * you build server-side has to satisfy the same handful of endpoints.
 *
 * Not production code. It keeps state in memory and approves everything.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockAuthServer {
  url: string;
  close(): Promise<void>;
  /** Authorization codes issued but not yet redeemed. */
  readonly pendingCodes: Map<string, PendingAuthorization>;
  /** Device codes waiting for approval; call `approveDevice` to accept one. */
  readonly pendingDevices: Map<string, { userCode: string; approved: boolean }>;
  approveDevice(userCode: string): boolean;
  /** Tokens this server considers valid. */
  readonly issuedTokens: Set<string>;
  /** Set to make the identity endpoint fail, for the unreachable-server path. */
  identityShouldFail: boolean;
}

export interface PendingAuthorization {
  challenge: string;
  redirectUri: string;
  state: string;
}

const json = (response: import('node:http').ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(payload);
};

const readBody = async (request: import('node:http').IncomingMessage): Promise<URLSearchParams> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
};

const base64url = (input: Buffer): string =>
  input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const startMockAuthServer = async (port = 0): Promise<MockAuthServer> => {
  const pendingCodes = new Map<string, PendingAuthorization>();
  const pendingDevices = new Map<string, { userCode: string; approved: boolean }>();
  const issuedTokens = new Set<string>();
  let counter = 0;
  const state = { identityShouldFail: false };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    /* ---- browser: the approval page ------------------------------------- */
    // The real thing shows the user what is being authorized and by which
    // device, behind a login. This one approves immediately and redirects.
    if (url.pathname === '/cli/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const returnedState = url.searchParams.get('state') ?? '';

      counter += 1;
      const code = `code_${counter}`;
      pendingCodes.set(code, { challenge, redirectUri, state: returnedState });

      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', returnedState);
      response.statusCode = 302;
      response.setHeader('location', target.toString());
      response.end();
      return;
    }

    /* ---- device: start --------------------------------------------------- */
    if (url.pathname === '/api/v1/cli/device/code' && request.method === 'POST') {
      counter += 1;
      const deviceCode = `device_${counter}`;
      const userCode = `WXYZ-${1000 + counter}`;
      pendingDevices.set(deviceCode, { userCode, approved: false });
      json(response, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${base(server)}/cli/device`,
        expires_in: 600,
        // Zero so tests do not wait; a real server would say 5.
        interval: 0,
      });
      return;
    }

    /* ---- token: both grant types ---------------------------------------- */
    if (url.pathname === '/api/v1/cli/token' && request.method === 'POST') {
      const body = await readBody(request);
      const grant = body.get('grant_type');

      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        const deviceCode = body.get('device_code') ?? '';
        const pending = pendingDevices.get(deviceCode);
        if (pending === undefined) {
          json(response, 400, { error: 'expired_token' });
          return;
        }
        if (!pending.approved) {
          json(response, 400, { error: 'authorization_pending' });
          return;
        }
        const token = `tok_device_${deviceCode}`;
        issuedTokens.add(token);
        json(response, 200, { access_token: token, expires_in: 3600 });
        return;
      }

      const code = body.get('code') ?? '';
      const verifier = body.get('code_verifier') ?? '';
      const pending = pendingCodes.get(code);

      if (pending === undefined) {
        // One-time use: a replayed code must fail, which is half the reason
        // codes exist.
        json(response, 400, { error: 'invalid_grant', error_description: 'Unknown or used code.' });
        return;
      }
      pendingCodes.delete(code);

      // Verify PKCE exactly as a real server must: the challenge sent in the
      // browser has to be the SHA-256 of the verifier sent here.
      const expected = base64url(createHash('sha256').update(verifier).digest());
      if (expected !== pending.challenge) {
        json(response, 400, {
          error: 'invalid_grant',
          error_description: 'The code verifier did not match.',
        });
        return;
      }

      const token = `tok_${code}`;
      issuedTokens.add(token);
      json(response, 200, {
        access_token: token,
        expires_in: 3600,
        account: { id: 'acct_1', name: 'Ada Lovelace' },
      });
      return;
    }

    /* ---- identity -------------------------------------------------------- */
    if (url.pathname === '/api/v1/cli/identity') {
      if (state.identityShouldFail) {
        response.statusCode = 503;
        response.end('{"error":"temporarily unavailable"}');
        return;
      }
      const auth = request.headers.authorization ?? '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!issuedTokens.has(token)) {
        json(response, 401, { error: 'Invalid or expired token' });
        return;
      }
      json(response, 200, {
        id: 'user_1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        account: { id: 'acct_1', name: 'Analytical Engines', tier: 'pro' },
      });
      return;
    }

    /* ---- revoke ---------------------------------------------------------- */
    if (url.pathname === '/api/v1/cli/revoke' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { token?: string };
      if (parsed.token !== undefined) issuedTokens.delete(parsed.token);
      json(response, 200, { ok: true });
      return;
    }

    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: base(server),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    pendingCodes,
    pendingDevices,
    issuedTokens,
    approveDevice(userCode) {
      for (const pending of pendingDevices.values()) {
        if (pending.userCode === userCode) {
          pending.approved = true;
          return true;
        }
      }
      return false;
    },
    get identityShouldFail() {
      return state.identityShouldFail;
    },
    set identityShouldFail(value: boolean) {
      state.identityShouldFail = value;
    },
  };
};

const base = (server: Server): string => {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};
