/**
 * The logo-beside-facts banner, in the shape `neofetch` made familiar.
 *
 * It exists because a CLI's first impression is worth something, and a wall of
 * help text is not one. It is also the easiest thing in a CLI to get
 * *obnoxious*, so the rules below are the point of this module — the art is
 * the easy part.
 *
 * **A banner is never printed on a command that does work.** It appears when
 * somebody types the bare binary name and is plainly asking "what is this",
 * and when they ask for it outright. Never before `login`, never above a table
 * of results, never in a log.
 *
 * `shouldShowBanner` is the whole policy, in one function, so a new call site
 * cannot invent its own rules.
 */

import type { CliEnvironment } from './env.ts';
import { isCI } from './env.ts';
import { padEnd } from './render.ts';
import { stringWidth, type Theme } from './theme.ts';

/**
 * The facts a banner shows beside the art.
 *
 * Deliberately local: version, runtime, platform. Nothing here reaches the
 * network or reads a credential, because this renders before the user has
 * asked the CLI to do anything, and a banner that can hang or fail is a
 * banner that turns `acme` into a support ticket.
 */
export const programFacts = (
  program: { name: string; version: string },
  env: { platform: string },
): BannerFact[] => [
  { label: 'cli', value: `${program.name} ${program.version}` },
  { label: 'node', value: process.versions.node },
  { label: 'platform', value: env.platform },
];

/** A fact in the right-hand column. */
export interface BannerFact {
  label: string;
  value: string;
}

export interface BannerOptions {
  /** Blank line between the art and the facts. */
  gap?: number;
  /** Colour for the art. Defaults to the theme's accent. */
  paint?: (text: string) => string;
}

/**
 * May a banner be shown right now?
 *
 * Every clause is a way this becomes noise rather than charm:
 *
 * - **not a TTY** — it is being piped or redirected, and art in a file or a
 *   pipe is corruption, not decoration.
 * - **`--json`** — stdout is a contract. Nothing else may appear there.
 * - **`--quiet`** — the user said less, and this is the most skippable thing
 *   the CLI can print.
 * - **CI** — nobody reads it, and it costs a screen of every build log.
 * - **no art** — an adopter who deletes the art gets no empty frame.
 */
export const shouldShowBanner = (
  env: CliEnvironment,
  globals: { json: boolean; quiet: boolean },
  art: readonly string[] | undefined,
): boolean => {
  if (art === undefined || art.length === 0) return false;
  if (globals.json || globals.quiet) return false;
  if (!env.tty.stdoutIsTty) return false;
  if (isCI(env.processEnv)) return false;
  return true;
};

/**
 * Render art on the left, facts on the right.
 *
 * Falls back to stacking when the terminal is too narrow to hold both. A
 * side-by-side layout that overflows wraps into interleaved nonsense, which
 * looks far worse than two blocks — and 80 columns is not a safe assumption
 * when half the world reads this in a split pane.
 */
export const renderBanner = (
  art: readonly string[],
  facts: readonly BannerFact[],
  theme: Theme,
  options: BannerOptions = {},
): string[] => {
  const gap = options.gap ?? 3;
  const paint = options.paint ?? theme.accent;

  const artWidth = Math.max(0, ...art.map((line) => stringWidth(line)));
  const labelWidth = Math.max(0, ...facts.map((fact) => stringWidth(fact.label)));
  const factWidth = Math.max(
    0,
    ...facts.map((fact) => labelWidth + 2 + stringWidth(fact.value)),
  );

  const renderFact = (fact: BannerFact): string =>
    `${theme.accent(padEnd(fact.label, labelWidth))}  ${fact.value}`;

  // Stack when side-by-side would not fit.
  if (artWidth + gap + factWidth > theme.columns) {
    return [...art.map((line) => paint(line)), '', ...facts.map(renderFact)];
  }

  const height = Math.max(art.length, facts.length);
  const lines: string[] = [];

  for (let index = 0; index < height; index += 1) {
    const artLine = art[index] ?? '';
    const fact = facts[index];

    if (fact === undefined) {
      // Nothing to align against, so no padding: a line of trailing spaces is
      // invisible until someone copies the output into a diff or a commit
      // message, where it is a lint failure with no obvious cause.
      lines.push(artLine === '' ? '' : paint(artLine));
      continue;
    }

    // Padded before painting. `padEnd` here measures visible width, so either
    // order works — but the plain string is the one whose width is obvious, and
    // the language's own `String.prototype.padEnd` counts escape sequences. A
    // later edit that reaches for the builtin stays correct this way round.
    const left = padEnd(artLine, artWidth);
    const painted = artLine === '' ? left : paint(left);

    lines.push(`${painted}${' '.repeat(gap)}${renderFact(fact)}`);
  }

  return lines;
};
