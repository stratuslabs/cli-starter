/**
 * `acme doctor` — the command people run when something is wrong, so a wrong
 * answer here costs more than a wrong answer anywhere else.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { APP } from '../src/app.ts';
import { saveCredential } from '../src/core/credentials.ts';
import { EXIT } from '../src/core/errors.ts';
import { stripAnsi } from '../src/core/theme.ts';
import { createTempHome, run } from './support/harness.ts';

test('--offline still reports that nobody is signed in', async () => {
  const home = await createTempHome();
  try {
    // Whether a token resolves is a local question. Answering "ok" here on a
    // machine that was never signed in is a false clean bill of health handed
    // out immediately before every API command fails with auth.not_signed_in.
    const result = await run({ argv: ['doctor', '--offline'], homeDir: home.path });

    assert.equal(result.exitCode, EXIT.config, result.output.plain);
    assert.match(stripAnsi(result.output.plain), /Not signed in/);
  } finally {
    await home.cleanup();
  }
});

test('--offline reports a stored token without verifying it', async () => {
  const home = await createTempHome();
  try {
    await saveCredential(home.path, APP.brand, 'default', {
      token: 'tok_offline',
      baseUrl: APP.auth.baseUrl,
      createdAt: new Date().toISOString(),
    });

    // The harness throws on any network call, so this also proves nothing
    // reached out.
    const result = await run({ argv: ['doctor', '--offline'], homeDir: home.path });

    assert.equal(result.exitCode, EXIT.ok, result.output.plain);
    assert.match(stripAnsi(result.output.plain), /not verified/);
  } finally {
    await home.cleanup();
  }
});

test('--config names the file doctor inspects', async () => {
  const home = await createTempHome();
  try {
    const chosen = join(home.path, 'chosen.json');
    await writeFile(chosen, JSON.stringify({ baseUrl: 'https://chosen.example' }));

    // A config that would win by auto-discovery, so a pass here cannot come
    // from there being nothing else to find.
    await mkdir(join(home.path, `.${APP.brand}`), { recursive: true });
    await writeFile(
      join(home.path, `.${APP.brand}`, 'config.json'),
      JSON.stringify({ baseUrl: 'https://discovered.example' }),
    );

    const result = await run({
      argv: ['doctor', '--offline', '--config', chosen],
      homeDir: home.path,
    });

    const plain = stripAnsi(result.output.plain);
    assert.match(plain, new RegExp(chosen.replaceAll('.', '\\.')));
    assert.doesNotMatch(plain, new RegExp(`\\.${APP.brand}/config\\.json`));
  } finally {
    await home.cleanup();
  }
});

test('--config with a missing file is a problem, not a silent fallback', async () => {
  const home = await createTempHome();
  try {
    // Reporting on some other file is the answer least useful to someone
    // running doctor precisely because they suspect the wrong config is in use.
    const result = await run({
      argv: ['doctor', '--offline', '--config', join(home.path, 'nope.json')],
      homeDir: home.path,
    });

    assert.notEqual(result.exitCode, EXIT.ok, result.output.plain);
  } finally {
    await home.cleanup();
  }
});
