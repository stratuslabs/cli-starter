/**
 * Tests for the demo command.
 *
 * This file is deleted along with `src/commands/demo.ts` by `npm run rebrand`.
 * Everything that tests the *framework* lives in `cli.test.ts`, so removing the
 * demo costs you no coverage of the parts you are keeping.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXIT } from '../src/kit/errors.ts';
import { stripAnsi } from '../src/kit/theme.ts';
import { run } from './support/harness.ts';

test('demo output renders a table on stdout', async () => {
  const result = await run({ argv: ['demo', 'output'] });
  assert.equal(result.exitCode, EXIT.ok);
  assert.match(result.output.stdout, /TITLE/);
  assert.match(result.output.stdout, /Dark mode is here/);
});

test('under --json, stdout parses cleanly with nothing else mixed in', async () => {
  const result = await run({ argv: ['demo', 'output', '--json'] });
  const parsed = JSON.parse(result.output.stdout) as { ok: boolean; posts: unknown[] };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.posts.length, 4);
});

test('demo error maps each kind to its exit code', async () => {
  assert.equal((await run({ argv: ['demo', 'error', '--kind', 'auth'] })).exitCode, EXIT.auth);
  assert.equal((await run({ argv: ['demo', 'error', '--kind', 'network'] })).exitCode, EXIT.network);
  assert.equal((await run({ argv: ['demo', 'error', '--kind', 'usage'] })).exitCode, EXIT.usage);
});

test('an invalid choice lists the valid ones', async () => {
  const result = await run({ argv: ['demo', 'error', '--kind', 'nope'] });
  assert.equal(result.exitCode, EXIT.usage);
  assert.match(stripAnsi(result.output.stderr), /auth, network, usage/);
});

test('a group with subcommands shows its help when asked', async () => {
  const result = await run({ argv: ['demo', '--help'] });
  assert.equal(result.exitCode, EXIT.ok);
  assert.match(result.output.stdout, /Subcommands/);
  assert.match(result.output.stdout, /prompts/);
});

test('a prompt with no input fails fast instead of hanging', async () => {
  // A hung command in CI burns a runner slot and reports nothing, so this must
  // fail — and must say which flag would have answered the question.
  const result = await run({ argv: ['demo', 'prompts'] });
  assert.equal(result.exitCode, EXIT.usage);
  assert.match(stripAnsi(result.output.stderr), /not interactive/);
});

test('piped input drives the same prompts a human would answer', async () => {
  const result = await run({ argv: ['demo', 'prompts'], stdin: ['2', 'y', 'ocean'] });
  assert.equal(result.exitCode, EXIT.ok, result.output.plain);
  assert.match(result.output.plain, /Saved ocean/);
});
