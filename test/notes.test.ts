/**
 * Tests for the worked example.
 *
 * These are also the example of *how to test a command*: drive the real
 * `main()` against the mock server, assert on captured output and exit codes.
 * No subprocess, no fixtures, no cleanup beyond a temp home.
 *
 * Deleted along with `src/commands/notes.ts` by `npm run rebrand`.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { APP, baseUrlEnvName, tokenEnvName } from '../src/app.ts';
import { EXIT } from '../src/core/errors.ts';
import { stripAnsi } from '../src/core/theme.ts';
import { run } from './support/harness.ts';
import { startMockAuthServer, type MockAuthServer } from './support/mock-auth-server.ts';

let server: MockAuthServer;

before(async () => {
  server = await startMockAuthServer();
  // Stand in for a completed sign-in, so these tests are about `notes` rather
  // than about the login flow — which has its own file.
  server.issuedTokens.add('tok_notes_test');
});

after(async () => {
  await server.close();
});

const env = (): Record<string, string> => ({
  [baseUrlEnvName(APP)]: server.url,
  [tokenEnvName(APP)]: 'tok_notes_test',
});

test('lists notes as a table on stdout', async () => {
  const result = await run({ argv: ['notes'], processEnv: env(), fetch: globalThis.fetch });

  assert.equal(result.exitCode, EXIT.ok, result.output.plain);
  assert.match(result.output.stdout, /Dark mode is here/);
  assert.match(result.output.stdout, /TITLE/);
  // The count is commentary, so it belongs on stderr — otherwise it lands in
  // the middle of anything piped to grep.
  assert.match(result.output.stderr, /4 notes/);
  assert.doesNotMatch(result.output.stdout, /4 notes/);
});

test('--json puts only JSON on stdout', async () => {
  const result = await run({
    argv: ['notes', '--json'],
    processEnv: env(),
    fetch: globalThis.fetch,
  });

  const parsed = JSON.parse(result.output.stdout) as { ok: boolean; notes: { id: string }[] };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.notes.length, 4);
});

test('--status filters, and reaches the server as an encoded query parameter', async () => {
  const result = await run({
    argv: ['notes', '--status', 'draft', '--json'],
    processEnv: env(),
    fetch: globalThis.fetch,
  });

  const parsed = JSON.parse(result.output.stdout) as { notes: { status: string }[] };
  assert.equal(parsed.notes.length, 1);
  assert.equal(parsed.notes[0]?.status, 'draft');
});

test('an invalid --status is rejected before any request is made', async () => {
  const result = await run({
    argv: ['notes', '--status', 'nope'],
    processEnv: env(),
    // Any call here is a bug: `choices` should have stopped this at parse time.
    fetch: () => Promise.reject(new Error('should not have called the API')),
  });

  assert.equal(result.exitCode, EXIT.usage);
  assert.match(stripAnsi(result.output.stderr), /draft, scheduled, published/);
});

test('an id shows a single note', async () => {
  const result = await run({
    argv: ['notes', 'n_8f21', '--json'],
    processEnv: env(),
    fetch: globalThis.fetch,
  });

  const parsed = JSON.parse(result.output.stdout) as { note: { title: string } };
  assert.equal(parsed.note.title, 'Dark mode is here');
});

test('an unknown id exits not-found and names the recovery command', async () => {
  const result = await run({
    argv: ['notes', 'n_missing'],
    processEnv: env(),
    fetch: globalThis.fetch,
  });

  assert.equal(result.exitCode, EXIT.notFound);
  const stderr = stripAnsi(result.output.stderr);
  assert.match(stderr, /No note with id n_missing/);
  assert.match(stderr, new RegExp(`Run \`${APP.name} notes\``));
});

test('an empty result is not an error', async () => {
  // "Nothing matched" and "something broke" must be distinguishable by exit
  // code, or a script cannot tell them apart.
  const result = await run({
    argv: ['notes', '--status', 'scheduled', '--json'],
    processEnv: env(),
    fetch: globalThis.fetch,
  });
  assert.equal(result.exitCode, EXIT.ok);

  const empty = await run({
    argv: ['notes'],
    processEnv: env(),
    fetch: async () => new Response(JSON.stringify({ notes: [] }), { status: 200 }),
  });
  assert.equal(empty.exitCode, EXIT.ok);
  assert.match(stripAnsi(empty.output.stderr), /No notes yet/);
  assert.equal(empty.output.stdout, '');
});

test('not signed in fails with the auth code before calling the API', async () => {
  const result = await run({
    argv: ['notes'],
    processEnv: { [baseUrlEnvName(APP)]: server.url },
    fetch: () => Promise.reject(new Error('should not have called the API')),
  });

  assert.equal(result.exitCode, EXIT.auth);
  assert.match(stripAnsi(result.output.stderr), new RegExp(`${APP.name} login`));
});

test('a rejected token surfaces as auth, not as a generic failure', async () => {
  const result = await run({
    argv: ['notes'],
    processEnv: {
      [baseUrlEnvName(APP)]: server.url,
      [tokenEnvName(APP)]: 'tok_not_valid',
    },
    fetch: globalThis.fetch,
  });

  assert.equal(result.exitCode, EXIT.auth);
});
