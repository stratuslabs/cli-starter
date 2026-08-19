/**
 * The interactive path, tested.
 *
 * Both of our other CLIs have zero coverage here — every test goes through the
 * piped prompter, so the raw-mode key handling, the redraw, and the secret
 * masking are exercised only by a human at a terminal. A fake TTY plus the
 * pure key decoder makes all of it ordinary.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';

import {
  createInteractivePrompter,
  createNonInteractivePrompter,
  createPlainPrompter,
} from '../../src/core/prompt.ts';
import { stripAnsi, plainTheme } from '../../src/core/theme.ts';
import { FakeTty } from '../support/harness.ts';

const ESC = '\u001b';

const setup = () => {
  let written = '';
  const output = {
    write(chunk: string) {
      written += chunk;
      return true;
    },
  };
  const stdin = new FakeTty();
  const prompter = createInteractivePrompter({
    stdin,
    output,
    theme: plainTheme(80),
    // Short, so the lone-Escape case does not slow the suite down.
    escapeTimeoutMs: 5,
  });
  return {
    stdin,
    prompter,
    get text() {
      return stripAnsi(written);
    },
    /** Escapes included — needed to assert on cursor and redraw control codes. */
    get raw() {
      return written;
    },
  };
};

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

test('arrow keys move the selection and Enter picks it', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options });

  harness.stdin.type(`${ESC}[B`); // down → Beta
  harness.stdin.type('\r');

  const result = await pending;
  assert.deepEqual(result, { kind: 'value', value: 'b', index: 1 });
  harness.prompter.close();
});

test('j and k move the selection, for people who live in vim', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options });

  harness.stdin.type('jj');
  harness.stdin.type('\r');

  assert.deepEqual(await pending, { kind: 'value', value: 'c', index: 2 });
  harness.prompter.close();
});

test('the selection wraps at the ends', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options });

  harness.stdin.type(`${ESC}[A`); // up from the first entry wraps to the last
  harness.stdin.type('\r');

  assert.deepEqual(await pending, { kind: 'value', value: 'c', index: 2 });
  harness.prompter.close();
});

test('a digit jumps straight to that option', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options });

  harness.stdin.type('3');

  assert.deepEqual(await pending, { kind: 'value', value: 'c', index: 2 });
  harness.prompter.close();
});

test('a disabled option is skipped rather than selected', async () => {
  const harness = setup();
  const pending = harness.prompter.select({
    message: 'Pick one',
    options: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta', disabled: true },
      { value: 'c', label: 'Gamma' },
    ],
  });

  harness.stdin.type(`${ESC}[B`); // skips Beta
  harness.stdin.type('\r');

  assert.deepEqual(await pending, { kind: 'value', value: 'c', index: 2 });
  harness.prompter.close();
});

test('an arrow key split across chunks still moves the cursor', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options });

  // Exactly what SSH does on a slow link.
  harness.stdin.type(ESC);
  harness.stdin.type('[');
  harness.stdin.type('B');
  harness.stdin.type('\r');

  assert.deepEqual(await pending, { kind: 'value', value: 'b', index: 1 });
  harness.prompter.close();
});

test('Escape backs out when the caller allows it', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options, allowBack: true });

  harness.stdin.type(ESC);

  // Resolves only after the escape timer decides this was a real Escape and
  // not the start of an arrow key.
  assert.deepEqual(await pending, { kind: 'back' });
  harness.prompter.close();
});

test('Ctrl-C cancels with the conventional exit code', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options });

  harness.stdin.type('\u0003');

  await assert.rejects(pending, (error: unknown) => (error as { exitCode?: number }).exitCode === 130);
  harness.prompter.close();
});

test('typed text is offered as an escape hatch for long lists', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options, allowText: true });

  harness.stdin.type('custom');
  harness.stdin.type('\r');

  assert.deepEqual(await pending, { kind: 'text', text: 'custom' });
  harness.prompter.close();
});

test('a secret is never echoed', async () => {
  const harness = setup();
  const pending = harness.prompter.secret({ message: 'Token:' });

  harness.stdin.type('sk-super-secret');
  harness.stdin.type('\r');

  assert.equal(await pending, 'sk-super-secret');
  assert.ok(
    !harness.text.includes('sk-super-secret'),
    'the secret was echoed to the terminal, where it would land in scrollback',
  );
  harness.prompter.close();
});

test('text input supports backspace', async () => {
  const harness = setup();
  const pending = harness.prompter.text({ message: 'Name:' });

  harness.stdin.type('abc');
  harness.stdin.type('\u007f');
  harness.stdin.type('d\r');

  assert.equal(await pending, 'abd');
  harness.prompter.close();
});

