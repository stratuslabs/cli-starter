/**
 * argv → a validated invocation.
 *
 * Built on `node:util`'s `parseArgs`, which handles the fiddly tokenising
 * (short clusters, `--flag=value`, `--` termination) and is in core, so this
 * repo stays dependency-free. Everything `parseArgs` deliberately leaves out —
 * subcommands, positional arity, `choices`, `required`, conflicts, environment
 * fallback, "did you mean" — is added here, driven entirely by the registry.
 */

import { parseArgs } from 'node:util';

import {
  commandNames,
  effectiveFlags,
  findCommand,
  suggest,
  type CommandDef,
  type FlagDef,
  type ProgramDef,
  type ResolvedCommand,
} from './command.ts';
import { createFlagBag, type FlagBag, type FlagSource, type FlagValue } from './context.ts';
import { UsageError } from './errors.ts';

export interface ParsedInvocation {
  /** Undefined when no command was named at all. */
  resolved: ResolvedCommand | undefined;
  flags: FlagBag;
  args: string[];
  passthrough: string[];
  helpRequested: boolean;
  versionRequested: boolean;
  /** The token that looked like a command but matched nothing. */
  unknownCommand: string | undefined;
}

const isLongFlag = (token: string): boolean => token.startsWith('--') && token.length > 2;
const isShortFlag = (token: string): boolean =>
  token.startsWith('-') && !token.startsWith('--') && token.length > 1;

const lookupShort = (
  flags: Record<string, FlagDef>,
  letter: string,
): FlagDef | undefined => Object.values(flags).find((flag) => flag.short === letter);

/**
 * Walk argv far enough to know which command is being run.
 *
 * The subtlety this exists for: a string flag's *value* can look exactly like a
 * command name. In `cli --profile publish list`, `publish` is the profile, not
 * the command. So the scan has to know the flag vocabulary as it goes, and the
 * vocabulary grows as it descends into subcommands.
 */
const resolveCommandPath = (
  program: ProgramDef,
  argv: readonly string[],
): { resolved: ResolvedCommand | undefined; consumed: Set<number>; unknown: string | undefined } => {
  const consumed = new Set<number>();
  const ancestors: CommandDef[] = [];
  const path: string[] = [];
  let current: CommandDef | undefined;
  let unknown: string | undefined;

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined || token === '--') break;

    const known = effectiveFlags(program, current ? { command: current, path, ancestors } : undefined);

    if (isLongFlag(token)) {
      const name = token.slice(2);
      if (name.includes('=')) {
        index += 1;
        continue;
      }
      index += known[name]?.type === 'string' ? 2 : 1;
      continue;
    }

    if (isShortFlag(token)) {
      // In a cluster only the final letter can take a value: `-ab value`.
      const last = token.at(-1) ?? '';
      index += lookupShort(known, last)?.type === 'string' ? 2 : 1;
      continue;
    }

    const pool = current ? current.subcommands ?? [] : program.commands;
    const match = findCommand(pool, token);
    if (match === undefined) {
      // Only the very first positional can be a mistyped command; after that
      // we are looking at real arguments.
      if (current === undefined) unknown = token;
      break;
    }

    consumed.add(index);
    if (current !== undefined) ancestors.push(current);
    current = match;
    path.push(match.name);
    index += 1;

    if ((match.subcommands ?? []).length === 0) break;
  }

  // A group invoked bare runs its default subcommand, so adding
  // `cli categories list` does not break the existing `cli categories`.
  while (current !== undefined && (current.subcommands ?? []).length > 0) {
    const fallbackName = current.defaultSubcommand;
    if (fallbackName === undefined) break;
    const fallback = findCommand(current.subcommands ?? [], fallbackName);
    if (fallback === undefined) break;
    ancestors.push(current);
    current = fallback;
    path.push(fallback.name);
  }

  if (current === undefined) return { resolved: undefined, consumed, unknown };
  return { resolved: { command: current, path, ancestors }, consumed, unknown };
};

