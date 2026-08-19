/**
 * The only module in this repo that contains an ANSI escape sequence.
 *
 * Everything else asks the theme for `theme.success('...')` and never learns
 * what colour that is. Two payoffs: an adopter re-skins the whole CLI by
 * editing the palette below, and `--no-color` is enforced in one place instead
 * of being forgotten at the twelfth call site.
 *
 * If you find yourself typing `\u001b[` anywhere else, that is the bug.
 */

import type { ColorLevel } from './env.ts';

const ESC = '\u001b[';

/** [open, close] SGR parameter pairs. */
const CODES = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
} as const;

type CodeName = keyof typeof CODES;

export type Styler = (text: string) => string;

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Remove every SGR sequence. Used for width maths and readable snapshots. */
export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '');

/**
 * Printable width of a string, ANSI-aware and roughly wide-character aware.
 *
 * Table alignment is wrong without this: `'…'.length` counts a code unit, not a
 * column, and CJK text and emoji occupy two columns each. This is not a full
 * grapheme segmenter — it is the 95% that keeps columns straight.
 */
export const stringWidth = (text: string): number => {
  const plain = stripAnsi(text);
  let width = 0;
  for (const char of plain) {
    const point = char.codePointAt(0);
    if (point === undefined) continue;
    // Zero-width: combining marks, joiners, variation selectors.
    if (point === 0x200d || (point >= 0x0300 && point <= 0x036f) || (point >= 0xfe00 && point <= 0xfe0f)) {
      continue;
    }
    const wide =
      (point >= 0x1100 && point <= 0x115f) ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x1f300 && point <= 0x1f64f) ||
      (point >= 0x1f900 && point <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
};

/** The semantic vocabulary. Commands use these names, never colours. */
export interface Theme {
  colorLevel: ColorLevel;
  unicode: boolean;
  columns: number;

  bold: Styler;
  dim: Styler;
  underline: Styler;

  /** A completed action. */
  success: Styler;
  /** A failure. */
  danger: Styler;
  /** Something survivable that the user should still see. */
  warning: Styler;
  /** Secondary text: provenance, counts, timestamps. */
  muted: Styler;
  /** The one thing on the line the eye should land on. */
  accent: Styler;
  /** A command the user can paste. */
  command: Styler;
  /** A URL. */
  url: Styler;
  /** A section heading. */
  heading: Styler;

  glyph: Glyphs;

  /** Status lines: glyph + colour + message, so they are identical everywhere. */
  ok(message: string): string;
  fail(message: string): string;
  warn(message: string): string;
  info(message: string): string;
  detail(message: string): string;
}

export interface Glyphs {
  tick: string;
  cross: string;
  warn: string;
  bullet: string;
  dot: string;
  pointer: string;
  ellipsis: string;
  boxTopLeft: string;
  boxTopRight: string;
  boxBottomLeft: string;
  boxBottomRight: string;
  boxHorizontal: string;
  boxVertical: string;
}

const UNICODE_GLYPHS: Glyphs = {
  tick: '✓',
  cross: '✗',
  warn: '!',
  bullet: '•',
  dot: '·',
  pointer: '❯',
  ellipsis: '…',
  boxTopLeft: '╭',
  boxTopRight: '╮',
  boxBottomLeft: '╰',
  boxBottomRight: '╯',
  boxHorizontal: '─',
  boxVertical: '│',
};

/**
 * The ASCII fallback. Same column widths as the Unicode set wherever it
 * matters, so a table does not shift when the locale changes.
 */
const ASCII_GLYPHS: Glyphs = {
  tick: '+',
  cross: 'x',
  warn: '!',
  bullet: '*',
  dot: '.',
  pointer: '>',
  ellipsis: '...',
  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+',
  boxHorizontal: '-',
  boxVertical: '|',
};

export interface ThemeOptions {
  colorLevel: ColorLevel;
  unicode: boolean;
  columns: number;
}

export const createTheme = (options: ThemeOptions): Theme => {
  const enabled = options.colorLevel !== 'none';

  const style = (...names: CodeName[]): Styler => {
    if (!enabled) return (text) => text;
    const open = names.map((name) => `${ESC}${CODES[name][0]}m`).join('');
    // Close in reverse so nesting a styler inside another restores correctly.
    const close = [...names].reverse().map((name) => `${ESC}${CODES[name][1]}m`).join('');
    return (text) => `${open}${text}${close}`;
  };

  const glyph = options.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;

  const bold = style('bold');
  const dim = style('dim');
  const success = style('green');
  const danger = style('red');
  const warning = style('yellow');
  const muted = style('gray');
  const accent = style('cyan');

  return {
    colorLevel: options.colorLevel,
    unicode: options.unicode,
    columns: options.columns,

    bold,
    dim,
    underline: style('underline'),

    success,
    danger,
    warning,
    muted,
    accent,
    command: style('cyan'),
    url: style('blue', 'underline'),
    heading: style('bold'),

    glyph,

    ok: (message) => `${success(glyph.tick)} ${message}`,
    fail: (message) => `${danger(glyph.cross)} ${message}`,
    warn: (message) => `${warning(glyph.warn)} ${message}`,
    info: (message) => `${accent(glyph.bullet)} ${message}`,
    detail: (message) => muted(`${glyph.dot} ${message}`),
  };
};

/** A theme that emits no escapes — the default for tests and for `--json`. */
export const plainTheme = (columns = 80): Theme =>
  createTheme({ colorLevel: 'none', unicode: false, columns });
