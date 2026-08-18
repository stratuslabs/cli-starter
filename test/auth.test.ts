/**
 * The sign-in flows, end to end.
 *
 * These run the real `login` command against a real HTTP server on localhost:
 * real sockets, a real 302 redirect into the loopback listener, real form
 * encoding, real PKCE verification. Nothing is mocked except the browser, which
 * is replaced by a `fetch` — which is all a browser does here.
 */

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { APP, baseUrlEnvName } from '../src/app.ts';
import { credentialsPath, type CredentialsFile } from '../src/kit/credentials.ts';
import { createTempHome, run } from './support/harness.ts';
import { startMockAuthServer, type MockAuthServer } from './support/mock-auth-server.ts';

let server: MockAuthServer;

before(async () => {
  server = await startMockAuthServer();
});

after(async () => {
  await server.close();
});

/**
 * The endpoint override the CLI reads, pointed at the mock.
 *
 * `DISPLAY` is set because `login` picks its flow from the environment: with no
 * display and no SSH hints it correctly assumes there is no browser to open and
 * falls back to a device code. Tests that want the browser flow must look like
 * a machine that has one.
 */
const env = (): Record<string, string> => ({ [baseUrlEnvName(APP)]: server.url, DISPLAY: ':0' });

const readStore = async (home: string): Promise<CredentialsFile> =>
  JSON.parse(await readFile(credentialsPath(home, APP.brand), 'utf8')) as CredentialsFile;

