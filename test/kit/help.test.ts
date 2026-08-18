/**
 * The anti-drift guarantee.
 *
 * These walk the real registry and assert that every command, subcommand, and
 * flag appears in rendered help. This is the test our other CLI cannot write:
 * its help is a hand-maintained string with no structural relationship to its
 * parser, which is how three commands shipped undocumented.
 *
 * If you add a command and these fail, the help renderer needs updating — not
 * these tests.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commandNames, type CommandDef } from '../../src/kit/command.ts';
import { renderCommandHelp, renderRootHelp } from '../../src/kit/help.ts';
import { plainTheme, stripAnsi } from '../../src/kit/theme.ts';
import { program } from '../../src/main.ts';

const theme = plainTheme(100);

const walk = (commands: readonly CommandDef[], path: string[] = []): { command: CommandDef; path: string[] }[] =>
  commands.flatMap((command) => [
    { command, path: [...path, command.name] },
    ...walk(command.subcommands ?? [], [...path, command.name]),
  ]);

const everyCommand = walk(program.commands);

test('the root help lists every top-level command', () => {
  const rendered = stripAnsi(renderRootHelp(program, theme));
  for (const command of program.commands) {
    if (command.hidden === true) continue;
    assert.ok(
      rendered.includes(command.name),
      `\`${command.name}\` is not in the root help — it would ship undocumented`,
    );
    assert.ok(rendered.includes(command.summary), `\`${command.name}\` has no summary in help`);
  }
});

test('the root help lists every global flag', () => {
  const rendered = stripAnsi(renderRootHelp(program, theme));
  for (const [name, flag] of Object.entries(program.globalFlags)) {
    if (flag.hidden === true) continue;
    assert.ok(rendered.includes(`--${name}`), `--${name} is missing from the global options`);
  }
});

test('every command has a summary, and it reads as a summary', () => {
  for (const { command, path } of everyCommand) {
    assert.ok(command.summary.length > 0, `${path.join(' ')} has an empty summary`);
    // A summary is a fragment shown in a list, not a sentence. Catching this
    // here keeps the command list visually consistent without a style debate
    // in every review.
    assert.ok(
      !command.summary.endsWith('.'),
      `${path.join(' ')} summary should not end with a full stop: "${command.summary}"`,
    );
  }
});

test('every flag on every command is documented in that command help', () => {
  for (const { command, path } of everyCommand) {
    const resolved = { command, path, ancestors: [] };
    const rendered = stripAnsi(renderCommandHelp(program, resolved, theme));
    for (const [name, flag] of Object.entries(command.flags ?? {})) {
      if (flag.hidden === true) continue;
      assert.ok(
        rendered.includes(`--${name}`),
        `--${name} is missing from \`${path.join(' ')} --help\``,
      );
      assert.ok(
        flag.summary.length > 0,
        `--${name} on \`${path.join(' ')}\` has no summary`,
      );
    }
  }
});

test('every positional argument is documented', () => {
  for (const { command, path } of everyCommand) {
    const rendered = stripAnsi(renderCommandHelp(program, { command, path, ancestors: [] }, theme));
    for (const arg of command.args ?? []) {
      assert.ok(
        rendered.includes(arg.name),
        `argument <${arg.name}> is missing from \`${path.join(' ')} --help\``,
      );
    }
  }
});

test('a group help lists its subcommands', () => {
  for (const { command, path } of everyCommand) {
    if ((command.subcommands ?? []).length === 0) continue;
    const rendered = stripAnsi(renderCommandHelp(program, { command, path, ancestors: [] }, theme));
    for (const sub of command.subcommands ?? []) {
      if (sub.hidden === true) continue;
      assert.ok(rendered.includes(sub.name), `\`${sub.name}\` missing from \`${path.join(' ')} --help\``);
    }
  }
});

test('command names and aliases do not collide', () => {
  const seen = new Map<string, string>();
  for (const command of program.commands) {
    for (const name of commandNames(command)) {
      const existing = seen.get(name);
      assert.equal(existing, undefined, `"${name}" is claimed by both ${existing} and ${command.name}`);
      seen.set(name, command.name);
    }
  }
});

test('a group either has a default subcommand or its own run handler, never both', () => {
  for (const { command, path } of everyCommand) {
    if (command.defaultSubcommand === undefined) continue;
    assert.equal(
      command.run,
      undefined,
      `\`${path.join(' ')}\` has both a default subcommand and a run handler — the run handler is unreachable`,
    );
  }
});

test('help wraps to the terminal width instead of overflowing it', () => {
  const narrow = plainTheme(60);
  const rendered = stripAnsi(renderRootHelp(program, narrow));
  for (const line of rendered.split('\n')) {
    // Long unbreakable tokens (URLs) are allowed to overflow; prose is not.
    if (/\S{40,}/.test(line)) continue;
    assert.ok(line.length <= 60, `line exceeds 60 columns: ${JSON.stringify(line)}`);
  }
});
