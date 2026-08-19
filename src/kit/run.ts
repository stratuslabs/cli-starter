/**
 * The entry seam: `runCli({ argv, streams, env })` → exit code.
 *
 * A pure function of its arguments. It reads no globals, writes to no globals,
 * and never calls `process.exit` — `bin.ts` does that, once, with what this
 * returns. That is what makes an end-to-end test of any command a plain
 * function call.
 */

import { effectiveFlags, type FlagDef, type ProgramDef } from './command.ts';
import { createFlagBag, type GlobalOptions, type RunContext } from './context.ts';
import { detectColorLevel, detectUnicode, isInteractive, type CliEnvironment, type CliStreams } from './env.ts';
import { CliError, EXIT, errorToJson, toCliError, UsageError } from './errors.ts';
import { renderCommandHelp, renderRootHelp, renderUsageHint } from './help.ts';
import { parseInvocation, resolveForHelp } from './parse.ts';
import {
  createInteractivePrompter,
  createLazyPrompter,
  createNonInteractivePrompter,
  createPlainPrompter,
  type Prompter,
} from './prompt.ts';
import { createTheme, type Theme } from './theme.ts';

/**
 * Flags every command understands.
 *
 * Adopters add to these in `app.ts`; they should rarely remove one, because
 * scripts written against any CLI built from this template expect them.
 */
export const GLOBAL_FLAGS: Record<string, FlagDef> = {
  json: {
    type: 'boolean',
    summary: 'print machine-readable JSON on stdout and nothing else',
  },
  quiet: {
    type: 'boolean',
    short: 'q',
    summary: 'suppress progress and confirmations; errors still print',
  },
  verbose: {
    type: 'boolean',
    summary: 'include stack traces and resolution details in errors',
  },
  yes: {
    type: 'boolean',
    short: 'y',
    summary: 'answer yes to confirmations, for unattended use',
  },
  'no-color': {
    type: 'boolean',
    summary: 'never emit colour, whatever the terminal says',
  },
  color: {
    type: 'boolean',
    summary: 'emit colour even when the output is not a terminal',
    conflictsWith: ['no-color'],
  },
  profile: {
    type: 'string',
    placeholder: '<name>',
    summary: 'use a named set of saved credentials',
  },
  help: { type: 'boolean', short: 'h', summary: 'show help for a command' },
  version: { type: 'boolean', short: 'V', summary: 'print the version and exit' },
};

export interface RunCliOptions {
  argv: readonly string[];
  streams: CliStreams;
  env: CliEnvironment;
}

/**
 * Read the handful of flags needed *before* parsing can be trusted.
 *
 * Parsing can fail, and a parse failure still has to be rendered — in the right
 * colour mode, and as JSON if the caller asked for JSON. So these are read off
 * raw argv first. It is a deliberate duplication of three flags, and the only
 * one in the codebase.
 */
const preScan = (argv: readonly string[]): { noColor: boolean; forceColor: boolean; json: boolean; quiet: boolean; verbose: boolean } => {
  const stop = argv.indexOf('--');
  const head = stop === -1 ? argv : argv.slice(0, stop);
  return {
    noColor: head.includes('--no-color'),
    forceColor: head.includes('--color'),
    json: head.includes('--json'),
    quiet: head.includes('--quiet') || head.includes('-q'),
    verbose: head.includes('--verbose'),
  };
};

const buildPrompter = (
  env: CliEnvironment,
  streams: CliStreams,
  theme: Theme,
  globals: GlobalOptions,
): Prompter => {
  // `--quiet` means "do not talk to me", which includes questions. Prompting
  // under it would be a contradiction, and under `--json` it would corrupt the
  // output a script is parsing.
  if (globals.quiet || globals.json) return createNonInteractivePrompter();
  const stdin = env.stdin;
  if (stdin === undefined) return createNonInteractivePrompter();

  // Lazy: constructing a prompter consumes stdin, and a command may want to
  // read stdin itself. Nothing is attached until a prompt is actually asked.
  return createLazyPrompter(() =>
    isInteractive(env)
      ? createInteractivePrompter({
          stdin,
          // Prompts are chrome, so they go to stderr — that way a command can
          // ask a question and still have its stdout piped somewhere.
          output: streams.stderr,
          theme,
        })
      : createPlainPrompter({ input: stdin, output: streams.stderr, theme }),
  );
};

