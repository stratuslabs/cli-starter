/**
 * End-to-end behaviour of the CLI itself: help, version, exit codes, and the
 * stdout/stderr contract that makes output scriptable.
 *
 * Everything here exercises commands that survive `npm run rebrand` — the demo
 * command has its own file, so deleting the demo does not delete coverage of
 * the framework.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APP, baseUrlEnvName, tokenEnvName } from '../src/app.ts';
import { EXIT } from '../src/kit/errors.ts';
import { stripAnsi } from '../src/kit/theme.ts';
import { saveCredential } from '../src/kit/credentials.ts';
import { createTempHome, run } from './support/harness.ts';

// Read the brand rather than hard-coding it, so these still pass after
// `npm run rebrand` — which is the first thing an adopter runs, and the worst
// possible moment for the suite to go red for no real reason.
const BIN = APP.name;
const TOKEN_ENV = tokenEnvName(APP);
const BASE_URL_ENV = baseUrlEnvName(APP);
const ENDPOINT = 'https://api.example.test';

/** Points the CLI at an endpoint that does not exist, but is well-formed. */
const endpointEnv = (): Record<string, string> => ({ [BASE_URL_ENV]: ENDPOINT });

/** Signed in as far as the CLI knows, so failures come from the network. */
const withToken = (): Record<string, string> => ({ [TOKEN_ENV]: 'tok_test', [BASE_URL_ENV]: ENDPOINT });

const offline = () => Promise.reject(new Error('offline'));

/** A temp home with a credential already saved for ENDPOINT. */
const signedInHome = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const home = await createTempHome();
  await saveCredential(home.path, APP.brand, 'default', {
    token: 'tok_test',
    baseUrl: ENDPOINT,
    createdAt: new Date().toISOString(),
  });
  return home;
};

test('--help exits 0 and prints to stdout, because it is what was asked for', async () => {
  const result = await run({ argv: ['--help'] });
  assert.equal(result.exitCode, EXIT.ok);
  assert.match(result.output.stdout, /Usage/);
  assert.equal(result.output.stderr, '');
});

test('no arguments prints help rather than doing nothing', async () => {
  const result = await run({ argv: [] });
  assert.equal(result.exitCode, EXIT.ok);
  assert.match(result.output.stdout, /Commands/);
});

test('--version prints just the name and version', async () => {
  const result = await run({ argv: ['--version'] });
  assert.equal(result.exitCode, EXIT.ok);
  assert.match(result.output.stdout.trim(), new RegExp(`^${BIN} \\d+\\.\\d+\\.\\d+`));
});

test('the version comes from package.json, not a hand-copied constant', async () => {
  // A constant duplicating the manifest is a constant that will drift; one of
  // our other CLIs is already out of step with its own package.json.
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const result = await run({ argv: ['--version'] });
  assert.equal(result.output.stdout.trim(), `${BIN} ${manifest.version}`);
});

test('a usage error exits 2 and shows usage, not the whole help', async () => {
  const result = await run({ argv: ['nope'] });
  assert.equal(result.exitCode, EXIT.usage);
  // Our other CLI dumps 90 lines of help on every failure, which buries the
  // one line that says what to do.
  const stderr = stripAnsi(result.output.stderr);
  assert.ok(stderr.split('\n').length < 8, `error output is too noisy:\n${stderr}`);
  assert.match(stderr, /Unknown command/);
});

test('errors go to stderr so stdout stays clean for pipes', async () => {
  const result = await run({ argv: ['nope'] });
  assert.equal(result.output.stdout, '');
});

test('each failure kind gets its own exit code', async () => {
  // Not signed in → auth.
  const auth = await run({ argv: ['whoami'], processEnv: endpointEnv() });
  assert.equal(auth.exitCode, EXIT.auth);

  // Signed in but the server is unreachable → network. Conflating these two is
  // the difference between "sign in again" and "check your wifi".
  const network = await run({ argv: ['whoami'], processEnv: withToken(), fetch: offline });
  assert.equal(network.exitCode, EXIT.network);

  assert.equal((await run({ argv: ['nope'] })).exitCode, EXIT.usage);
});

