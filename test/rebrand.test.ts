/**
 * The invariant that keeps `rebrand.ts` from corrupting an adopter's docs.
 *
 * Rebrand rewrites the documentation with a whole-word find-and-replace on the
 * placeholder binary name. That is safe only while the placeholder never
 * appears in prose — otherwise a sentence about the project gets the adopter's
 * binary name substituted into it, on the one run they cannot repeat.
 *
 * This is not hypothetical. The placeholder was `kit`, and the README's own
 * Contributing section said "a flow the auth kit does not cover", which
 * matched.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  PLACEHOLDER,
  PLACEHOLDER_ENV,
  PLACEHOLDER_HOME,
  PLACEHOLDER_WORD,
  REBRANDED_DOCS,
} from '../scripts/placeholder.ts';

const root = join(import.meta.dirname, '..');

/**
 * Strip fenced code blocks and inline code.
 *
 * What is left is prose — the part rebrand must not touch, and the only part
 * this test cares about.
 */
const prose = (markdown: string): string =>
  markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

test('the placeholder never appears in the prose of the docs rebrand rewrites', async () => {
  for (const file of REBRANDED_DOCS) {
    const text = prose(await readFile(join(root, file), 'utf8'));

    for (const [pattern, what] of [
      [PLACEHOLDER_WORD, 'an invocation'],
      [PLACEHOLDER_HOME, 'a home directory'],
      [PLACEHOLDER_ENV, 'an environment variable'],
    ] as const) {
      const hits = text.match(pattern) ?? [];
      assert.deepEqual(
        hits,
        [],
        `${file}: rebrand would rewrite ${what} in prose — ${JSON.stringify(hits)}. ` +
          `Put it in backticks, or reword it.`,
      );
    }
  }
});

test('the placeholder is not a word anyone writes by accident', async () => {
  // The property that makes the test above hold by construction rather than by
  // vigilance. A placeholder that is an ordinary English word — `kit`, `tool`,
  // `app`, and `cli` worst of all — will eventually appear in a sentence.
  const readme = prose(await readFile(join(root, 'README.md'), 'utf8')).toLowerCase();
  const words = readme.match(/[a-z]+/g) ?? [];

  assert.ok(words.length > 100, 'expected to have read the README');
  assert.equal(
    words.filter((word) => word === PLACEHOLDER).length,
    0,
    `"${PLACEHOLDER}" is common enough in this README's prose to be a risky placeholder.`,
  );
});

test('the placeholder does not collide with a real command', async () => {
  // `demo` would have: src/commands/demo.ts exists, so rebrand's rewrite would
  // mangle every mention of the demo command.
  const main = await readFile(join(root, 'src/main.ts'), 'utf8');
  assert.doesNotMatch(main, new RegExp(`name: '${PLACEHOLDER}'`));
});
