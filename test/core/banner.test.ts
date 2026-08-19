/**
 * The banner is the one thing in this CLI that exists purely to be charming,
 * which makes it the one thing most likely to become an annoyance. Almost every
 * test here is about it *not* appearing: in a pipe, in a log, under `--json`,
 * under `--quiet`, in CI. The rendering tests cover the two ways a
 * side-by-side layout goes wrong — padding measured through colour codes, and a
 * terminal too narrow to hold both columns.
 *
 * The end-to-end cases drive the real `main()` because the interesting failure
 * is not in `banner.ts` at all: the art lives in `src/app.ts` and has to reach
 * `ProgramDef`. It did not, at first, and every unit test still passed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { programFacts, renderBanner, shouldShowBanner } from '../../src/core/banner.ts';
import type { CliEnvironment } from '../../src/core/env.ts';
import { createTheme, plainTheme, stringWidth, stripAnsi } from '../../src/core/theme.ts';
import { APP } from '../../src/app.ts';
import { program } from '../../src/main.ts';
import { run } from '../support/harness.ts';

// Deliberately ragged: the last row is shorter than the widest, and it is the
// row with no fact beside it. That is the only combination that exposes padding
// applied where nothing needs aligning.
const ART = ['##  ##', '######', '## ##'];

const FACTS = [
  { label: 'cli', value: 'acme 1.0.0' },
  { label: 'node', value: '22.13.0' },
];

const env = (overrides: {
  stdoutIsTty?: boolean;
  processEnv?: Record<string, string | undefined>;
}): CliEnvironment =>
  ({
    processEnv: overrides.processEnv ?? {},
    tty: { stdoutIsTty: overrides.stdoutIsTty ?? true, stdinIsTty: true, columns: 80 },
  }) as CliEnvironment;

const shown = { json: false, quiet: false };

/* -- the policy ----------------------------------------------------------- */

test('a terminal with art gets the banner', () => {
  assert.equal(shouldShowBanner(env({}), shown, ART), true);
});

test('a pipe or a redirect does not', () => {
  // The whole reason colour is gated on stdout rather than stdin: `acme > file`
  // must not put a picture in the file.
  assert.equal(shouldShowBanner(env({ stdoutIsTty: false }), shown, ART), false);
});

test('--json and --quiet suppress it', () => {
  assert.equal(shouldShowBanner(env({}), { json: true, quiet: false }, ART), false);
  assert.equal(shouldShowBanner(env({}), { json: false, quiet: true }, ART), false);
});

test('CI suppresses it', () => {
  assert.equal(shouldShowBanner(env({ processEnv: { CI: 'true' } }), shown, ART), false);
});

test('no art means no empty frame', () => {
  // An adopter who deletes the art from src/app.ts should get nothing, not a
  // column of facts floating where a logo used to be.
  assert.equal(shouldShowBanner(env({}), shown, undefined), false);
  assert.equal(shouldShowBanner(env({}), shown, []), false);
});

/* -- rendering ------------------------------------------------------------ */

test('facts line up in a column regardless of colour', () => {
  // Colour must not move anything. The failure mode is measuring a painted
  // string with `String.length`, which counts escape sequences a human cannot
  // see and pushes each row to a different visual column — so the two renders
  // are compared for identical geometry rather than merely for both existing.
  const coloured = renderBanner(
    ART,
    FACTS,
    createTheme({ colorLevel: 'truecolor', unicode: true, columns: 80 }),
  );
  const plain = renderBanner(ART, FACTS, plainTheme(80));

  assert.deepEqual(coloured.map(stripAnsi), plain);

  const factColumns = FACTS.map((fact, index) => (plain[index] ?? '').indexOf(fact.value));
  assert.ok(
    factColumns.every((column) => column > 0 && column === factColumns[0]),
    `values start at different columns: ${factColumns.join(', ')}`,
  );
});

test('a narrow terminal stacks instead of overflowing', () => {
  // Side-by-side that does not fit wraps into interleaved nonsense — far worse
  // than two blocks. 20 columns cannot hold six columns of art plus the facts.
  const lines = renderBanner(ART, FACTS, plainTheme(20));

  assert.equal(lines.length, ART.length + 1 + FACTS.length);
  assert.deepEqual(lines.slice(0, ART.length), [...ART]);
  assert.equal(lines[ART.length], '');
  for (const line of lines) assert.ok(stringWidth(line) <= 20, `"${line}" overflows 20 columns`);
});

test('no line ends in whitespace', () => {
  // Invisible until it lands in a diff or a commit message, where it is a lint
  // failure with no obvious cause. The art is taller than the fact list, so the
  // rows past the last fact are the ones that used to be padded for nothing.
  for (const theme of [plainTheme(80), plainTheme(20)]) {
    for (const line of renderBanner(ART, FACTS, theme)) {
      assert.doesNotMatch(line, /\s$/, `"${line}" ends in whitespace`);
    }
  }
});

test('more facts than art lines still render', () => {
  const lines = renderBanner(['#'], FACTS, plainTheme(80));
  assert.equal(lines.length, FACTS.length);
  assert.ok(lines[1]?.includes('22.13.0'));
});

test('the facts are local — no network, no credentials', () => {
  const facts = programFacts({ name: 'acme', version: '1.0.0' }, { platform: 'linux' });
  assert.deepEqual(
    facts.map((fact) => fact.label),
    ['cli', 'node', 'platform'],
  );
  assert.equal(facts[0]?.value, 'acme 1.0.0');
});

/* -- end to end ----------------------------------------------------------- */

test('the app art reaches the program definition', () => {
  // src/main.ts builds ProgramDef from APP field by field, so a new field on
  // AppConfig is silently dropped until somebody adds the line. That is exactly
  // what happened here.
  assert.deepEqual(program.art, APP.art);
});

test('the bare binary on a terminal prints the banner above the help', async () => {
  const result = await run({ argv: [], tty: { stdoutIsTty: true } });

  assert.equal(result.exitCode, 0);
  const first = APP.art?.[0];
  assert.ok(first !== undefined, 'the template ships art');
  const plain = stripAnsi(result.output.stdout);
  assert.ok(plain.startsWith(first), `expected the art first, got: ${plain.slice(0, 60)}`);
  assert.ok(plain.includes('Usage'), 'the help still follows');
});

test('--help is reference material and stays clean', async () => {
  // Somebody typing --help is quite possibly piping into a pager or grepping
  // it. The bare name is the only invocation asking "what is this".
  const result = await run({ argv: ['--help'], tty: { stdoutIsTty: true } });

  const first = APP.art?.[0] ?? '';
  assert.ok(!stripAnsi(result.output.stdout).includes(first.trim()));
});

test('a piped bare invocation prints help alone', async () => {
  const result = await run({ argv: [], tty: { stdoutIsTty: false } });

  const first = APP.art?.[0] ?? '';
  assert.ok(!stripAnsi(result.output.stdout).includes(first.trim()));
  assert.ok(result.output.stdout.includes('Usage'));
});
