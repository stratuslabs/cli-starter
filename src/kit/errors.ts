/**
 * The error model.
 *
 * Two rules that most CLIs get wrong and this one does not:
 *
 * 1. **A failure exits with a code that says what kind of failure it was.**
 *    A script that wraps this CLI can branch on "your credentials expired"
 *    versus "the network is down" without parsing English.
 * 2. **A failure carries its own remedy.** `hint` is a first-class field, not
 *    a sentence glued onto the message, so every renderer — human, JSON, log —
 *    gets it and none of them has to guess where the message ends.
 */

/**
 * Exit codes. Deliberately small and documented; every one of these appears in
 * `docs/exit-codes.md` and in the README, because an exit code is API.
 */
export const EXIT = {
  /** Success. */
  ok: 0,
  /** Anything without a more specific code. */
  general: 1,
  /** The command line itself was wrong: unknown flag, missing argument. */
  usage: 2,
  /** Configuration is missing, malformed, or contradictory. */
  config: 3,
  /** Not signed in, signed in as the wrong account, or the token was rejected. */
  auth: 4,
  /** The server could not be reached, or timed out. */
  network: 5,
  /** The thing you named does not exist. */
  notFound: 6,
  /** The thing you named exists but is in the wrong state for this operation. */
  conflict: 7,
  /** Ctrl-C. The shell convention is 128 + SIGINT(2). */
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliErrorOptions {
  /**
   * What the user should do next — ideally a command they can paste.
   * Rendered under the message, and included in `--json` output.
   */
  hint?: string;
  cause?: unknown;
  /** Structured context for `--json` consumers. Never contains secrets. */
  details?: Record<string, unknown>;
}

/**
 * The base class for every failure this CLI raises deliberately.
 *
 * Anything that escapes as a plain `Error` is a bug we have not classified
 * yet; the top-level handler renders it as `general` and, under `--verbose`,
 * shows the stack so it can be classified.
 */
export class CliError extends Error {
  /** Stable, machine-readable identifier, e.g. `auth.not_signed_in`. */
  code: string;
  exitCode: number;
  hint: string | undefined;
  details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = EXIT.general;
    this.hint = options.hint;
    this.details = options.details;
  }
}

/** The command line could not be understood. Always paired with usage output. */
export class UsageError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super('usage', message, options);
    this.exitCode = EXIT.usage;
  }
}

/** Config is missing, malformed, or two sources disagree irreconcilably. */
export class ConfigError extends CliError {
  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(code, message, options);
    this.exitCode = EXIT.config;
  }
}

/** Not signed in, or the stored credential was rejected. */
export class AuthError extends CliError {
  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(code, message, options);
    this.exitCode = EXIT.auth;
  }
}

/** The server was unreachable, timed out, or returned an unusable response. */
export class NetworkError extends CliError {
  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(code, message, options);
    this.exitCode = EXIT.network;
  }
}

export class NotFoundError extends CliError {
  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(code, message, options);
    this.exitCode = EXIT.notFound;
  }
}

export class ConflictError extends CliError {
  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(code, message, options);
    this.exitCode = EXIT.conflict;
  }
}

/**
 * Ctrl-C, or a shutdown signal during a long operation.
 *
 * Carries no hint: the user knows what they did, and printing advice at
 * someone who just cancelled is noise.
 */
export class InterruptedError extends CliError {
  constructor(message = 'Cancelled.') {
    super('interrupted', message);
    this.exitCode = EXIT.interrupted;
  }
}

/**
 * Raised when something needs an answer but there is nobody to ask —
 * piped stdin, CI, `--quiet`.
 *
 * The hint is mandatory by construction: it names the flag that would have
 * supplied the answer, so a script author is told exactly how to proceed
 * rather than watching the command hang or fail vaguely.
 */
export class NonInteractiveError extends CliError {
  constructor(what: string, flag: string) {
    super('non_interactive', `Needed ${what}, but the terminal is not interactive.`, {
      hint: `Pass ${flag}, or run this in a terminal.`,
    });
    this.exitCode = EXIT.usage;
  }
}

export const isCliError = (value: unknown): value is CliError => value instanceof CliError;

/** Normalize anything thrown into a `CliError` so renderers have one shape. */
export const toCliError = (value: unknown): CliError => {
  if (isCliError(value)) return value;
  if (value instanceof Error) {
    const wrapped = new CliError('unexpected', value.message, { cause: value });
    // Keep the original stack: this path exists to surface bugs, and a stack
    // pointing at this function instead of the throw site would defeat that.
    wrapped.stack = value.stack;
    return wrapped;
  }
  return new CliError('unexpected', String(value));
};

/** The `--json` rendering of a failure. Shape is stable and documented. */
export const errorToJson = (error: CliError): {
  ok: false;
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
} => ({
  ok: false,
  error: {
    code: error.code,
    message: error.message,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(error.details === undefined ? {} : { details: error.details }),
  },
});
