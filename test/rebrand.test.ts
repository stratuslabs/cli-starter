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
import { FONT_HEIGHT, renderWord } from '../scripts/banner-font.ts';

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

/* -- the banner art rebrand redraws --------------------------------------- */

test('the block font renders a name, and refuses one it cannot', () => {
  const rows = renderWord('acme');
  assert.ok(rows !== undefined);
  assert.equal(rows.length, FONT_HEIGHT);

  // Every row the same visible width would mean trailing blanks were kept,
  // which pads the banner's left column for no visible reason.
  const widths = new Set(rows.map((row) => row.length));
  assert.ok(widths.size > 1, 'trailing blanks should be trimmed');
  assert.ok(rows.some((row) => row.includes('#')), 'expected something drawn');

  // A name with a character the font has no glyph for gets no art at all —
  // better than a logo with a hole in it.
  assert.equal(renderWord('acme!'), undefined);
});

test('the art block rebrand writes into app.ts parses back to the same rows', async () => {
  // rebrand rewrites src/app.ts with a regex, so the shape it emits has to be
  // the shape the file already has, or the next run finds nothing to replace.
  const app = await readFile(join(root, 'src/app.ts'), 'utf8');
  const block = /\n  art: \[[\s\S]*?\n  \],/.exec(app);
  assert.ok(block !== null, 'src/app.ts has an art block for rebrand to replace');

  const rows = renderWord('demo');
  assert.ok(rows !== undefined);
  const written = `\n  art: [\n${rows.map((row) => `    '${row}',`).join('\n')}\n  ],`;
  assert.match(written, /\n  art: \[[\s\S]*?\n  \],/);
  assert.equal(app.replace(/\n  art: \[[\s\S]*?\n  \],/, () => written).includes(rows[0] ?? ''), true);
});
