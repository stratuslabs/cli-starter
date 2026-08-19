/**
 * Prompts.
 *
 * One interface, three implementations, chosen by what the process is attached
 * to:
 *
 *   interactive → a real terminal: arrow-key menus, masked secrets, redraw
 *   plain       → piped stdin (scripts, tests): numbered lists, one line each
 *   refusing    → nothing to ask: every prompt throws NonInteractiveError,
 *                 naming the flag that would have answered it
 *
 * The third one matters as much as the first. A prompt that blocks forever in
 * CI is the worst failure mode a CLI has, because it burns a runner slot and
 * reports nothing.
 */

import type { Readable } from 'node:stream';

import { InterruptedError, NonInteractiveError } from './errors.ts';
import { ESCAPE_TIMEOUT_MS, KeyDecoder, type Key } from './keys.ts';
import type { Theme } from './theme.ts';
import type { OutputStream } from './env.ts';

const CSI = '\u001b[';
const CLEAR_LINE = `${CSI}2K\r`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

export interface SelectOption<T> {
  value: T;
  label: string;
  /** Right-hand column: current value, provenance, a warning. */
  hint?: string;
  disabled?: boolean;
}

export interface SelectRequest<T> {
  message: string;
  options: SelectOption<T>[];
  /** Index highlighted on open. */
  initial?: number;
  /** A line under the message: constraints, or what Esc will do. */
  footnote?: string;
  /** Esc/q resolves as `{kind:'back'}` instead of cancelling. */
  allowBack?: boolean;
  /** Typing resolves as `{kind:'text'}` — the escape hatch for long lists. */
  allowText?: boolean;
}

export type SelectResult<T> =
  | { kind: 'value'; value: T; index: number }
  | { kind: 'back' }
  | { kind: 'text'; text: string };

export interface TextRequest {
  message: string;
  /** Pre-typed and editable — Enter keeps it, Backspace edits it. */
  initial?: string;
  placeholder?: string;
  /** Return a message to reject and re-ask; return undefined to accept. */
  validate?(value: string): string | undefined;
}

export interface ConfirmRequest {
  message: string;
  /** Used for a bare Enter, and returned wholesale under `--yes`. */
  initial?: boolean;
}

export interface MultiSelectRequest<T> {
  message: string;
  options: SelectOption<T>[];
  /** Indexes ticked on open. */
  initial?: number[];
  footnote?: string;
}

export interface Prompter {
  isInteractive(): boolean;
  select<T>(request: SelectRequest<T>): Promise<SelectResult<T>>;
  multiselect<T>(request: MultiSelectRequest<T>): Promise<T[]>;
  text(request: TextRequest): Promise<string>;
  /** Never echoed, never logged, never placed in argv. */
  secret(request: TextRequest): Promise<string>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  close(): void;
}

/* ------------------------------------------------------------------ */
/* key reader                                                          */
/* ------------------------------------------------------------------ */

interface RawStdin extends Readable {
  setRawMode?(mode: boolean): void;
  isRaw?: boolean;
}

export interface KeyReader {
  next(): Promise<Key>;
  close(): void;
}

/**
 * Turn a byte stream into a queue of keys.
 *
 * The queue is the subtle part. Keys that arrive while nothing is waiting are
 * *kept*, so a user who types ahead through several menus — or pastes a value
 * that begins with the digit that selects the menu item — gets what they typed
 * rather than having it dropped between prompts.
 */
