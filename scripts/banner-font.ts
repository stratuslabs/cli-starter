/**
 * A five-row block font, used once — by `rebrand` — to draw the new binary
 * name as the banner art in `src/app.ts`.
 *
 * This lives in `scripts/` rather than `src/core/` on purpose. Rendering a
 * word into blocks is a build-time job with one caller; shipping a font table
 * inside the CLI would put forty glyphs of data in every adopter's binary to
 * redraw the same fixed string on every run. The art is generated once and
 * checked in, where it can be hand-edited — which is what most people will
 * want to do anyway, because a logo somebody drew beats a logo somebody
 * generated.
 *
 * ASCII only, deliberately. Box-drawing characters look better and break on
 * the terminals that are exactly the reason `theme.glyphs` has a fallback set.
 */

/** Five rows per glyph, all rows of a glyph the same width. */
const FONT: Record<string, readonly string[]> = {
  a: [' ### ', '#   #', '#####', '#   #', '#   #'],
  b: ['#### ', '#   #', '#### ', '#   #', '#### '],
  c: [' ####', '#    ', '#    ', '#    ', ' ####'],
  d: ['#### ', '#   #', '#   #', '#   #', '#### '],
  e: ['#####', '#    ', '#### ', '#    ', '#####'],
  f: ['#####', '#    ', '#### ', '#    ', '#    '],
  g: [' ####', '#    ', '#  ##', '#   #', ' ####'],
  h: ['#   #', '#   #', '#####', '#   #', '#   #'],
  i: ['###', ' # ', ' # ', ' # ', '###'],
  j: ['   ##', '    #', '    #', '#   #', ' ### '],
  k: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  l: ['#    ', '#    ', '#    ', '#    ', '#####'],
  m: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  n: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  o: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  p: ['#### ', '#   #', '#### ', '#    ', '#    '],
  q: [' ### ', '#   #', '#   #', '#  # ', ' ## #'],
  r: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  s: [' ####', '#    ', ' ### ', '    #', '#### '],
  t: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  u: ['#   #', '#   #', '#   #', '#   #', ' ### '],
  v: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
  w: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  x: ['#   #', ' # # ', '  #  ', ' # # ', '#   #'],
  y: ['#   #', ' # # ', '  #  ', '  #  ', '  #  '],
  z: ['#####', '   # ', '  #  ', ' #   ', '#####'],
  '0': [' ### ', '#  ##', '# # #', '##  #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '   # ', '  #  ', '#####'],
  '3': ['#### ', '    #', ' ### ', '    #', '#### '],
  '4': ['#   #', '#   #', '#####', '    #', '    #'],
  '5': ['#####', '#    ', '#### ', '    #', '#### '],
  '6': [' ### ', '#    ', '#### ', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', '  #  '],
  '8': [' ### ', '#   #', ' ### ', '#   #', ' ### '],
  '9': [' ### ', '#   #', ' ####', '    #', ' ### '],
  '-': ['     ', '     ', '#### ', '     ', '     '],
  _: ['     ', '     ', '     ', '     ', '#####'],
  ' ': ['   ', '   ', '   ', '   ', '   '],
};

export const FONT_HEIGHT = 5;

/**
 * Draw `word` in blocks, or return `undefined` if any character has no glyph.
 *
 * Refusing is the right answer for an unknown character: a name rendered with
 * a hole in it is worse than no art at all, and the caller has a sensible
 * fallback (leave the art out and say so).
 *
 * Trailing blanks are trimmed off each row so the art has no invisible width —
 * the banner pads to the widest line, and a row of trailing spaces would push
 * the facts column right for no visible reason.
 */
export const renderWord = (word: string): string[] | undefined => {
  const glyphs = [...word.toLowerCase()].map((character) => FONT[character]);
  if (glyphs.some((glyph) => glyph === undefined)) return undefined;

  const rows: string[] = [];
  for (let row = 0; row < FONT_HEIGHT; row += 1) {
    rows.push(
      glyphs
        .map((glyph) => glyph?.[row] ?? '')
        .join(' ')
        .replace(/\s+$/, ''),
    );
  }

  // An all-blank leading or trailing row happens with words made only of
  // characters that do not reach full height; nothing here does today, but
  // dropping them keeps the art tight if a glyph is ever added that does.
  while (rows.length > 0 && rows[0]?.trim() === '') rows.shift();
  while (rows.length > 0 && rows[rows.length - 1]?.trim() === '') rows.pop();

  return rows;
};
