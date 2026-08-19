import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineCommand, type ProgramDef } from '../../src/core/command.ts';
import { UsageError } from '../../src/core/errors.ts';
import { parseInvocation } from '../../src/core/parse.ts';
import { GLOBAL_FLAGS } from '../../src/core/run.ts';

const list = defineCommand({
  name: 'list',
  summary: 'list things',
  flags: { status: { type: 'string', summary: 'filter', choices: ['draft', 'live'] } },
  run() {},
});

const create = defineCommand({
  name: 'create',
  summary: 'create a thing',
  args: [{ name: 'name', summary: 'the name', required: true }],
  run() {},
});

const program: ProgramDef = {
  name: 'demo',
  version: '1.0.0',
  summary: 'a test program',
  globalFlags: GLOBAL_FLAGS,
  commands: [
    defineCommand({
      name: 'items',
      aliases: ['i'],
      summary: 'manage items',
      defaultSubcommand: 'list',
      subcommands: [list, create],
    }),
    defineCommand({
      name: 'publish',
      summary: 'publish',
      args: [{ name: 'id', summary: 'post id' }],
      flags: {
        title: { type: 'string', summary: 'title' },
        private: { type: 'boolean', summary: 'hide it', conflictsWith: ['public'] },
        public: { type: 'boolean', summary: 'show it', conflictsWith: ['private'] },
        tag: { type: 'string', summary: 'a tag', multiple: true },
        token: { type: 'string', summary: 'a token', env: 'DEMO_TOKEN' },
      },
      run() {},
    }),
  ],
};

const parse = (argv: string[], env: Record<string, string | undefined> = {}) =>
  parseInvocation(program, argv, env);

test('resolves a subcommand path', () => {
  const result = parse(['items', 'create', 'widget']);
  assert.deepEqual(result.resolved?.path, ['items', 'create']);
  assert.deepEqual(result.args, ['widget']);
});

test('an alias resolves to the same command', () => {
  assert.deepEqual(parse(['i', 'create', 'widget']).resolved?.path, ['items', 'create']);
});

test('a bare group runs its default subcommand', () => {
  // Adding `items list` must not break the existing `items`.
  assert.deepEqual(parse(['items']).resolved?.path, ['items', 'list']);
});

test('a string flag value is not mistaken for a command', () => {
  // `publish` here is the profile, not the command — the scanner has to know
  // the flag vocabulary to skip the value.
  const result = parse(['--profile', 'publish', 'items', 'list']);
  assert.deepEqual(result.resolved?.path, ['items', 'list']);
  assert.equal(result.flags.string('profile'), 'publish');
});

test('everything after -- is passed through untouched', () => {
  const result = parse(['publish', '--', '--not-a-flag', 'raw']);
  assert.deepEqual(result.passthrough, ['--not-a-flag', 'raw']);
  assert.deepEqual(result.args, []);
});

test('repeated flags collect', () => {
  assert.deepEqual(parse(['publish', '--tag', 'a', '--tag', 'b']).flags.list('tag'), ['a', 'b']);
});

test('an environment variable fills in an absent flag', () => {
  assert.equal(parse(['publish'], { DEMO_TOKEN: 'from-env' }).flags.string('token'), 'from-env');
});

test('an explicit flag beats the environment', () => {
  const result = parse(['publish', '--token', 'typed'], { DEMO_TOKEN: 'from-env' });
  assert.equal(result.flags.string('token'), 'typed');
});

test('mutually exclusive flags are rejected', () => {
  assert.throws(
    () => parse(['publish', '--private', '--public']),
    (error: unknown) =>
      error instanceof UsageError && /cannot be used together/.test(error.message),
  );
});

test('an invalid choice names the valid ones', () => {
  assert.throws(
    () => parse(['items', 'list', '--status', 'nope']),
    (error: unknown) => error instanceof UsageError && /draft, live/.test(error.hint ?? ''),
  );
});

test('a missing required argument names the argument', () => {
  assert.throws(
    () => parse(['items', 'create']),
    (error: unknown) => error instanceof UsageError && /<name>/.test(error.message),
  );
});

test('an unexpected extra argument is rejected', () => {
  assert.throws(
    () => parse(['publish', 'one', 'two']),
    (error: unknown) => error instanceof UsageError && /Unexpected argument/.test(error.message),
  );
});

test('a mistyped command suggests the right one', () => {
  assert.throws(
    () => parse(['pubish']),
    (error: unknown) => error instanceof UsageError && /Did you mean demo publish\?/.test(error.hint ?? ''),
  );
});

test('a wildly wrong command suggests nothing rather than guessing', () => {
  // A confidently wrong suggestion is worse than none.
  assert.throws(
    () => parse(['zzzzzzz']),
    (error: unknown) => error instanceof UsageError && !/Did you mean/.test(error.hint ?? ''),
  );
});

test('a mistyped flag suggests the right one', () => {
  assert.throws(
    () => parse(['publish', '--titel', 'x']),
    (error: unknown) => error instanceof UsageError && /--title/.test(error.hint ?? ''),
  );
});

test('--help short-circuits validation so help is always reachable', () => {
  // `create` requires an argument; asking for its help must not demand one.
  const result = parse(['items', 'create', '--help']);
  assert.equal(result.helpRequested, true);
  assert.deepEqual(result.resolved?.path, ['items', 'create']);
});

test('flags.has distinguishes "typed" from "defaulted"', () => {
  assert.equal(parse(['publish']).flags.has('title'), false);
  assert.equal(parse(['publish', '--title', 'x']).flags.has('title'), true);
});