/**
 * Resolve the command path without validating anything.
 *
 * Used to render a usage hint *after* a parse failure, where re-parsing would
 * simply throw again. Sharing the scanner rather than re-deriving it is the
 * point: a second, cruder lookup would name the wrong command in exactly the
 * confusing cases — a subcommand's flag error would print the group's usage.
 */
export const resolveForHelp = (
  program: ProgramDef,
  argv: readonly string[],
): ResolvedCommand | undefined => {
  const stop = argv.indexOf('--');
  const head = stop === -1 ? argv : argv.slice(0, stop);
  try {
    return resolveCommandPath(program, head).resolved;
  } catch {
    return undefined;
  }
};

/** Every command name and alias reachable at the top level, for suggestions. */
const topLevelNames = (program: ProgramDef): string[] =>
  program.commands.filter((command) => command.hidden !== true).flatMap(commandNames);

const describeFlag = (name: string, flag: FlagDef): string =>
  flag.type === 'string' ? `--${name} ${flag.placeholder ?? '<value>'}` : `--${name}`;

export const parseInvocation = (
  program: ProgramDef,
  argv: readonly string[],
  processEnv: Record<string, string | undefined> = {},
): ParsedInvocation => {
  // Split the passthrough off before anything else: after a bare `--` the
  // tokens belong to another program and must not be interpreted at all.
  const separator = argv.indexOf('--');
  const head = separator === -1 ? [...argv] : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);

  const helpRequested = head.includes('--help') || head.includes('-h');
  const versionRequested = head.includes('--version') || head.includes('-V');

  const { resolved, consumed, unknown } = resolveCommandPath(program, head);

  if (resolved === undefined && unknown !== undefined && !helpRequested && !versionRequested) {
    const guess = suggest(unknown, topLevelNames(program));
    throw new UsageError(`Unknown command "${unknown}".`, {
      hint:
        guess === undefined
          ? `Run ${program.name} --help to see the available commands.`
          : `Did you mean ${program.name} ${guess}?`,
      details: { input: unknown, ...(guess === undefined ? {} : { suggestion: guess }) },
    });
  }

  const known = effectiveFlags(program, resolved);
  const rest = head.filter((_, index) => !consumed.has(index));

  const options: Record<string, { type: FlagType_; short?: string; multiple?: boolean }> = {};
  for (const [name, flag] of Object.entries(known)) {
    options[name] = {
      type: flag.type,
      ...(flag.short === undefined ? {} : { short: flag.short }),
      ...(flag.multiple === true ? { multiple: true } : {}),
    };
  }

  let values: Record<string, FlagValue>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: rest, options, strict: true, allowPositionals: true });
    values = parsed.values as Record<string, FlagValue>;
    positionals = parsed.positionals;
  } catch (error) {
    throw asUsageError(error, program, known, resolved);
  }

  // `values` holds exactly what was typed, because no defaults were handed to
  // parseArgs. That distinction is what makes `flags.has()` meaningful.
  const provided = new Set(Object.keys(values));
  const merged: Record<string, FlagValue> = { ...values };
  const sources: Record<string, FlagSource> = {};
  const envNames: Record<string, string> = {};

  for (const name of provided) sources[name] = 'flag';

  for (const [name, flag] of Object.entries(known)) {
    if (flag.env !== undefined) envNames[name] = flag.env;
    if (provided.has(name)) continue;

    const fromEnv = flag.env === undefined ? undefined : processEnv[flag.env];
    if (fromEnv !== undefined && fromEnv !== '') {
      merged[name] = flag.type === 'boolean' ? fromEnv !== '0' && fromEnv !== 'false' : fromEnv;
      sources[name] = 'env';
      continue;
    }
    if (flag.default !== undefined) {
      merged[name] = flag.default;
      sources[name] = 'default';
    }
  }

  // Help and version short-circuit before validation: `cli publish --help`
  // must print help, not complain that --title is missing.
  if (!helpRequested && !versionRequested) {
    validateFlags(known, merged, provided);
    validatePositionals(program, resolved, positionals);
  }

  return {
    resolved,
    flags: createFlagBag(merged, sources, envNames),
    args: positionals,
    passthrough,
    helpRequested,
    versionRequested,
    unknownCommand: unknown,
  };
};

type FlagType_ = 'string' | 'boolean';