test('a prefilled value is editable and kept on a bare Enter', async () => {
  const harness = setup();
  const pending = harness.prompter.text({ message: 'Name:', initial: 'draft' });

  harness.stdin.type('\r');

  assert.equal(await pending, 'draft');
  harness.prompter.close();
});

test('validation re-asks instead of accepting a bad value', async () => {
  const harness = setup();
  const pending = harness.prompter.text({
    message: 'Name:',
    validate: (value) => (value.length < 3 ? 'Too short.' : undefined),
  });

  harness.stdin.type('ab\r'); // rejected
  harness.stdin.type('c\r'); // now "abc", accepted

  assert.equal(await pending, 'abc');
  assert.ok(harness.text.includes('Too short.'));
  harness.prompter.close();
});

test('the cursor is restored when the prompt ends', async () => {
  const harness = setup();
  const pending = harness.prompter.select({ message: 'Pick one', options });
  harness.stdin.type('\r');
  await pending;
  harness.prompter.close();

  // A hidden cursor is global terminal state. Leaving it hidden wrecks the
  // user's shell after the process exits, and nothing in the shell tells them
  // why — so every hide must be matched by a show.
  const raw = harness.raw;
  const hides = (raw.match(/\[\?25l/g) ?? []).length;
  const shows = (raw.match(/\[\?25h/g) ?? []).length;
  assert.ok(hides > 0, 'expected the prompt to hide the cursor while drawing');
  assert.equal(shows, hides, 'the cursor was hidden more often than it was restored');
});

test('keys typed between prompts are queued, not dropped', async () => {
  const harness = setup();

  // Type ahead: answer both prompts before the second one is even asked.
  harness.stdin.type('2');
  harness.stdin.type('1');

  assert.deepEqual(await harness.prompter.select({ message: 'First', options }), {
    kind: 'value',
    value: 'b',
    index: 1,
  });
  assert.deepEqual(await harness.prompter.select({ message: 'Second', options }), {
    kind: 'value',
    value: 'a',
    index: 0,
  });
  harness.prompter.close();
});

test('multiselect toggles with space and confirms with enter', async () => {
  const harness = setup();
  const pending = harness.prompter.multiselect({ message: 'Pick some', options });

  harness.stdin.type(' '); // tick Alpha
  harness.stdin.type(`${ESC}[B`);
  harness.stdin.type(`${ESC}[B`);
  harness.stdin.type(' '); // tick Gamma
  harness.stdin.type('\r');

  assert.deepEqual(await pending, ['a', 'c']);
  harness.prompter.close();
});

/* ---- the piped path ----------------------------------------------------- */

const piped = (lines: string[]) => {
  let written = '';
  const prompter = createPlainPrompter({
    input: Readable.from(lines.map((line) => `${line}\n`)),
    output: {
      write(chunk: string) {
        written += chunk;
        return true;
      },
    },
    theme: plainTheme(80),
  });
  return {
    prompter,
    get text() {
      return written;
    },
  };
};

test('piped input selects by number', async () => {
  const harness = piped(['2']);
  assert.deepEqual(await harness.prompter.select({ message: 'Pick', options }), {
    kind: 'value',
    value: 'b',
    index: 1,
  });
  assert.ok(harness.text.includes('1) Alpha'));
});

test('an empty line takes the default', async () => {
  const harness = piped(['']);
  assert.deepEqual(await harness.prompter.select({ message: 'Pick', options, initial: 2 }), {
    kind: 'value',
    value: 'c',
    index: 2,
  });
});

test('a typo does not silently select a lookalike option', async () => {
  // Our other CLI substring-matches here, so "Gam" would pick Gamma and "a"
  // would pick Alpha — a script cannot tell that happened.
  const harness = piped(['Gam']);
  assert.deepEqual(await harness.prompter.select({ message: 'Pick', options }), { kind: 'back' });
});

test('an exact label match is accepted', async () => {
  const harness = piped(['Gamma']);
  assert.deepEqual(await harness.prompter.select({ message: 'Pick', options }), {
    kind: 'value',
    value: 'c',
    index: 2,
  });
});

/* ---- the refusing path -------------------------------------------------- */

test('with nothing to ask, a prompt fails immediately and names the fix', async () => {
  // The alternative — blocking forever — burns a CI runner and reports nothing.
  const prompter = createNonInteractivePrompter();
  await assert.rejects(prompter.confirm({ message: 'Sure?' }), (error: unknown) => {
    const cli = error as { code?: string; hint?: string };
    return cli.code === 'non_interactive' && (cli.hint ?? '').includes('--yes');
  });
});
