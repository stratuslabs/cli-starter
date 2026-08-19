/**
 * The injection seam.
 *
 * Every capability that touches the outside world — streams, the clock, the
 * filesystem root, the network, the browser — arrives through `CliEnvironment`
 * rather than being imported at the point of use. That single decision is what
 * lets the entire test suite run in-process with no spawned subprocesses, no
 * temp `$HOME` leaking between cases, and no network.
 *
 * If you are adding a module that reaches outside the process, add it here
 * first. Importing `node:fs` directly inside a command is the thing this file
 * exists to prevent.
 */

import type { Readable } from 'node:stream';

/** The narrowest useful view of a writable stream. */
export interface OutputStream {
  write(chunk: string): boolean | void;
}

export interface CliStreams {
  /** Data. Anything a script would parse. */
  stdout: OutputStream;
  /** Chrome: prompts, spinners, warnings, errors, progress. */
  stderr: OutputStream;
}

/** Terminal facts, injected so tests can claim to be a TTY without being one. */
export interface TtyInfo {
  stdoutIsTty: boolean;
  stdinIsTty: boolean;
  /** Usable width. Falls back to 80 when the terminal will not say. */
  columns: number;
}

export interface CliEnvironment {
  processEnv: Record<string, string | undefined>;
  cwd: string;
  /** Root for `~/.<brand>/`. A temp dir under test. */
  homeDir: string;
  platform: NodeJS.Platform;
  tty: TtyInfo;
  /** Present only when something can actually be read from it. */
  stdin?: Readable;
  fetch: typeof globalThis.fetch;
  /** Open a URL in the user's browser. Rejects if no opener is available. */
  openExternal(url: string): Promise<void>;
  /** Injected so time-dependent output is assertable. */
  now(): Date;
  /** Aborted on SIGINT/SIGTERM so long operations can unwind cleanly. */
  signal?: AbortSignal;
}

export type ColorLevel = 'none' | 'basic' | 'ansi256' | 'truecolor';

/** Explicit, this-invocation overrides. These beat ambient environment. */
export interface ColorPreference {
  /** `--no-color` was passed. */
  noColor?: boolean;
  /** `--color` was passed. */
  forceColor?: boolean;
}

const CI_VARIABLES = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_NUMBER',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'TEAMCITY_VERSION',
];

export const isCI = (env: Record<string, string | undefined>): boolean =>
  CI_VARIABLES.some((name) => {
    const value = env[name];
    // `CI=false` is set deliberately by people who mean it.
    return value !== undefined && value !== '' && value !== 'false' && value !== '0';
  });

/**
 * Decide whether to emit ANSI colour, and how much.
 *
 * Order matters, and the top of it is the fix for a real bug in our other CLI:
 * colour there is gated on `stdin.isTTY`, so `cmd > out.txt` run from a
 * terminal writes escape codes into the file. Colour is a property of **where
 * output goes**, so it is gated on stdout — never on stdin.
 */
export const detectColorLevel = (
  env: Record<string, string | undefined>,
  tty: TtyInfo,
  preference: ColorPreference = {},
): ColorLevel => {
  // A flag typed on this invocation beats anything ambient.
  if (preference.noColor === true) return 'none';
  if (preference.forceColor === true) return 'basic';

  // https://no-color.org — any non-empty value means "no colour".
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return 'none';

  const forceColor = env['FORCE_COLOR'];
  if (forceColor !== undefined && forceColor !== '') {
    if (forceColor === '0' || forceColor === 'false') return 'none';
    if (forceColor === '2') return 'ansi256';
    if (forceColor === '3') return 'truecolor';
    return 'basic';
  }

  if (env['TERM'] === 'dumb') return 'none';
  if (!tty.stdoutIsTty) return 'none';
  // CI logs are read as files far more often than as terminals, and most CI
  // runners claim a TTY. FORCE_COLOR above is the opt back in.
  if (isCI(env)) return 'none';

  const colorterm = env['COLORTERM'];
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';

  const term = env['TERM'] ?? '';
  if (term.includes('256color')) return 'ansi256';
  if (term === '') return env['WT_SESSION'] === undefined ? 'none' : 'truecolor';
  return 'basic';
};

/**
 * Whether box-drawing characters and the ✓/✗ glyph set will render.
 *
 * When this is false the theme swaps in an ASCII vocabulary. Our other CLI
 * prints `📝`/`🗓`/`📢` unconditionally; those come out as replacement boxes in
 * CI logs, in `cmd.exe`, and under a non-UTF-8 locale.
 */
export const detectUnicode = (
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): boolean => {
  if (platform === 'win32') {
    // Windows Terminal and VS Code's terminal handle it; the legacy console does not.
    return env['WT_SESSION'] !== undefined || env['TERM_PROGRAM'] === 'vscode';
  }
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  return /UTF-?8$/i.test(locale);
};

/**
 * Whether we may prompt.
 *
 * Requires a TTY on **both** ends: something to draw a menu on, and something
 * to read keys from. CI is excluded even when it fakes a TTY, because a
 * prompt there is a hang, and a hung CI job is much worse than a clear failure.
 */
export const isInteractive = (env: CliEnvironment): boolean =>
  env.tty.stdinIsTty && env.tty.stdoutIsTty && !isCI(env.processEnv);