const validateFlags = (
  known: Record<string, FlagDef>,
  merged: Record<string, FlagValue>,
  provided: ReadonlySet<string>,
): void => {
  for (const [name, flag] of Object.entries(known)) {
    const value = merged[name];

    if (flag.required === true && value === undefined) {
      throw new UsageError(`Missing required flag ${describeFlag(name, flag)}.`, {
        hint: flag.summary,
        details: { flag: name },
      });
    }

    if (flag.choices !== undefined && value !== undefined) {
      const supplied = Array.isArray(value) ? value : [value];
      for (const one of supplied) {
        if (typeof one === 'string' && !flag.choices.includes(one)) {
          throw new UsageError(`Invalid value "${one}" for --${name}.`, {
            hint: `Valid values: ${flag.choices.join(', ')}.`,
            details: { flag: name, value: one, choices: flag.choices },
          });
        }
      }
    }

    // Conflicts consider only what was typed. A default or an environment
    // variable colliding with an explicit flag is not the user's mistake.
    if (flag.conflictsWith !== undefined && provided.has(name)) {
      for (const other of flag.conflictsWith) {
        if (provided.has(other)) {
          throw new UsageError(`--${name} and --${other} cannot be used together.`, {
            details: { flags: [name, other] },
          });
        }
      }
    }
  }
};

const validatePositionals = (
  program: ProgramDef,
  resolved: ResolvedCommand | undefined,
  positionals: readonly string[],
): void => {
  if (resolved === undefined) return;
  const defs = resolved.command.args ?? [];
  const invocation = [program.name, ...resolved.path].join(' ');

  const required = defs.filter((def) => def.required === true);
  if (positionals.length < required.length) {
    const missing = required[positionals.length];
    throw new UsageError(`Missing required argument <${missing?.name ?? 'argument'}>.`, {
      hint: `Usage: ${invocation} ${defs.map(formatPositional).join(' ')}`.trim(),
      details: { argument: missing?.name },
    });
  }

  const variadic = defs.some((def) => def.variadic === true);
  if (!variadic && positionals.length > defs.length) {
    const extra = positionals.slice(defs.length);
    throw new UsageError(
      `Unexpected argument${extra.length > 1 ? 's' : ''} ${extra.map((value) => `"${value}"`).join(', ')}.`,
      {
        hint:
          defs.length === 0
            ? `${invocation} takes no arguments.`
            : `Usage: ${invocation} ${defs.map(formatPositional).join(' ')}`,
        details: { extra },
      },
    );
  }
};

export const formatPositional = (def: { name: string; required?: boolean; variadic?: boolean }): string => {
  const inner = def.variadic === true ? `${def.name}...` : def.name;
  return def.required === true ? `<${inner}>` : `[${inner}]`;
};

/** Turn a `parseArgs` failure into a message that names the fix. */
const asUsageError = (
  error: unknown,
  program: ProgramDef,
  known: Record<string, FlagDef>,
  resolved: ResolvedCommand | undefined,
): UsageError => {
  const code = (error as { code?: string } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const invocation = [program.name, ...(resolved?.path ?? [])].join(' ');

  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    // parseArgs quotes the offending token in its message; recover it rather
    // than re-tokenising, so the two can never disagree.
    const match = /'(-{1,2}[^']+)'/.exec(message);
    const raw = match?.[1] ?? '';
    const name = raw.replace(/^-+/, '').split('=')[0] ?? '';
    const visible = Object.entries(known)
      .filter(([, flag]) => flag.hidden !== true)
      .map(([flagName]) => flagName);
    const guess = suggest(name, visible);
    return new UsageError(`Unknown flag ${raw || `--${name}`}.`, {
      hint:
        guess === undefined
          ? `Run ${invocation} --help to see the available flags.`
          : `Did you mean --${guess}?`,
      details: { flag: name, ...(guess === undefined ? {} : { suggestion: guess }) },
    });
  }

  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    return new UsageError(message, {
      hint: `Run ${invocation} --help to see how this flag is used.`,
    });
  }

  return new UsageError(message, { hint: `Run ${invocation} --help.` });
};