test('browser sign-in completes and stores a token', async () => {
  const home = await createTempHome();
  try {
    const result = await run({
      argv: ['login'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      // The browser's entire job is to fetch the authorize URL and follow the
      // redirect back to the loopback listener. `fetch` does exactly that.
      openExternal: async (url) => {
        await globalThis.fetch(url);
      },
    });

    assert.equal(result.exitCode, 0, result.output.plain);
    assert.match(result.output.plain, /Signed in as Ada Lovelace/);

    const store = await readStore(home.path);
    assert.equal(store.profiles['default']?.baseUrl, server.url);
    assert.ok(store.profiles['default']?.token.startsWith('tok_'));
  } finally {
    await home.cleanup();
  }
});

test('the stored credentials file is 0600', async () => {
  const home = await createTempHome();
  try {
    await run({
      argv: ['login'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      openExternal: async (url) => {
        await globalThis.fetch(url);
      },
    });
    const mode = (await stat(credentialsPath(home.path, APP.brand))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await home.cleanup();
  }
});

test('the authorization code is single-use', async () => {
  // A code that can be redeemed twice is a code that can be stolen and reused.
  const home = await createTempHome();
  try {
    let captured: string | undefined;
    await run({
      argv: ['login'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      openExternal: async (url) => {
        const response = await globalThis.fetch(url, { redirect: 'manual' });
        const location = response.headers.get('location') ?? '';
        captured = new URL(location).searchParams.get('code') ?? undefined;
        await globalThis.fetch(location);
      },
    });

    assert.ok(captured !== undefined);
    assert.equal(server.pendingCodes.has(captured), false, 'the code should be consumed on exchange');
  } finally {
    await home.cleanup();
  }
});

test('a mismatched state is rejected and nothing is saved', async () => {
  const home = await createTempHome();
  try {
    const result = await run({
      argv: ['login'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      openExternal: async (url) => {
        // Simulate a callback that did not originate from this request.
        const parsed = new URL(url);
        const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '');
        redirect.searchParams.set('code', 'anything');
        redirect.searchParams.set('state', 'not-the-state-we-sent');
        await globalThis.fetch(redirect);
      },
    });

    assert.equal(result.exitCode, 4);
    assert.match(result.output.plain, /did not match/);
    await assert.rejects(readStore(home.path));
  } finally {
    await home.cleanup();
  }
});

test('a denied authorization reports the reason and does not save', async () => {
  const home = await createTempHome();
  try {
    const result = await run({
      argv: ['login'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      openExternal: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('error_description', 'You declined the request.');
        redirect.searchParams.set('state', new URL(url).searchParams.get('state') ?? '');
        await globalThis.fetch(redirect);
      },
    });

    assert.equal(result.exitCode, 4);
    assert.match(result.output.plain, /You declined the request/);
  } finally {
    await home.cleanup();
  }
});

test('when the browser cannot be opened, the URL is printed and the flow keeps waiting', async () => {
  const home = await createTempHome();
  try {
    // Cancel once the URL has been printed, standing in for the user pressing
    // Ctrl-C. Waiting out the real five-minute timeout would be a five-minute
    // test, and asserting on elapsed time would be a race against the runner.
    const controller = new AbortController();
    let printedUrl: string | undefined;

    const result = await run({
      argv: ['login'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      signal: controller.signal,
      openExternal: async (url) => {
        printedUrl = url;
        // No browser here — exactly what a container or a bare server has.
        // The flow must survive this, because the URL still works if the user
        // can get it to a browser some other way.
        setImmediate(() => controller.abort());
        throw new Error('no opener available');
      },
    });

    assert.match(result.output.plain, /Could not open a browser/);
    assert.ok(
      printedUrl !== undefined && result.output.plain.includes(printedUrl),
      'the sign-in URL must be printed when it cannot be opened',
    );
    // Cancelled, not failed: the listener was still up when we aborted.
    assert.equal(result.exitCode, 130);
  } finally {
    await home.cleanup();
  }
});

test('device sign-in polls until the code is approved', async () => {
  const home = await createTempHome();
  try {
    // Approve shortly after the flow starts, as a human would.
    const approver = setInterval(() => {
      for (const pending of server.pendingDevices.values()) pending.approved = true;
    }, 5);

    const result = await run({
      argv: ['login', '--device'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      openExternal: async () => {},
    });
    clearInterval(approver);

    assert.equal(result.exitCode, 0, result.output.plain);
    assert.match(result.output.plain, /WXYZ-/, 'the user code must be shown prominently');
    const store = await readStore(home.path);
    assert.ok(store.profiles['default']?.token.startsWith('tok_device_'));
  } finally {
    await home.cleanup();
  }
});

test('a pasted token from stdin is accepted and never appears in argv', async () => {
  const home = await createTempHome();
  try {
    // Mint a token the mock will recognise.
    const token = 'tok_pasted';
    server.issuedTokens.add(token);

    const result = await run({
      argv: ['login', '--token', '-'],
      stdin: [token],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
    });

    assert.equal(result.exitCode, 0, result.output.plain);
    const store = await readStore(home.path);
    assert.equal(store.profiles['default']?.token, token);
  } finally {
    await home.cleanup();
  }
});

test('a rejected token is not saved', async () => {
  const home = await createTempHome();
  try {
    const result = await run({
      argv: ['login', '--token', '-'],
      stdin: ['tok_definitely_not_valid'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
    });

    assert.equal(result.exitCode, 4);
    assert.match(result.output.plain, /rejected/);
    // Saving a bad token turns every later command into a confusing 401.
    await assert.rejects(readStore(home.path), 'a rejected token must not be written to disk');
  } finally {
    await home.cleanup();
  }
});

test('an unreachable server saves the token but says it could not confirm it', async () => {
  const home = await createTempHome();
  try {
    const token = 'tok_unverifiable';
    server.issuedTokens.add(token);
    server.identityShouldFail = true;

    const result = await run({
      argv: ['login', '--token', '-'],
      stdin: [token],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
    });
    server.identityShouldFail = false;

    // Unreachable is not the same as rejected, and conflating them either
    // discards a good token or reports a bad one as fine.
    assert.equal(result.exitCode, 0, result.output.plain);
    assert.match(result.output.plain, /could not be confirmed/);
    const store = await readStore(home.path);
    assert.equal(store.profiles['default']?.token, token);
  } finally {
    await home.cleanup();
  }
});

test('profiles keep two accounts side by side', async () => {
  const home = await createTempHome();
  try {
    const shared = {
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      openExternal: async (url: string) => {
        await globalThis.fetch(url);
      },
    };

    await run({ argv: ['login'], ...shared });
    await run({ argv: ['login', '--profile', 'staging'], ...shared });

    const store = await readStore(home.path);
    assert.deepEqual(Object.keys(store.profiles).sort(), ['default', 'staging']);
    assert.notEqual(store.profiles['default']?.token, store.profiles['staging']?.token);
  } finally {
    await home.cleanup();
  }
});

test('whoami reports the account, and --json is parseable', async () => {
  const home = await createTempHome();
  try {
    const shared = { processEnv: env(), homeDir: home.path, fetch: globalThis.fetch };
    await run({
      argv: ['login'],
      ...shared,
      openExternal: async (url: string) => {
        await globalThis.fetch(url);
      },
    });

    const human = await run({ argv: ['whoami'], ...shared });
    assert.equal(human.exitCode, 0);
    assert.match(human.output.stdout, /Ada Lovelace/);

    const json = await run({ argv: ['whoami', '--json'], ...shared });
    // stdout must be *only* JSON, or piping to jq breaks.
    const parsed = JSON.parse(json.output.stdout) as { ok: boolean; identity: { name: string } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.identity.name, 'Ada Lovelace');
  } finally {
    await home.cleanup();
  }
});

test('whoami without a sign-in fails with the auth exit code and says what to run', async () => {
  const home = await createTempHome();
  try {
    const result = await run({
      argv: ['whoami'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
    });
    assert.equal(result.exitCode, 4);
    assert.match(result.output.plain, /not signed in/i);
    assert.match(result.output.plain, new RegExp(`${APP.name} login`));
  } finally {
    await home.cleanup();
  }
});

test('logout revokes server-side, so the token stops working', async () => {
  const home = await createTempHome();
  try {
    const shared = { processEnv: env(), homeDir: home.path, fetch: globalThis.fetch };
    await run({
      argv: ['login'],
      ...shared,
      openExternal: async (url: string) => {
        await globalThis.fetch(url);
      },
    });
    const store = await readStore(home.path);
    const token = store.profiles['default']?.token ?? '';
    assert.ok(server.issuedTokens.has(token));

    const result = await run({ argv: ['logout'], ...shared });
    assert.equal(result.exitCode, 0, result.output.plain);
    assert.match(result.output.plain, /revoked/);
    // Deleting only the local copy would be a lie to someone who ran this
    // because they think the token leaked.
    assert.equal(server.issuedTokens.has(token), false);

    const after = await run({ argv: ['whoami'], ...shared });
    assert.equal(after.exitCode, 4);
  } finally {
    await home.cleanup();
  }
});

test('a second login says you are already signed in instead of minting another token', async () => {
  const home = await createTempHome();
  try {
    const shared = {
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      openExternal: async (url: string) => {
        await globalThis.fetch(url);
      },
    };
    await run({ argv: ['login'], ...shared });
    const second = await run({ argv: ['login'], ...shared });

    assert.equal(second.exitCode, 0);
    assert.match(second.output.plain, /Already signed in/);
  } finally {
    await home.cleanup();
  }
});

test('a token bound to one endpoint is not sent to another', async () => {
  const home = await createTempHome();
  try {
    await run({
      argv: ['login'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
      openExternal: async (url: string) => {
        await globalThis.fetch(url);
      },
    });

    const elsewhere = await run({
      argv: ['whoami', '--base-url', 'https://somewhere-else.example'],
      processEnv: env(),
      homeDir: home.path,
      fetch: globalThis.fetch,
    });

    assert.equal(elsewhere.exitCode, 4);
    assert.match(elsewhere.output.plain, /will not be sent to/);
  } finally {
    await home.cleanup();
  }
});
