/**
 * Terminal key decoding.
 *
 * This is a *pure* byte-stream decoder with no reference to stdin, a TTY, or
 * timers. That is deliberate and it is the main reason this module exists
 * separately from `prompt.ts`.
 *
 * In our other CLI the equivalent logic lives inside the prompt's `data`
 * handler, so it can only be exercised by a real terminal — and consequently
 * it has no tests at all, despite containing the three hardest bugs in the
 * codebase (pasted input, key repeat, and escape sequences split across
 * packets by SSH). Here those cases are ordinary unit tests: push bytes, assert
 * keys.
 */

export interface Key {
  /** Canonical name: `up`, `enter`, `escape`, `char`, `ctrl-c`… */
  name: string;
  /** The character, for `name === 'char'`. */
  ch?: string;
  /** Exact bytes consumed, kept for diagnostics. */
  raw: string;
}

const ESC = '\u001b';

const SINGLE: Record<string, string> = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\u007f': 'backspace',
  '\b': 'backspace',
  '\u0003': 'ctrl-c',
  '\u0004': 'ctrl-d',
  '\u0015': 'ctrl-u',
  '\u0017': 'ctrl-w',
  ' ': 'space',
};

/**
 * Final byte of a CSI/SS3 sequence → key name.
 *
 * Both `ESC [ A` (CSI, normal mode) and `ESC O A` (SS3, application cursor
 * mode) mean "up". Terminals switch between them without asking — tmux and
 * some SSH servers use SS3 — so a decoder that handles only `ESC [` works on
 * the author's machine and mysteriously fails on someone else's.
 */
const FINAL_KEYS: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'shift-tab',
};

/** `ESC [ <n> ~` sequences. */
const TILDE_KEYS: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

/**
 * Incremental decoder.
 *
 * `push` returns every *complete* key in the chunk and retains any trailing
 * partial escape sequence. `flushPending` decides what an incomplete sequence
 * meant once the caller concludes no more bytes are coming — which is the only
 * way to tell a lone Esc keypress from the start of an arrow key, since they
 * begin with the same byte.
 */
export class KeyDecoder {
  private buffer = '';

  /**
   * Decode as much as possible.
   *
   * A single chunk routinely holds many keys: holding down ↓ produces key
   * repeat, and a paste arrives as one write. Emitting only the first key and
   * discarding the rest is the bug this loop exists to avoid.
   */
  push(chunk: string): Key[] {
    this.buffer += chunk;
    const keys: Key[] = [];

    while (this.buffer.length > 0) {
      const key = this.consume();
      if (key === undefined) break; // incomplete; wait for more bytes
      keys.push(key);
    }

    return keys;
  }

  /** Bytes held back awaiting completion. Non-empty means a timer should run. */
  get pending(): string {
    return this.buffer;
  }

  /**
   * Resolve whatever is buffered, assuming no more bytes will arrive.
   *
   * A bare ESC becomes the Escape key; anything else that never completed is
   * decoded byte by byte rather than dropped, because silently eating input is
   * worse than reporting it oddly.
   */
  flushPending(): Key[] {
    if (this.buffer === '') return [];

    if (this.buffer === ESC) {
      this.buffer = '';
      return [{ name: 'escape', raw: ESC }];
    }

    const raw = this.buffer;
    this.buffer = '';
    if (raw.startsWith(ESC)) {
      return [{ name: 'escape', raw }];
    }
    return [...raw].map((ch) => this.decodeSingle(ch));
  }

  private consume(): Key | undefined {
    const first = this.buffer[0];
    if (first === undefined) return undefined;

    if (first !== ESC) {
      this.buffer = this.buffer.slice(1);
      return this.decodeSingle(first);
    }

    // Escape sequences are the only multi-byte keys, and the only place where
    // "I have some bytes but not all of them" is possible.
    if (this.buffer.length === 1) return undefined;

    const second = this.buffer[1];

    if (second === '[' || second === 'O') {
      if (this.buffer.length < 3) return undefined;

      const match = /^\u001b[[O]([0-9;]*)([A-Za-z~])/.exec(this.buffer);
      if (match === null) {
        // Parameters still arriving, e.g. `ESC [ 1 ;` — keep waiting. But if
        // what we have can never become a sequence, give up on it rather than
        // buffering forever and wedging the prompt.
        if (/^\u001b[[O][0-9;]*$/.test(this.buffer)) return undefined;
        const raw = this.buffer;
        this.buffer = '';
        return { name: 'unknown', raw };
      }

      const [raw, params = '', final = ''] = match;
      this.buffer = this.buffer.slice(raw.length);

      if (final === '~') {
        const name = TILDE_KEYS[params.split(';')[0] ?? ''] ?? 'unknown';
        return { name, raw };
      }
      return { name: FINAL_KEYS[final] ?? 'unknown', raw };
    }

    // ESC followed by an ordinary character is Alt+that character. We do not
    // bind Alt to anything, so report the Escape and let the character be
    // decoded on the next pass.
    this.buffer = this.buffer.slice(1);
    return { name: 'escape', raw: ESC };
  }

  private decodeSingle(ch: string): Key {
    const name = SINGLE[ch];
    if (name !== undefined) return { name, ch, raw: ch };
    // Other C0 controls carry no meaning for us; naming them keeps them out of
    // text fields, where a raw control byte would corrupt the line.
    if (ch < ' ') return { name: 'control', ch, raw: ch };
    return { name: 'char', ch, raw: ch };
  }
}

/**
 * How long to wait before deciding a lone ESC was the Escape key.
 *
 * An arrow key is `ESC [ A`. Over SSH those three bytes can arrive in separate
 * packets, so "did I get only ESC?" cannot be answered synchronously — it can
 * only be answered after a pause. 75ms is long enough to reassemble a split
 * sequence on a slow link and short enough that pressing Esc still feels
 * instant.
 */
export const ESCAPE_TIMEOUT_MS = 75;