export const createKeyReader = (
  stdin: RawStdin,
  options: { escapeTimeoutMs?: number } = {},
): KeyReader => {
  const decoder = new KeyDecoder();
  const queue: Key[] = [];
  const waiters: ((key: Key) => void)[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const deliver = (keys: readonly Key[]): void => {
    for (const key of keys) {
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(key);
      else waiter(key);
    }
  };

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const armEscapeTimer = (): void => {
    clearTimer();
    if (decoder.pending === '') return;
    // Deliberately *not* unref'd. This timer is the only thing that can ever
    // resolve a lone Esc into a keypress; if it does not hold the event loop,
    // a prompt waiting on Escape hangs whenever nothing else has work pending.
    // It is armed only while an incomplete sequence is buffered and lasts 75ms,
    // so it cannot meaningfully delay exit.
    timer = setTimeout(() => {
      timer = undefined;
      deliver(decoder.flushPending());
    }, options.escapeTimeoutMs ?? ESCAPE_TIMEOUT_MS);
  };

  const onData = (chunk: Buffer | string): void => {
    deliver(decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    armEscapeTimer();
  };

  const onEnd = (): void => {
    clearTimer();
    deliver(decoder.flushPending());
    // Unblock anyone still waiting, rather than hanging on a closed stream.
    deliver(waiters.map(() => ({ name: 'eof', raw: '' })));
  };

  stdin.on('data', onData);
  stdin.once('end', onEnd);
  stdin.once('close', onEnd);

  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode?.(true);
  stdin.resume();

  return {
    next() {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve({ name: 'eof', raw: '' });
      return new Promise<Key>((resolve) => waiters.push(resolve));
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimer();
      stdin.off('data', onData);
      if (!wasRaw) stdin.setRawMode?.(false);
      // Pause rather than destroy: the stream is the process's stdin and
      // something after us may still want it.
      stdin.pause();
    },
  };
};

/* ------------------------------------------------------------------ */
/* interactive prompter                                                */
/* ------------------------------------------------------------------ */

export interface InteractivePrompterOptions {
  stdin: RawStdin;
  output: OutputStream;
  theme: Theme;
  escapeTimeoutMs?: number;
}

/**
 * A block of lines that can redraw itself in place.
 *
 * Redraw moves the cursor up over the previous block and rewrites it, clearing
 * each line first. When the new block is shorter, the leftover lines are
 * cleared too — otherwise a filtered list leaves the tail of the old list on
 * screen, which reads as a rendering bug.
 */
const createFrame = (output: OutputStream) => {
  let drawn = 0;
  return {
    render(lines: readonly string[]): void {
      if (drawn > 0) output.write(`${CSI}${drawn}A`);
      for (const line of lines) output.write(`${CLEAR_LINE}${line}\n`);
      const surplus = drawn - lines.length;
      for (let index = 0; index < surplus; index += 1) output.write(`${CLEAR_LINE}\n`);
      if (surplus > 0) output.write(`${CSI}${surplus}A`);
      drawn = lines.length;
    },
    /** Leave the block on screen and stop tracking it. */
    seal(): void {
      drawn = 0;
    },
  };
};

export const createInteractivePrompter = (options: InteractivePrompterOptions): Prompter => {
  const { output, theme } = options;
  const reader = createKeyReader(options.stdin, {
    ...(options.escapeTimeoutMs === undefined ? {} : { escapeTimeoutMs: options.escapeTimeoutMs }),
  });
  let cursorHidden = false;

  const hideCursor = (): void => {
    if (cursorHidden) return;
    output.write(HIDE_CURSOR);
    cursorHidden = true;
  };

  const showCursor = (): void => {
    if (!cursorHidden) return;
    output.write(SHOW_CURSOR);
    cursorHidden = false;
  };

  // A hidden cursor is process-global terminal state. If we exit without
  // restoring it the user's shell is left with an invisible cursor and no idea
  // why, so every exit path — return, throw, Ctrl-C — goes through here.
  const finish = <T>(value: T): T => {
    showCursor();
    return value;
  };

  const cancel = (): never => {
    showCursor();
    output.write('\n');
    throw new InterruptedError();
  };

  const optionLine = <T>(
    option: SelectOption<T>,
    index: number,
    active: boolean,
    marker?: string,
  ): string => {
    const pointer = active ? theme.accent(`${theme.glyph.pointer} `) : '  ';
    const number = theme.muted(`${index + 1})`);
    const label = option.disabled === true ? theme.muted(`${option.label} (unavailable)`) : option.label;
    const body = active ? theme.accent(label) : label;
    const hint = option.hint === undefined ? '' : ` ${theme.muted(option.hint)}`;
    const tick = marker === undefined ? '' : `${marker} `;
    return `${pointer}${number} ${tick}${body}${hint}`;
  };

  const moveActive = <T>(options: readonly SelectOption<T>[], from: number, step: number): number => {
    if (options.length === 0) return from;
    let next = from;
    // Wrap, and never land on a disabled row.
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      next = (next + step + options.length) % options.length;
      if (options[next]?.disabled !== true) return next;
    }
    return from;
  };

  const select = async <T>(request: SelectRequest<T>): Promise<SelectResult<T>> => {
    const frame = createFrame(output);
    let active = Math.min(Math.max(request.initial ?? 0, 0), Math.max(0, request.options.length - 1));
    if (request.options[active]?.disabled === true) active = moveActive(request.options, active, 1);
    let typed = '';

    hideCursor();

    const draw = (): void => {
      const lines = [theme.bold(request.message)];
      if (request.footnote !== undefined) lines.push(theme.muted(request.footnote));
      request.options.forEach((option, index) => {
        lines.push(optionLine(option, index, index === active));
      });
      if (request.allowText === true) {
        lines.push(
          typed === ''
            ? theme.muted('  or type a value and press Enter')
            : `  ${theme.muted('>')} ${typed}`,
        );
      }
      frame.render(lines);
    };

    draw();

    for (;;) {
      const key = await reader.next();

      if (key.name === 'ctrl-c') cancel();
      if (key.name === 'eof') {
        frame.seal();
        return finish<SelectResult<T>>({ kind: 'back' });
      }

      if (key.name === 'up' || (key.name === 'char' && key.ch === 'k' && typed === '')) {
        active = moveActive(request.options, active, -1);
        draw();
        continue;
      }
      if (
        key.name === 'down' ||
        key.name === 'tab' ||
        (key.name === 'char' && key.ch === 'j' && typed === '')
      ) {
        active = moveActive(request.options, active, 1);
        draw();
        continue;
      }

      if (key.name === 'escape' || (key.name === 'char' && key.ch === 'q' && typed === '')) {
        if (request.allowBack !== true) cancel();
        frame.seal();
        output.write('\n');
        return finish<SelectResult<T>>({ kind: 'back' });
      }

      if (key.name === 'enter') {
        if (request.allowText === true && typed !== '') {
          frame.seal();
          output.write('\n');
          return finish<SelectResult<T>>({ kind: 'text', text: typed });
        }
        const option = request.options[active];
        if (option === undefined || option.disabled === true) continue;
        frame.seal();
        output.write('\n');
        return finish<SelectResult<T>>({ kind: 'value', value: option.value, index: active });
      }

      if (key.name === 'backspace' && typed !== '') {
        typed = typed.slice(0, -1);
        draw();
        continue;
      }

      if (key.name === 'char' && key.ch !== undefined) {
        // A digit jumps straight to that row — the fastest path for someone
        // who already knows the menu. It only selects when nothing has been
        // typed, so digits inside a typed value still work.
        if (typed === '' && /^[1-9]$/.test(key.ch)) {
          const index = Number(key.ch) - 1;
          const option = request.options[index];
          if (option !== undefined && option.disabled !== true) {
            active = index;
            frame.seal();
            output.write('\n');
            return finish<SelectResult<T>>({ kind: 'value', value: option.value, index });
          }
          continue;
        }
        if (request.allowText === true) {
          typed += key.ch;
          draw();
        }
      }
    }
  };

  const multiselect = async <T>(request: MultiSelectRequest<T>): Promise<T[]> => {
    const frame = createFrame(output);
    const chosen = new Set<number>(request.initial ?? []);
    let active = 0;
    hideCursor();

    const draw = (): void => {
      const lines = [theme.bold(request.message)];
      lines.push(theme.muted(request.footnote ?? 'Space toggles, Enter confirms.'));
      request.options.forEach((option, index) => {
        const marker = chosen.has(index) ? theme.success(theme.glyph.tick) : theme.muted(theme.glyph.dot);
        lines.push(optionLine(option, index, index === active, marker));
      });
      frame.render(lines);
    };

    draw();

    for (;;) {
      const key = await reader.next();
      if (key.name === 'ctrl-c') cancel();
      if (key.name === 'eof') break;
      if (key.name === 'up') {
        active = moveActive(request.options, active, -1);
        draw();
      } else if (key.name === 'down' || key.name === 'tab') {
        active = moveActive(request.options, active, 1);
        draw();
      } else if (key.name === 'space') {
        if (chosen.has(active)) chosen.delete(active);
        else chosen.add(active);
        draw();
      } else if (key.name === 'enter') {
        break;
      }
    }

    frame.seal();
    output.write('\n');
    return finish(
      [...chosen]
        .sort((a, b) => a - b)
        .map((index) => request.options[index]?.value)
        .filter((value): value is T => value !== undefined),
    );
  };

  /**
   * Read a line under raw mode.
   *
   * Deliberately not `readline`. Masking a secret with readline means
   * monkey-patching its private `_writeToOutput`, which is what our other CLI
   * does — a private API that can change on any Node upgrade and take password
   * entry with it. Echoing ourselves is a dozen lines and cannot break that way.
   */
  const readLine = async (request: TextRequest, mask: boolean): Promise<string> => {
    let value = request.initial ?? '';
    let error: string | undefined;
    const frame = createFrame(output);
    showCursor();

    const draw = (): void => {
      const shown = mask ? '' : value;
      const placeholder =
        value === '' && request.placeholder !== undefined && !mask
          ? theme.muted(request.placeholder)
          : '';
      const lines = [`${theme.bold(request.message)} ${shown}${placeholder}`];
      if (error !== undefined) lines.push(theme.warn(error));
      frame.render(lines);
    };

    draw();

    for (;;) {
      const key = await reader.next();

      if (key.name === 'ctrl-c') cancel();
      if (key.name === 'eof') break;

      if (key.name === 'enter') {
        const message = request.validate?.(value);
        if (message === undefined) break;
        error = message;
        draw();
        continue;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        draw();
        continue;
      }
      if (key.name === 'ctrl-u') {
        value = '';
        draw();
        continue;
      }
      if (key.name === 'char' && key.ch !== undefined) {
        value += key.ch;
        draw();
        continue;
      }
      if (key.name === 'space') {
        value += ' ';
        draw();
      }
    }

    frame.seal();
    output.write('\n');
    return value;
  };

  return {
    isInteractive: () => true,
    select,
    multiselect,
    text: (request) => readLine(request, false),
    secret: (request) => readLine(request, true),
    async confirm(request) {
      const fallback = request.initial ?? false;
      const result = await select<boolean>({
        message: request.message,
        options: [
          { value: true, label: 'Yes' },
          { value: false, label: 'No' },
        ],
        initial: fallback ? 0 : 1,
      });
      return result.kind === 'value' ? result.value : fallback;
    },
    close() {
      showCursor();
      reader.close();
    },
  };
};

/* ------------------------------------------------------------------ */
/* plain prompter                                                      */
/* ------------------------------------------------------------------ */

const createLineReader = (input: Readable) => {
  let buffer = '';
  let ended = false;
  const pending: string[] = [];
  const waiters: ((line: string | undefined) => void)[] = [];

  const flush = (): void => {
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) pending.push(line);
      else waiter(line);
      index = buffer.indexOf('\n');
    }
  };

  input.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    flush();
  });
  input.once('end', () => {
    ended = true;
    // A final line without a trailing newline is still a line.
    if (buffer !== '') {
      const waiter = waiters.shift();
      if (waiter === undefined) pending.push(buffer);
      else waiter(buffer);
      buffer = '';
    }
    while (waiters.length > 0) waiters.shift()?.(undefined);
  });
  input.resume();

  return {
    next(): Promise<string | undefined> {
      const queued = pending.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (ended) return Promise.resolve(undefined);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
};

export interface PlainPrompterOptions {
  input: Readable;
  output: OutputStream;
  theme: Theme;
}

/**
 * Line-oriented prompts for piped input.
 *
 * Everything renders as a numbered list and reads one line, so a script drives
 * the same flows a human does. Tests use this path exclusively for flow
 * coverage; the interactive path is covered separately at the key level.
 */
export const createPlainPrompter = (options: PlainPrompterOptions): Prompter => {
  const { output, theme } = options;
  const lines = createLineReader(options.input);

  const ask = async (message: string): Promise<string | undefined> => {
    output.write(`${message}\n`);
    return lines.next();
  };

  const select = async <T>(request: SelectRequest<T>): Promise<SelectResult<T>> => {
    output.write(`${request.message}\n`);
    if (request.footnote !== undefined) output.write(`${request.footnote}\n`);
    request.options.forEach((option, index) => {
      const hint = option.hint === undefined ? '' : `  ${option.hint}`;
      output.write(`  ${index + 1}) ${option.label}${hint}\n`);
    });

    const initial = (request.initial ?? 0) + 1;
    const answer = (await ask(`Choose [${initial}]: `))?.trim();

    if (answer === undefined) return { kind: 'back' };
    if (answer === '') {
      const option = request.options[initial - 1];
      return option === undefined
        ? { kind: 'back' }
        : { kind: 'value', value: option.value, index: initial - 1 };
    }
    if (['back', 'b', 'q', 'quit'].includes(answer.toLowerCase())) return { kind: 'back' };

    if (/^\d+$/.test(answer)) {
      const index = Number(answer) - 1;
      const option = request.options[index];
      if (option !== undefined && option.disabled !== true) {
        return { kind: 'value', value: option.value, index };
      }
    }

    // Exact label match only. Our other CLI's plain prompter falls back to a
    // substring match, which quietly picks a surprising option from a typo —
    // and a script cannot see that it happened.
    const index = request.options.findIndex(
      (option) => option.label.toLowerCase() === answer.toLowerCase(),
    );
    if (index !== -1) {
      const option = request.options[index];
      if (option !== undefined) return { kind: 'value', value: option.value, index };
    }

    if (request.allowText === true) return { kind: 'text', text: answer };
    return { kind: 'back' };
  };

  return {
    isInteractive: () => false,
    select,
    async multiselect(request) {
      output.write(`${request.message}\n`);
      request.options.forEach((option, index) => {
        output.write(`  ${index + 1}) ${option.label}\n`);
      });
      const answer = (await ask('Choose (comma-separated): '))?.trim() ?? '';
      return answer
        .split(',')
        .map((part) => Number(part.trim()) - 1)
        .map((index) => request.options[index]?.value)
        .filter((value): value is NonNullable<typeof value> => value !== undefined);
    },
    async text(request) {
      const suffix = request.initial === undefined ? '' : ` [${request.initial}]`;
      const answer = (await ask(`${request.message}${suffix} `))?.trim();
      const value = answer === undefined || answer === '' ? request.initial ?? '' : answer;
      const problem = request.validate?.(value);
      if (problem !== undefined) throw new InterruptedError(problem);
      return value;
    },
    async secret(request) {
      // No masking is possible on a pipe; the caller is a script that already
      // has the value. Echoing it would put it in the transcript, so do not.
      const answer = (await ask(`${request.message} `))?.trim();
      return answer ?? '';
    },
    async confirm(request) {
      const fallback = request.initial ?? false;
      const answer = (await ask(`${request.message} [${fallback ? 'Y/n' : 'y/N'}] `))?.trim();
      if (answer === undefined || answer === '') return fallback;
      return /^y(es)?$/i.test(answer);
    },
    close() {
      void theme;
    },
  };
};

/* ------------------------------------------------------------------ */
/* lazy prompter                                                       */
/* ------------------------------------------------------------------ */

/**
 * Defer construction until a prompt is actually needed.
 *
 * Building a prompter attaches a `data` listener to stdin and resumes it, which
 * *consumes* the stream. A command that reads stdin itself — `login --token -`
 * is the obvious one — would then find it empty, because the prompter it never
 * used had already drained it.
 *
 * So nothing touches stdin until something asks a question, and `close()` is a
 * no-op if nothing ever did.
 */
export const createLazyPrompter = (factory: () => Prompter): Prompter => {
  let real: Prompter | undefined;
  const get = (): Prompter => (real ??= factory());

  return {
    isInteractive: () => get().isInteractive(),
    select: (request) => get().select(request),
    multiselect: (request) => get().multiselect(request),
    text: (request) => get().text(request),
    secret: (request) => get().secret(request),
    confirm: (request) => get().confirm(request),
    close() {
      real?.close();
    },
  };
};

/* ------------------------------------------------------------------ */
/* refusing prompter                                                   */
/* ------------------------------------------------------------------ */

/**
 * Used when there is no input at all: CI, `--quiet`, a detached process.
 *
 * Each method names the flag that would have supplied the answer, so the
 * failure tells a script author exactly how to fix their invocation.
 */
export const createNonInteractivePrompter = (): Prompter => {
  // Rejects rather than throwing synchronously. Every method here is declared
  // to return a promise, and a caller that wrote `.catch(…)` around one would
  // never see a synchronous throw — it would escape as an unhandled error from
  // the middle of an otherwise well-behaved async flow.
  const refuse = <T>(what: string, flag: string): Promise<T> =>
    Promise.reject(new NonInteractiveError(what, flag));

  return {
    isInteractive: () => false,
    select: () => refuse('a choice', 'the relevant flag'),
    multiselect: () => refuse('a set of choices', 'the relevant flag'),
    text: (request) => refuse(`a value for "${request.message}"`, 'the relevant flag'),
    secret: () => refuse('a secret', '--token - to read it from stdin'),
    confirm: () => refuse('a confirmation', '--yes'),
    close() {},
  };
};
