/**
 * Layout primitives: wrapping, two-column lists, tables, boxes.
 *
 * All of them are width-aware, reading the terminal width from the theme
 * rather than assuming 80 or hard-coding a `padEnd(34)`. That is the fix for
 * output in our other CLI that wraps unpredictably the moment a model id or a
 * file path is longer than the author's terminal was on the day they wrote it.
 */

import { stringWidth, type Theme } from './theme.ts';

/** Narrowest width we will lay out for; below this, wrapping makes things worse. */
const MIN_WIDTH = 20;

/** Pad to a visible width, ignoring ANSI. `padEnd` counts escape bytes. */
export const padEnd = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - stringWidth(text)));

/** Truncate to a visible width, with an ellipsis when anything was dropped. */
export const truncate = (text: string, width: number, ellipsis = '…'): string => {
  if (stringWidth(text) <= width) return text;
  const limit = Math.max(0, width - stringWidth(ellipsis));
  let out = '';
  for (const char of text) {
    if (stringWidth(out + char) > limit) break;
    out += char;
  }
  return out + ellipsis;
};

/**
 * Greedy word wrap. Words longer than the width (URLs, tokens) are emitted
 * whole and allowed to overflow rather than being broken — a hard-broken URL
 * is not copy-pasteable, which defeats the reason it was printed.
 */
export const wrapText = (text: string, width: number): string[] => {
  const usable = Math.max(MIN_WIDTH, width);
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line === '') {
        line = word;
      } else if (stringWidth(line) + 1 + stringWidth(word) <= usable) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line !== '') lines.push(line);
  }

  return lines;
};

export interface DefinitionItem {
  term: string;
  description: string;
}

export interface DefinitionListOptions {
  indent?: number;
  /** Spaces between the term column and the description column. */
  gap?: number;
  /** Terms wider than this wrap onto their own line instead of stretching the column. */
  maxTermWidth?: number;
}

/**
 * The `term    description` layout used by help, doctor, and status output.
 *
 * The term column is sized to the widest term, so it is never a magic number.
 * When one outlier term would squeeze the descriptions into a ravine, that term
 * gets its own line and the column stays readable.
 */
export const definitionList = (
  items: readonly DefinitionItem[],
  theme: Theme,
  options: DefinitionListOptions = {},
): string[] => {
  if (items.length === 0) return [];

  const indent = options.indent ?? 2;
  const gap = options.gap ?? 2;
  const maxTermWidth = options.maxTermWidth ?? Math.max(12, Math.floor(theme.columns / 3));

  const inlineTerms = items.filter((item) => stringWidth(item.term) <= maxTermWidth);
  const termWidth = inlineTerms.reduce((widest, item) => Math.max(widest, stringWidth(item.term)), 0);

  const descriptionWidth = Math.max(MIN_WIDTH, theme.columns - indent - termWidth - gap);
  const pad = ' '.repeat(indent);
  const lines: string[] = [];

  for (const item of items) {
    const wrapped = wrapText(item.description, descriptionWidth);

    if (stringWidth(item.term) > maxTermWidth) {
      lines.push(`${pad}${item.term}`);
      const deep = ' '.repeat(indent + 2);
      for (const line of wrapText(item.description, Math.max(MIN_WIDTH, theme.columns - indent - 2))) {
        lines.push(`${deep}${theme.muted(line)}`);
      }
      continue;
    }

    const continuation = ' '.repeat(indent + termWidth + gap);
    wrapped.forEach((line, index) => {
      lines.push(
        index === 0
          ? `${pad}${padEnd(item.term, termWidth)}${' '.repeat(gap)}${line}`
          : `${continuation}${line}`,
      );
    });
    if (wrapped.length === 0) lines.push(`${pad}${item.term}`);
  }

  return lines;
};

export interface TableColumn {
  header: string;
  /** Right-align numeric columns so digits line up. */
  align?: 'left' | 'right';
}

/**
 * A plain aligned table — no borders, because borders cost horizontal space
 * that a terminal rarely has to spare and add nothing to scanability.
 *
 * Columns are shrunk proportionally when the total exceeds the terminal width,
 * so a long value truncates instead of wrapping the whole row into confetti.
 */
export const table = (
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  theme: Theme,
  indent = 2,
): string[] => {
  if (columns.length === 0) return [];

  const gap = 2;
  const natural = columns.map((column, index) =>
    Math.max(stringWidth(column.header), ...rows.map((row) => stringWidth(row[index] ?? ''))),
  );

  const available = Math.max(MIN_WIDTH, theme.columns - indent - gap * (columns.length - 1));
  const total = natural.reduce((sum, width) => sum + width, 0);
  const widths =
    total <= available
      ? natural
      : natural.map((width) => Math.max(3, Math.floor((width / total) * available)));

  const pad = ' '.repeat(indent);
  const separator = ' '.repeat(gap);

  const renderRow = (cells: readonly string[], style: (text: string) => string): string => {
    const rendered = cells.map((cell, index) => {
      const width = widths[index] ?? 0;
      const clipped = truncate(cell, width, theme.glyph.ellipsis);
      const aligned =
        columns[index]?.align === 'right'
          ? ' '.repeat(Math.max(0, width - stringWidth(clipped))) + clipped
          : padEnd(clipped, width);
      return style(aligned);
    });
    // Trailing padding on the last column is invisible but shows up in
    // snapshots and in copied text, so drop it.
    return `${pad}${rendered.join(separator)}`.replace(/\s+$/, '');
  };

  return [
    renderRow(columns.map((column) => column.header), theme.muted),
    ...rows.map((row) => renderRow(row, (text) => text)),
  ];
};

export interface BoxOptions {
  /** Rendered into the top border. */
  title?: string;
  indent?: number;
}

/** A bordered block. Used for the header and for anything that must interrupt. */
export const box = (lines: readonly string[], theme: Theme, options: BoxOptions = {}): string[] => {
  const indent = ' '.repeat(options.indent ?? 0);
  const glyph = theme.glyph;
  const inner = Math.max(
    stringWidth(options.title ?? '') + 2,
    ...lines.map((line) => stringWidth(line)),
  );
  const width = inner + 2;

  const top =
    options.title === undefined
      ? `${glyph.boxTopLeft}${glyph.boxHorizontal.repeat(width)}${glyph.boxTopRight}`
      : `${glyph.boxTopLeft}${glyph.boxHorizontal} ${options.title} ${glyph.boxHorizontal.repeat(
          Math.max(0, width - stringWidth(options.title) - 3),
        )}${glyph.boxTopRight}`;

  return [
    `${indent}${theme.muted(top)}`,
    ...lines.map(
      (line) =>
        `${indent}${theme.muted(glyph.boxVertical)} ${padEnd(line, inner)} ${theme.muted(glyph.boxVertical)}`,
    ),
    `${indent}${theme.muted(
      `${glyph.boxBottomLeft}${glyph.boxHorizontal.repeat(width)}${glyph.boxBottomRight}`,
    )}`,
  ];
};

/** `1 post` / `2 posts`, because "1 post(s)" reads like a placeholder. */
export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;
