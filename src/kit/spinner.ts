/**
 * Progress indication.
 *
 * Neither of our other CLIs has any: a 30-second upload prints nothing until
 * it finishes or fails, which is indistinguishable from a hang.
 *
 * Three behaviours, so it is always safe to call:
 *
 *   TTY        → an animated frame, redrawn in place
 *   non-TTY    → the label printed once, and a result line when it finishes
 *   quiet/json → nothing at all
 *
 * The non-TTY case is why this is not optional. A spinner that animates into a
 * CI log produces thousands of lines of escape codes; a spinner that prints
 * nothing leaves the log with no record that the step happened.
 */

import type { OutputStream } from './env.ts';
import type { Theme } from './theme.ts';

const CSI = '\u001b[';
const CLEAR_LINE = `${CSI}2K\r`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

const UNICODE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['-', '\\', '|', '/'];

const FRAME_MS = 80;

export interface Spinner {
  /** Change the label without interrupting the animation. */
  update(text: string): void;
  /** Stop and leave a success line. */
  succeed(text?: string): void;
  /** Stop and leave a failure line. */
  fail(text?: string): void;
  /** Stop and leave a warning line — done, but not cleanly. */
  warn(text?: string): void;
  /** Stop and leave nothing behind. */
  stop(): void;
}

export interface SpinnerFactoryOptions {
  output: OutputStream;
  theme: Theme;
  /** Animate only when there is a terminal to animate on. */
  animate: boolean;
  /** Suppress everything, including the result line. */
  silent: boolean;
}

export type StartSpinner = (text: string) => Spinner;

export const createSpinnerFactory = (options: SpinnerFactoryOptions): StartSpinner => {
  const { output, theme } = options;

  return (initial: string): Spinner => {
    let text = initial;
    let timer: NodeJS.Timeout | undefined;
    let frame = 0;
    let stopped = false;

    const frames = theme.unicode ? UNICODE_FRAMES : ASCII_FRAMES;

    const finish = (line: string | undefined): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (options.silent) return;
      if (options.animate) {
        output.write(CLEAR_LINE);
        output.write(SHOW_CURSOR);
      }
      if (line !== undefined) output.write(`${line}\n`);
    };

    if (!options.silent) {
      if (options.animate) {
        output.write(HIDE_CURSOR);
        const render = (): void => {
          const glyph = frames[frame % frames.length] ?? '';
          output.write(`${CLEAR_LINE}${theme.accent(glyph)} ${text}`);
          frame += 1;
        };
        render();
        timer = setInterval(render, FRAME_MS);
        // A spinner must never be the reason the process stays alive.
        timer.unref?.();
      } else {
        // One line, now, so the log records that the step started even if the
        // process is killed before it ends.
        output.write(`${text}${theme.glyph.ellipsis}\n`);
      }
    }

    return {
      update(next) {
        text = next;
        // In non-animated mode each update is its own line; overwriting is not
        // possible and dropping the update would lose information.
        if (!options.animate && !options.silent && !stopped) {
          output.write(`${next}${theme.glyph.ellipsis}\n`);
        }
      },
      succeed(done) {
        finish(theme.ok(done ?? text));
      },
      fail(done) {
        finish(theme.fail(done ?? text));
      },
      warn(done) {
        finish(theme.warn(done ?? text));
      },
      stop() {
        finish(undefined);
      },
    };
  };
};

/** A spinner that does nothing, for `--json` and `--quiet`. */
export const silentSpinner: StartSpinner = () => ({
  update() {},
  succeed() {},
  fail() {},
  warn() {},
  stop() {},
});
