import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectColorLevel, detectUnicode, isCI, type TtyInfo } from '../../src/core/env.ts';
import { createTheme, stringWidth, stripAnsi } from '../../src/core/theme.ts';
import { padEnd, table, truncate, wrapText } from '../../src/core/render.ts';

const tty = (overrides: Partial<TtyInfo> = {}): TtyInfo => ({
  stdoutIsTty: true,
  stdinIsTty: true,
  columns: 80,
  ...overrides,
});

test('colour is gated on stdout, not stdin', () => {
  // The bug this exists to prevent: our other CLI checks stdin.isTTY, so
  // `cmd > file` from a terminal writes escape codes into the file.
  assert.equal(detectColorLevel({ TERM: 'xterm' }, tty({ stdoutIsTty: false })), 'none');
  assert.equal(detectColorLevel({ TERM: 'xterm' }, tty({ stdinIsTty: false })), 'basic');
});

test('NO_COLOR disables colour whatever the terminal says', () => {
  assert.equal(detectColorLevel({ NO_COLOR: '1', TERM: 'xterm-256color' }, tty()), 'none');
});

test('an empty NO_COLOR is not a request for no colour', () => {
  // https://no-color.org — the variable must be present *and* non-empty.
  assert.equal(detectColorLevel({ NO_COLOR: '', TERM: 'xterm-256color' }, tty()), 'ansi256');
});

test('--no-color beats FORCE_COLOR, because the user just typed it', () => {
  assert.equal(
    detectColorLevel({ FORCE_COLOR: '3' }, tty(), { noColor: true }),
    'none',
  );
});

test('FORCE_COLOR re-enables colour when the output is redirected', () => {
  assert.equal(detectColorLevel({ FORCE_COLOR: '1' }, tty({ stdoutIsTty: false })), 'basic');
});

test('TERM=dumb disables colour', () => {
  assert.equal(detectColorLevel({ TERM: 'dumb' }, tty()), 'none');
});

test('CI gets no colour unless it asks', () => {
  assert.equal(detectColorLevel({ CI: 'true', TERM: 'xterm-256color' }, tty()), 'none');
  assert.equal(detectColorLevel({ CI: 'true', FORCE_COLOR: '1' }, tty()), 'basic');
});

test('CI=false is respected', () => {
  assert.equal(isCI({ CI: 'false' }), false);
  assert.equal(isCI({ CI: 'true' }), true);
});

test('unicode is off outside a UTF-8 locale', () => {
  assert.equal(detectUnicode({ LANG: 'en_US.UTF-8' }, 'linux'), true);
  assert.equal(detectUnicode({ LANG: 'C' }, 'linux'), false);
  // The legacy Windows console cannot render the glyph set.
  assert.equal(detectUnicode({}, 'win32'), false);
  assert.equal(detectUnicode({ WT_SESSION: '1' }, 'win32'), true);
});

test('a theme with colour off emits no escapes at all', () => {
  const theme = createTheme({ colorLevel: 'none', unicode: true, columns: 80 });
  const line = theme.ok(theme.accent('done'));
  assert.equal(stripAnsi(line), line);
});

test('a theme with colour on wraps and closes its codes', () => {
  const theme = createTheme({ colorLevel: 'basic', unicode: true, columns: 80 });
  const line = theme.success('ok');
  assert.notEqual(stripAnsi(line), line);
  assert.equal(stripAnsi(line), 'ok');
});

test('glyphs fall back to ASCII when unicode is unavailable', () => {
  const ascii = createTheme({ colorLevel: 'none', unicode: false, columns: 80 });
  assert.equal(ascii.glyph.tick, '+');
  assert.equal(stripAnsi(ascii.ok('done')), '+ done');
});

test('width ignores escape codes', () => {
  const theme = createTheme({ colorLevel: 'basic', unicode: true, columns: 80 });
  assert.equal(stringWidth(theme.success('abc')), 3);
  // padEnd must pad to a *visible* width; String.padEnd counts escape bytes
  // and silently under-pads every coloured cell in a table.
  assert.equal(stringWidth(padEnd(theme.success('abc'), 6)), 6);
});

test('width counts wide characters as two columns', () => {
  assert.equal(stringWidth('日本'), 4);
  assert.equal(stringWidth('ab'), 2);
});

test('wrapping never breaks a long token, so URLs stay copy-pasteable', () => {
  const lines = wrapText('see https://example.com/a/very/long/path/that/exceeds/the/width now', 30);
  assert.ok(lines.some((line) => line.includes('https://example.com/a/very/long/path/that/exceeds/the/width')));
});

test('truncate adds an ellipsis only when it removes something', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(stringWidth(truncate('a much longer string', 10)), 10);
});

test('a table shrinks to the terminal width rather than wrapping', () => {
  const theme = createTheme({ colorLevel: 'none', unicode: false, columns: 30 });
  const lines = table(
    [{ header: 'ID' }, { header: 'TITLE' }],
    [['abcdefghij', 'a very long title that will not fit at all']],
    theme,
  );
  for (const line of lines) assert.ok(stringWidth(line) <= 30, `too wide: ${line}`);
});

test('a table right-aligns the columns that ask for it', () => {
  const theme = createTheme({ colorLevel: 'none', unicode: false, columns: 80 });
  const [, row] = table(
    [{ header: 'NAME' }, { header: 'N', align: 'right' }],
    [['a', '5'], ['bb', '100']],
    theme,
  );
  assert.ok(row !== undefined);
  assert.ok(/\s5$/.test(row), `expected right alignment, got ${JSON.stringify(row)}`);
});
