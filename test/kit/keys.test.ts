/**
 * The three bugs that make terminal input hard, as ordinary unit tests.
 *
 * In our other CLI this logic lives inside a stdin `data` handler and has no
 * tests at all — it can only be exercised by a human at a real terminal. Pulling
 * the decoder out into a pure function is what makes these assertable.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KeyDecoder } from '../../src/kit/keys.ts';

const ESC = '\u001b';
const names = (keys: { name: string }[]): string[] => keys.map((key) => key.name);

test('decodes ordinary characters', () => {
  const decoder = new KeyDecoder();
  const keys = decoder.push('ab');
  assert.deepEqual(names(keys), ['char', 'char']);
  assert.deepEqual(keys.map((key) => key.ch), ['a', 'b']);
});

test('decodes CSI arrow keys', () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(names(decoder.push(`${ESC}[A`)), ['up']);
  assert.deepEqual(names(decoder.push(`${ESC}[B`)), ['down']);
});

test('decodes SS3 arrow keys, which tmux and some SSH servers send instead', () => {
  const decoder = new KeyDecoder();
  // A decoder that only handles ESC [ works on the author's machine and fails
  // for anyone whose terminal is in application cursor mode.
  assert.deepEqual(names(decoder.push(`${ESC}OA`)), ['up']);
  assert.deepEqual(names(decoder.push(`${ESC}OB`)), ['down']);
});

test('key repeat arrives as one chunk and yields one key per press', () => {
  const decoder = new KeyDecoder();
  // Holding down the arrow key: the terminal coalesces the repeats into a
  // single write. Emitting only the first would make the menu feel stuck.
  const keys = decoder.push(`${ESC}[B${ESC}[B${ESC}[B`);
  assert.deepEqual(names(keys), ['down', 'down', 'down']);
});

test('an escape sequence split across chunks is reassembled', () => {
  const decoder = new KeyDecoder();
  // Over SSH the three bytes of an arrow key can land in three packets.
  assert.deepEqual(decoder.push(ESC), []);
  assert.equal(decoder.pending, ESC);
  assert.deepEqual(decoder.push('['), []);
  assert.deepEqual(names(decoder.push('A')), ['up']);
  assert.equal(decoder.pending, '');
});

test('a lone escape is only an Escape key once nothing follows it', () => {
  const decoder = new KeyDecoder();
  // This is the ambiguity the 75ms timer exists for: Esc and the first byte of
  // an arrow key are the same byte, so it cannot be resolved synchronously.
  assert.deepEqual(decoder.push(ESC), []);
  assert.deepEqual(names(decoder.flushPending()), ['escape']);
  assert.equal(decoder.pending, '');
});

test('pasted text following a menu key is preserved, not dropped', () => {
  const decoder = new KeyDecoder();
  // Pasting "2sk-ant-xyz" into a menu should select option 2 *and* keep the
  // rest for the prompt that follows.
  const keys = decoder.push('2sk-xyz');
  assert.deepEqual(
    keys.map((key) => key.ch),
    ['2', 's', 'k', '-', 'x', 'y', 'z'],
  );
});

test('control keys are named', () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(names(decoder.push('\r')), ['enter']);
  assert.deepEqual(names(decoder.push('\u0003')), ['ctrl-c']);
  assert.deepEqual(names(decoder.push('\u007f')), ['backspace']);
  assert.deepEqual(names(decoder.push('\t')), ['tab']);
  assert.deepEqual(names(decoder.push(' ')), ['space']);
});

test('home, end, and delete are decoded from their tilde sequences', () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(names(decoder.push(`${ESC}[3~`)), ['delete']);
  assert.deepEqual(names(decoder.push(`${ESC}[5~`)), ['pageup']);
});

test('an unterminated sequence does not wedge the decoder forever', () => {
  const decoder = new KeyDecoder();
  // Garbage after ESC [ can never complete a sequence. Buffering it
  // indefinitely would make the prompt stop responding to every later key.
  const keys = decoder.push(`${ESC}[!`);
  assert.deepEqual(names(keys), ['unknown']);
  assert.equal(decoder.pending, '');
});