test('a hint is printed under the message', async () => {
  const result = await run({ argv: ['whoami'], processEnv: endpointEnv() });
  assert.match(
    stripAnsi(result.output.stderr),
    new RegExp(`not signed in[\\s\\S]*Run \`${BIN} login\``, 'i'),
  );
});

test('under --json, an error is JSON on stdout and stdout only', async () => {
  const result = await run({ argv: ['whoami', '--json'], processEnv: endpointEnv() });
  assert.equal(result.exitCode, EXIT.auth);
  const parsed = JSON.parse(result.output.stdout) as { ok: boolean; error: { code: string; hint: string } };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'auth.not_signed_in');
  assert.match(parsed.error.hint, /login/);
});

test('--verbose adds a stack, and the default does not', async () => {
  const env = endpointEnv();
  const quiet = await run({ argv: ['whoami'], processEnv: env });
  assert.ok(!quiet.output.stderr.includes('\n    at '), 'a stack trace should not be shown by default');

  const loud = await run({ argv: ['whoami', '--verbose'], processEnv: env });
  assert.match(loud.output.stderr, /\n\s+at /);
});

test('no ANSI escapes are emitted when the output is not a terminal', async () => {
  const result = await run({ argv: ['doctor', '--offline'], tty: { stdoutIsTty: false } });
  assert.equal(stripAnsi(result.output.stdout), result.output.stdout);
});

test('a TTY on stdin does not turn on colour for a redirected stdout', async () => {
  // The exact bug in our other CLI: `cmd > file` from a terminal writes escape
  // codes into the file, because colour is gated on the wrong stream.
  const result = await run({
    argv: ['doctor', '--offline'],
    tty: { stdoutIsTty: false, stdinIsTty: true },
    processEnv: { TERM: 'xterm-256color' },
  });
  assert.equal(stripAnsi(result.output.stdout), result.output.stdout);
});

test('--color forces escapes even when redirected', async () => {
  const result = await run({ argv: ['doctor', '--offline', '--color'], tty: { stdoutIsTty: false } });
  assert.notEqual(stripAnsi(result.output.stdout), result.output.stdout);
});

test('--quiet silences chrome but not data', async () => {
  const result = await run({ argv: ['doctor', '--offline', '--quiet'] });
  assert.notEqual(result.output.stdout, '');
  assert.equal(result.output.stderr, '');
});

test('doctor reports provenance for every resolved value', async () => {
  // Signed in, because --offline still reports an absent credential as a
  // problem and this case is about provenance, not health.
  const home = await signedInHome();
  try {
    const result = await run({
      argv: ['doctor', '--offline'],
      processEnv: endpointEnv(),
      homeDir: home.path,
    });
    assert.equal(result.exitCode, EXIT.ok, result.output.plain);
    // "It works locally but not in CI" is nearly always "a different source won",
    // and only provenance answers it.
    assert.match(result.output.stdout, new RegExp(`\\$${BASE_URL_ENV}`));

    const viaFlag = await run({ argv: ['doctor', '--offline', '--base-url', 'https://flag.example'] });
    assert.match(viaFlag.output.stdout, /--base-url/);
  } finally {
    await home.cleanup();
  }
});

test('doctor exits non-zero when something is actually wrong', async () => {
  const result = await run({ argv: ['doctor'], processEnv: endpointEnv(), fetch: offline });
  assert.equal(result.exitCode, EXIT.config);
  assert.match(stripAnsi(result.output.plain), /Not signed in/);
});

test('doctor --json is machine-readable', async () => {
  const home = await signedInHome();
  try {
    const result = await run({
      argv: ['doctor', '--offline', '--json'],
      processEnv: endpointEnv(),
      homeDir: home.path,
    });
    const parsed = JSON.parse(result.output.stdout) as { ok: boolean; findings: { label: string }[] };
    assert.equal(parsed.ok, true);
    assert.ok(parsed.findings.some((finding) => finding.label === 'endpoint'));
  } finally {
    await home.cleanup();
  }
});

test('output wraps to a narrow terminal instead of overflowing it', async () => {
  const result = await run({ argv: ['--help'], tty: { columns: 60 } });
  for (const line of stripAnsi(result.output.stdout).split('\n')) {
    if (/\S{40,}/.test(line)) continue;
    assert.ok(line.length <= 60, `overflowed: ${JSON.stringify(line)}`);
  }
});
