/**
 * The command registry.
 *
 * One declaration per command, and *everything* is derived from it: argument
 * parsing, validation, dispatch, `--help`, per-command help, and shell
 * completions.
 *
 * This exists to make one specific bug unrepresentable. In our other CLI the
 * parser is a 515-line if-chain and the help text is a separate hand-written
 * string; nothing connects them, so commands ship undocumented and flags drift
 * out of the help. Here there is nowhere to put a flag that help cannot see —
 * `summary` is required on every flag and positional, and a test walks the
 * registry to prove each one is rendered.
 */

import type { RunContext } from './context.ts';

export type FlagType = 'boolean' | 'string';

export interface FlagDef {
  type: FlagType;
  /** Single-character alias, without the dash. */
  short?: string;
  /**
   * One line, lower case, describing the *effect* — not a restatement of the
   * flag's name. "Hide this post from the public changelog" beats "set private".
   */
  summary: string;
  /** Shown in help for string flags. Defaults to `<value>`. */
  placeholder?: string;
  default?: string | boolean;
  /** Repeatable: `--tag a --tag b` collects into an array. */
  multiple?: boolean;
  required?: boolean;
  /** Rejects anything not in the list, and lists the valid values in the error. */
  choices?: string[];
  /** Flags that may not appear alongside this one. Checked both ways. */
  conflictsWith?: string[];
  /** Environment variable consulted when the flag is absent. */
  env?: string;
  /** Kept working but not advertised — deprecated spellings. */
  hidden?: boolean;
}

export interface PositionalDef {
  /** Bare name; help renders the brackets. */
  name: string;
  summary: string;
  required?: boolean;
  /** Absorbs the rest. Only valid as the last positional. */
  variadic?: boolean;
}

export interface Example {
  /** Written without the binary name; help prepends it. */
  cmd: string;
  note: string;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  /** One line for the command list. Required. */
  summary: string;
  /** Paragraphs for `<command> --help`. Optional but wanted. */
  description?: string;
  args?: PositionalDef[];
  flags?: Record<string, FlagDef>;
  examples?: Example[];
  subcommands?: CommandDef[];
  /**
   * Subcommand to run when the group is invoked bare, so `cli categories`
   * keeps working after `cli categories list` is added.
   */
  defaultSubcommand?: string;
  hidden?: boolean;
  /**
   * Returns an exit code, or nothing for success. Throwing a `CliError` is the
   * normal way to fail — do not call `process.exit`, which would skip the
   * spinner and raw-mode teardown.
   */
  run?(ctx: RunContext): Promise<number | void> | number | void;
}

export interface ProgramDef {
  /** The binary name, as typed. Used throughout help and error messages. */
  name: string;
  version: string;
  summary: string;
  commands: CommandDef[];
  /** Available on every command; merged under command-specific flags. */
  globalFlags: Record<string, FlagDef>;
  /** Rendered at the foot of the root help. */
  footer?: string;
  /**
   * ASCII art for the banner. Absent means no banner, everywhere.
   * See `banner.ts` for when one is shown — it is narrower than you think.
   */
  art?: readonly string[];
}

/** Identity helper; exists for inference and for a greppable declaration site. */
export const defineCommand = (command: CommandDef): CommandDef => command;

/** All the names a command answers to. */
export const commandNames = (command: CommandDef): string[] => [
  command.name,
  ...(command.aliases ?? []),
];

export const findCommand = (
  commands: readonly CommandDef[],
  name: string,
): CommandDef | undefined => commands.find((command) => commandNames(command).includes(name));

/** A resolved path through the command tree, e.g. `categories` → `create`. */
export interface ResolvedCommand {
  /** Deepest command — the one that runs. */
  command: CommandDef;
  /** Names as resolved, for help and error messages. */
  path: string[];
  /** Every ancestor, outermost first. Flags accumulate down this chain. */
  ancestors: CommandDef[];
}

/**
 * Flags visible to a command: globals, then each ancestor's, then its own.
 * Later wins, so a command may deliberately re-specify a global.
 */
export const effectiveFlags = (
  program: ProgramDef,
  resolved: ResolvedCommand | undefined,
): Record<string, FlagDef> => {
  const flags: Record<string, FlagDef> = { ...program.globalFlags };
  for (const ancestor of resolved?.ancestors ?? []) Object.assign(flags, ancestor.flags ?? {});
  if (resolved) Object.assign(flags, resolved.command.flags ?? {});
  return flags;
};

/** Optimal string alignment distance, capped — enough for "did you mean". */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
};

/**
 * The closest candidate, or undefined when nothing is close enough.
 *
 * The threshold scales with length so `lst` suggests `list` but `xyzzy` does
 * not suggest anything — a confidently wrong suggestion is worse than none.
 */
export const suggest = (input: string, candidates: readonly string[]): string | undefined => {
  const threshold = Math.max(2, Math.floor(input.length / 3) + 1);
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance <= threshold && (best === undefined || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
};
