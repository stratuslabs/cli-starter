/**
 * Completions are generated from the registry, so the interesting assertions
 * are the same shape as the help tests: walk the registry, prove every visible
 * thing appears. A command that cannot be tab-completed is as broken as one
 * that is undocumented, and for the same reason — someone added it in one
 * place and not the other.
 *
 * The escaping cases are the ones that actually bite. A colon in a summary
 * silently corrupts a zsh `_describe` entry; an apostrophe ends a shell string.
 * Both appear in ordinary English prose.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProgramDef } from '../../src/core/command.ts';
import {
  bashCompletions,
  completionsFor,
  fishCompletions,
  SHELLS,
  walk,
  zshCompletions,
} from '../../src/core/completions.ts';
import { program } from '../../src/main.ts';

const generators = { bash: bashCompletions, zsh: zshCompletions, fish: fishCompletions } as const;

test('every visible command appears in every shell', () => {
  const expected = walk(program.commands).map((entry) => entry.command.name);
  assert.ok(expected.length > 5, 'expected a registry worth testing');

  for (const shell of SHELLS) {
    const script = completionsFor(program, shell);
    for (const name of expected) {
      assert.ok(
        script.includes(name),
        `${shell}: "${name}" is in the registry but not the completion script`,
      );
    }
  }
});

test('every visible flag appears in every shell', () => {
  for (const shell of SHELLS) {
    const script = completionsFor(program, shell);

    for (const entry of walk(program.commands)) {
      for (const [name, flag] of Object.entries(entry.command.flags ?? {})) {
        if (flag.hidden === true) continue;
        assert.ok(
          script.includes(name),
          `${shell}: --${name} on "${entry.path.join(' ')}" is missing`,
        );
      }
    }

    for (const [name, flag] of Object.entries(program.globalFlags)) {
      if (flag.hidden === true) continue;
      assert.ok(script.includes(name), `${shell}: global --${name} is missing`);
    }
  }
});

test('hidden commands and flags are not offered', () => {
  // Hidden means "kept working, not advertised" — usually a deprecated
  // spelling. Completing it teaches people the name we are trying to retire.
  const withHidden: ProgramDef = {
    ...program,
    commands: [
      ...program.commands,
      {
        name: 'secret-legacy-command',
        summary: 'deprecated',
        hidden: true,
        flags: { 'secret-legacy-flag': { type: 'boolean', summary: 'deprecated', hidden: true } },
        run: () => 0,
      },
    ],
  };

  for (const shell of SHELLS) {
    const script = completionsFor(withHidden, shell);
    assert.doesNotMatch(script, /secret-legacy-command/, shell);
    assert.doesNotMatch(script, /secret-legacy-flag/, shell);
  }
});

test('aliases are completable', () => {
  // A distinctive alias rather than the registry's real `n`, which is one
  // character and matches inside half the words in the script.
  const aliased: ProgramDef = {
    ...program,
    commands: [{ name: 'primary', aliases: ['zzalias'], summary: 'a thing', run: () => 0 }],
  };

  for (const shell of SHELLS) {
    assert.match(completionsFor(aliased, shell), /zzalias/, `${shell}: alias missing`);
  }
});

test('flag choices are offered as values', () => {
  const script = fishCompletions(program);
  // `notes --status` has choices; they should be completable, and `-x` rather
  // than `-r` so the file listing does not drown them.
  assert.match(script, /-l 'status'.*-x.*-a 'draft [^']*'/);
});

/* --- escaping ------------------------------------------------------------ */

const hostile = (summary: string): ProgramDef => ({
  ...program,
  commands: [{ name: 'hostile', summary, run: () => 0 }],
});

// bash's completion word list is names only — it carries no descriptions, so
// there is no summary in it to escape. Asserting against bash here would pass
// vacuously, which reads as coverage it does not have.
const DESCRIBING = ['zsh', 'fish'] as const;

test("a colon in a summary does not corrupt zsh's value:description pairs", () => {
  // _describe splits on the first colon. Unescaped, "note: be careful" makes
  // the description "note" and leaves the rest as a stray field.
  const script = zshCompletions(hostile('warning: this does two things'));

  assert.match(script, /'hostile:warning\\: this does two things'/);
  // One unescaped colon in the entry — the separator itself.
  const entry = script.match(/'hostile:[^']*'/)?.[0] ?? '';
  assert.equal(entry.split(/(?<!\\):/).length, 2, `zsh entry has a bare colon: ${entry}`);
});

test('an apostrophe in a summary does not end the shell string', () => {
  for (const shell of DESCRIBING) {
    const script = generators[shell](hostile("don't break this"));
    // The POSIX idiom: close, escaped quote, reopen.
    assert.match(script, /don'\\''t break this/, shell);
  }
});

test('a newline in a summary is collapsed rather than ending the statement', () => {
  for (const shell of DESCRIBING) {
    const script = generators[shell](hostile('first line\nsecond line'));
    assert.match(script, /first line second line/, shell);
  }
});

test('a backtick in a summary cannot become a command substitution', () => {
  for (const shell of DESCRIBING) {
    const script = generators[shell](hostile('run `rm -rf /` first'));
    assert.doesNotMatch(script, /`rm -rf \/`/, shell);
  }
});

/* --- shape --------------------------------------------------------------- */

test('each script carries what its shell needs to load it', () => {
  const bash = bashCompletions(program);
  assert.match(bash, new RegExp(`complete -F _${program.name} ${program.name}`));

  const zsh = zshCompletions(program);
  assert.match(zsh, new RegExp(`^#compdef ${program.name}`), 'zsh needs #compdef on line 1');
  // Works both autoloaded from fpath and eval'd from an rc file.
  assert.match(zsh, /funcstack\[1\]/);
  assert.match(zsh, new RegExp(`compdef _${program.name} ${program.name}`));

  const fish = fishCompletions(program);
  assert.match(fish, new RegExp(`complete -c ${program.name} -f`), 'fish should not offer files by default');
});

test('the binary name is taken from the program, not hardcoded', () => {
  // Everything here has to survive `rebrand`, which only rewrites src/app.ts.
  //
  // Asserted on the places the name is *structural* — the compdef line, the
  // function, the `complete -c` target — rather than on the bare word. A
  // summary is free to mention the product by name, and a CLI whose name is a
  // word ("updates") would fail a whole-word check on its own prose.
  const renamed: ProgramDef = { ...program, name: 'zzrenamed' };

  const structural: Record<string, RegExp[]> = {
    bash: [/complete -F _zzrenamed zzrenamed/],
    zsh: [/^#compdef zzrenamed/m, /^_zzrenamed\(\) \{/m, /compdef _zzrenamed zzrenamed/],
    fish: [/^complete -c zzrenamed -f$/m],
  };

  for (const shell of SHELLS) {
    const script = completionsFor(renamed, shell);
    for (const pattern of structural[shell] ?? []) {
      assert.match(script, pattern, `${shell}: ${pattern} — the old name is still wired in`);
    }
  }
});

test('the generated scripts do not name a command the CLI does not have', () => {
  // The comment explaining flag-skipping used to say `notes`, which is this
  // template's example command. Every adopter who deleted it shipped a
  // completion file documenting a command that did not exist.
  const other: ProgramDef = {
    name: 'other',
    version: '1.0.0',
    summary: 'a CLI with a different command set',
    commands: [{ name: 'deploy', summary: 'ship it', run: () => Promise.resolve() }],
    globalFlags: {},
  };

  for (const shell of SHELLS) {
    const script = completionsFor(other, shell);
    assert.ok(!script.includes('notes'), `${shell} names a command "other" does not have`);
  }
});
