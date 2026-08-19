/**
 * Help text, rendered from the registry.
 *
 * Nothing here is hand-maintained prose about *what commands exist* — that all
 * comes from `CommandDef`. The consequence is the point: you cannot add a
 * command or a flag and forget to document it, because there is no separate
 * document to forget. `test/core/help.test.ts` walks the registry and asserts
 * every non-hidden name appears in rendered output.
 */

import {
  commandNames,
  effectiveFlags,
  type CommandDef,
  type FlagDef,
  type ProgramDef,
  type ResolvedCommand,
} from './command.ts';
import { formatPositional } from './parse.ts';
import { definitionList, wrapText, type DefinitionItem } from './render.ts';
import type { Theme } from './theme.ts';

const visible = <T extends { hidden?: boolean }>(items: readonly T[]): T[] =>
  items.filter((item) => item.hidden !== true);

/** `--title <title>`, or `-t, --title <title>` when there is a short form. */
export const flagSignature = (name: string, flag: FlagDef): string => {
  const long = `--${name}`;
  const withShort = flag.short === undefined ? `    ${long}` : `-${flag.short}, ${long}`;
  return flag.type === 'string' ? `${withShort} ${flag.placeholder ?? '<value>'}` : withShort;
};

/** What a flag's help line says beyond its summary: choices, default, env. */
const flagDetail = (flag: FlagDef, theme: Theme): string => {
  const notes: string[] = [];
  if (flag.choices !== undefined) notes.push(`one of: ${flag.choices.join(', ')}`);
  if (flag.default !== undefined && flag.default !== false) notes.push(`default: ${String(flag.default)}`);
  if (flag.env !== undefined) notes.push(`env: ${flag.env}`);
  if (flag.required === true) notes.push('required');
  if (notes.length === 0) return flag.summary;
  return `${flag.summary} ${theme.muted(`(${notes.join('; ')})`)}`;
};

export const usageLine = (program: ProgramDef, resolved: ResolvedCommand | undefined): string => {
  if (resolved === undefined) return `${program.name} <command> [options]`;

  const parts = [program.name, ...resolved.path];
  const command = resolved.command;

  if ((command.subcommands ?? []).length > 0) {
    parts.push(command.defaultSubcommand === undefined ? '<subcommand>' : '[subcommand]');
  }
  for (const arg of command.args ?? []) parts.push(formatPositional(arg));
  if (Object.keys(command.flags ?? {}).length > 0) parts.push('[options]');

  return parts.join(' ');
};

const flagItems = (flags: Record<string, FlagDef>, theme: Theme): DefinitionItem[] =>
  Object.entries(flags)
    .filter(([, flag]) => flag.hidden !== true)
    .map(([name, flag]) => ({ term: flagSignature(name, flag), description: flagDetail(flag, theme) }));

const commandItems = (commands: readonly CommandDef[]): DefinitionItem[] =>
  visible(commands).map((command) => ({
    // Aliases belong next to the name; a user who knows only the alias has to
    // be able to find the command in this list.
    term: commandNames(command).join(', '),
    description: command.summary,
  }));

const section = (heading: string, lines: readonly string[], theme: Theme): string[] =>
  lines.length === 0 ? [] : ['', theme.heading(heading), ...lines];

const exampleLines = (
  program: ProgramDef,
  command: CommandDef,
  theme: Theme,
): string[] => {
  const examples = command.examples ?? [];
  if (examples.length === 0) return [];
  const lines: string[] = [];
  for (const example of examples) {
    lines.push(`  ${theme.muted('$')} ${theme.command(`${program.name} ${example.cmd}`)}`);
    for (const line of wrapText(example.note, Math.max(20, theme.columns - 6))) {
      lines.push(`      ${theme.muted(line)}`);
    }
  }
  return lines;
};

export const renderRootHelp = (program: ProgramDef, theme: Theme): string => {
  const lines: string[] = [
    `${theme.bold(program.name)} ${theme.muted(program.version)} ${theme.muted(
      theme.glyph.dot,
    )} ${program.summary}`,
    '',
    theme.heading('Usage'),
    `  ${usageLine(program, undefined)}`,
  ];

  lines.push(...section('Commands', commandItems(program.commands).length === 0 ? [] : definitionList(commandItems(program.commands), theme), theme));
  lines.push(...section('Global options', definitionList(flagItems(program.globalFlags, theme), theme), theme));

  lines.push(
    '',
    theme.muted(`Run ${theme.command(`${program.name} <command> --help`)} for details on a command.`),
  );
  if (program.footer !== undefined) lines.push('', ...wrapText(program.footer, theme.columns));

  return lines.join('\n');
};

export const renderCommandHelp = (
  program: ProgramDef,
  resolved: ResolvedCommand,
  theme: Theme,
): string => {
  const command = resolved.command;
  const lines: string[] = [theme.heading('Usage'), `  ${usageLine(program, resolved)}`];

  if (command.description !== undefined) {
    lines.push('', ...wrapText(command.description, theme.columns));
  } else {
    lines.push('', ...wrapText(command.summary, theme.columns));
  }

  lines.push(
    ...section('Subcommands', definitionList(commandItems(command.subcommands ?? []), theme), theme),
  );

  const args = command.args ?? [];
  lines.push(
    ...section(
      'Arguments',
      definitionList(
        args.map((arg) => ({ term: formatPositional(arg), description: arg.summary })),
        theme,
      ),
      theme,
    ),
  );

  // Command flags first, then the globals, under separate headings: a reader
  // scanning `publish --help` cares about `--title`, not about `--json`.
  lines.push(...section('Options', definitionList(flagItems(command.flags ?? {}, theme), theme), theme));

  const globals = effectiveFlags(program, resolved);
  for (const name of Object.keys(command.flags ?? {})) delete globals[name];
  lines.push(...section('Global options', definitionList(flagItems(globals, theme), theme), theme));

  lines.push(...section('Examples', exampleLines(program, command, theme), theme));

  if (command.defaultSubcommand !== undefined) {
    lines.push(
      '',
      theme.muted(
        `Running ${theme.command(`${program.name} ${resolved.path.join(' ')}`)} with no subcommand runs ${theme.command(
          command.defaultSubcommand,
        )}.`,
      ),
    );
  }

  return lines.join('\n');
};

/**
 * The short usage shown alongside a usage error.
 *
 * Deliberately *not* the whole help text. Our other CLI prints its full
 * 90-line help to stderr on every failure, including runtime failures like a
 * missing API key, which buries the one line that says what to do.
 */
export const renderUsageHint = (
  program: ProgramDef,
  resolved: ResolvedCommand | undefined,
  theme: Theme,
): string => {
  const invocation = [program.name, ...(resolved?.path ?? [])].join(' ');
  return [
    `${theme.muted('Usage:')} ${usageLine(program, resolved)}`,
    theme.muted(`Run ${theme.command(`${invocation} --help`)} for more.`),
  ].join('\n');
};