/** Render a failure. Human-readable by default, JSON when asked. */
export const renderError = (
  error: CliError,
  streams: CliStreams,
  theme: Theme,
  globals: { json: boolean; verbose: boolean },
  usage?: string,
): void => {
  if (globals.json) {
    streams.stdout.write(`${JSON.stringify(errorToJson(error), null, 2)}\n`);
    return;
  }

  streams.stderr.write(`${theme.fail(error.message)}\n`);
  if (error.hint !== undefined) {
    streams.stderr.write(`  ${theme.muted(error.hint)}\n`);
  }
  // Usage is shown only for usage errors. Printing the whole help on every
  // failure — which our other CLI does — buries the one line that matters.
  if (usage !== undefined) {
    streams.stderr.write(`${usage}\n`);
  }
  if (globals.verbose && error.stack !== undefined) {
    streams.stderr.write(`\n${theme.muted(error.stack)}\n`);
  }
};

export const runCli = async (program: ProgramDef, options: RunCliOptions): Promise<number> => {
  const { streams, env } = options;
  const pre = preScan(options.argv);

  const theme = createTheme({
    colorLevel: detectColorLevel(env.processEnv, env.tty, {
      noColor: pre.noColor,
      forceColor: pre.forceColor,
    }),
    unicode: detectUnicode(env.processEnv, env.platform),
    columns: env.tty.columns,
  });

  let prompter: Prompter | undefined;

  try {
    const invocation = parseInvocation(program, options.argv, env.processEnv);

    if (invocation.versionRequested) {
      streams.stdout.write(`${program.name} ${program.version}\n`);
      return EXIT.ok;
    }

    if (invocation.helpRequested || invocation.resolved === undefined) {
      const text =
        invocation.resolved === undefined
          ? renderRootHelp(program, theme)
          : renderCommandHelp(program, invocation.resolved, theme);
      // Help is what the user asked for, so it is data on stdout. Help printed
      // *because* something failed goes to stderr — see renderError.
      streams.stdout.write(`${text}\n`);
      return EXIT.ok;
    }

    const { resolved } = invocation;

    // A group with no default subcommand and no run handler is not runnable;
    // show its help rather than doing nothing silently.
    if (resolved.command.run === undefined) {
      streams.stdout.write(`${renderCommandHelp(program, resolved, theme)}\n`);
      return EXIT.ok;
    }

    const globals: GlobalOptions = {
      json: invocation.flags.boolean('json'),
      quiet: invocation.flags.boolean('quiet'),
      verbose: invocation.flags.boolean('verbose'),
      yes: invocation.flags.boolean('yes'),
      profile: invocation.flags.string('profile'),
    };

    prompter = buildPrompter(env, streams, theme, globals);

    const context: RunContext = {
      program,
      command: resolved.command,
      path: resolved.path,
      env,
      streams,
      theme,
      prompt: prompter,
      flags: invocation.flags,
      args: invocation.args,
      passthrough: invocation.passthrough,
      globals,
      out(text = '') {
        streams.stdout.write(`${text}\n`);
      },
      say(text = '') {
        if (globals.quiet) return;
        streams.stderr.write(`${text}\n`);
      },
      emit(value) {
        if (!globals.json) return;
        streams.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      },
      signal: env.signal,
    };

    const result = await resolved.command.run(context);
    return typeof result === 'number' ? result : EXIT.ok;
  } catch (rawError) {
    const error = toCliError(rawError);
    const usage =
      error instanceof UsageError
        ? renderUsageHint(program, resolveForHelp(program, options.argv), theme)
        : undefined;
    renderError(error, streams, theme, { json: pre.json, verbose: pre.verbose }, usage);
    return error.exitCode;
  } finally {
    // Raw mode and the hidden cursor are process-global terminal state. Leaving
    // either behind wrecks the user's shell, so teardown happens on every path
    // including a throw.
    prompter?.close();
  }
};

/** Exported so a test can assert that every global flag is documented. */
export const globalFlagNames = (program: ProgramDef): string[] =>
  Object.keys(effectiveFlags(program, undefined));

export { createFlagBag };
