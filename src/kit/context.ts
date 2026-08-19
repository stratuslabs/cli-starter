/**
 * What a command receives when it runs.
 *
 * A command never imports `process`, `node:fs`, or `console`. Everything it
 * can do arrives here, which is why the whole suite is testable in-process.
 *
 * The output split is load-bearing and worth stating plainly:
 *
 *   ctx.out()   → stdout → **data**. Parseable. Never decorated.
 *   ctx.say()   → stderr → **chrome**. Progress, confirmations, warnings.
 *
 * That is the discipline that makes `cli list --json | jq` reliable. Our other
 * CLI prints everything to stdout, which is why nothing it emits can be piped.
 */

import type { CliEnvironment, CliStreams } from './env.ts';
import type { Theme } from './theme.ts';
import type { CommandDef, ProgramDef } from './command.ts';
import type { Prompter } from './prompt.ts';

export type FlagValue = string | boolean | string[] | undefined;

/** Where a flag's value actually came from. */
export type FlagSource = 'flag' | 'env' | 'default' | 'unset';

/**
 * Typed access to parsed flags.
 *
 * The parser has already validated types, `choices`, `required`, and conflicts,
 * so these accessors are about ergonomics: they keep `as string` out of every
 * command body.
 */
export interface FlagBag {
  raw: Record<string, FlagValue>;
  /** A string flag's value, or undefined when absent. */
  string(name: string): string | undefined;
  /**
   * A string flag that the registry marks `required`, so absence is a bug in
   * the command definition rather than user error — hence the throw.
   */
  requireString(name: string): string;
  /** A boolean flag. Absent counts as false. */
  boolean(name: string): boolean;
  /** A `multiple` flag's values. Absent counts as empty. */
  list(name: string): string[];
  /** Whether the flag was supplied at all (as opposed to defaulted). */
  has(name: string): boolean;
  /**
   * Where the value came from.
   *
   * The parser already applies the environment fallback declared by `env:` on
   * the flag, so it is the only thing that knows whether a value was typed or
   * inherited. Anything that reports provenance — `doctor`, the endpoint-binding
   * error — must ask here rather than re-checking `process.env`, which is how
   * you end up telling a user a value came from `--base-url` when they never
   * typed it.
   */
  source(name: string): FlagSource;
  /** Provenance as a phrase for output: `--base-url`, `$KIT_BASE_URL`. */
  origin(name: string): string;
}

/** Behaviour every command shares, resolved once from the global flags. */
export interface GlobalOptions {
  /** Emit machine-readable output on stdout, and nothing else on stdout. */
  json: boolean;
  /** Suppress chrome. Errors still print. */
  quiet: boolean;
  /** Include stack traces and provenance in errors. */
  verbose: boolean;
  /** Assume yes for confirmations; the non-interactive escape hatch. */
  yes: boolean;
  /** Named credential/config profile. */
  profile: string | undefined;
}

export interface RunContext {
  program: ProgramDef;
  command: CommandDef;
  /** How the command was reached, e.g. `['categories', 'create']`. */
  path: string[];

  env: CliEnvironment;
  streams: CliStreams;
  theme: Theme;
  prompt: Prompter;

  flags: FlagBag;
  /** Positional arguments, already validated for arity. */
  args: string[];
  /** Everything after a bare `--`. */
  passthrough: string[];
  globals: GlobalOptions;

  /** Data → stdout. A trailing newline is added. */
  out(text?: string): void;
  /** Chrome → stderr. Silenced by `--quiet`. */
  say(text?: string): void;
  /**
   * The machine-readable result of this command.
   *
   * Under `--json` it is serialized to stdout; otherwise it is dropped, and
   * the command is expected to have said something human via `out`/`say`.
   * Call it once, at the end.
   */
  emit(value: unknown): void;
  /** Aborted on Ctrl-C. Pass it to fetch and to anything that waits. */
  signal: AbortSignal | undefined;
}

export const createFlagBag = (
  raw: Record<string, FlagValue>,
  sources: Record<string, FlagSource> = {},
  envNames: Record<string, string> = {},
): FlagBag => ({
  raw,
  string(name) {
    const value = raw[name];
    return typeof value === 'string' ? value : undefined;
  },
  requireString(name) {
    const value = raw[name];
    if (typeof value !== 'string') {
      throw new Error(
        `Flag --${name} was read as required but is not set. ` +
          'Mark it `required: true` in the command definition, or read it with .string().',
      );
    }
    return value;
  },
  boolean(name) {
    return raw[name] === true;
  },
  list(name) {
    const value = raw[name];
    if (Array.isArray(value)) return value;
    return typeof value === 'string' ? [value] : [];
  },
  has(name) {
    return raw[name] !== undefined;
  },
  source(name) {
    return sources[name] ?? (raw[name] === undefined ? 'unset' : 'default');
  },
  origin(name) {
    const source = sources[name];
    if (source === 'flag') return `--${name}`;
    if (source === 'env') return `$${envNames[name] ?? name.toUpperCase()}`;
    return 'built-in default';
  },
});
