import assert from 'node:assert/strict';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  credentialsPath,
  deleteCredential,
  loadCredentials,
  resolveCredential,
  sameOrigin,
  saveCredential,
  type CredentialsFile,
} from '../../src/kit/credentials.ts';
import { AuthError } from '../../src/kit/errors.ts';
import { createTempHome } from '../support/harness.ts';

const credential = (baseUrl: string, token = 'tok_1') => ({
  token,
  baseUrl,
  createdAt: '2026-01-01T00:00:00.000Z',
});

test('the credentials file is written 0600', async () => {
  const home = await createTempHome();
  try {
    await saveCredential(home.path, 'kit', 'default', credential('https://api.example.com'));
    const mode = (await stat(credentialsPath(home.path, 'kit'))).mode & 0o777;
    assert.equal(mode, 0o600, 'a token readable by other users is the failure this store prevents');
  } finally {
    await home.cleanup();
  }
});

test('the containing directory is 0700', async () => {
  const home = await createTempHome();
  try {
    await saveCredential(home.path, 'kit', 'default', credential('https://api.example.com'));
    const mode = (await stat(join(home.path, '.kit'))).mode & 0o777;
    assert.equal(mode, 0o700);
  } finally {
    await home.cleanup();
  }
});

test('an already-loose file is tightened on the next write', async () => {
  const home = await createTempHome();
  try {
    // writeFile's `mode` only applies on create, so a file that already exists
    // keeps its permissions unless something explicitly chmods it. This is the
    // regression that the explicit chmod exists for.
    await mkdir(join(home.path, '.kit'), { recursive: true });
    const path = credentialsPath(home.path, 'kit');
    await writeFile(path, '{"version":1,"profiles":{}}', { mode: 0o644 });
    await chmod(path, 0o644);

    await saveCredential(home.path, 'kit', 'default', credential('https://api.example.com'));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await home.cleanup();
  }
});

test('an already-loose directory is tightened too', async () => {
  const home = await createTempHome();
  try {
    // mkdir's mode is ignored for an existing directory. Our other CLI hardens
    // the file on every write but the directory only on creation.
    await mkdir(join(home.path, '.kit'), { recursive: true, mode: 0o755 });
    await chmod(join(home.path, '.kit'), 0o755);

    await saveCredential(home.path, 'kit', 'default', credential('https://api.example.com'));
    assert.equal((await stat(join(home.path, '.kit'))).mode & 0o777, 0o700);
  } finally {
    await home.cleanup();
  }
});

test('saving one profile does not clobber the others', async () => {
  const home = await createTempHome();
  try {
    await saveCredential(home.path, 'kit', 'default', credential('https://api.example.com', 'a'));
    await saveCredential(home.path, 'kit', 'staging', credential('https://staging.example.com', 'b'));

    const file = await loadCredentials(home.path, 'kit');
    assert.deepEqual(Object.keys(file.profiles).sort(), ['default', 'staging']);
    assert.equal(file.profiles['default']?.token, 'a');
    assert.equal(file.profiles['staging']?.token, 'b');
  } finally {
    await home.cleanup();
  }
});

test('deleting one profile leaves the rest', async () => {
  const home = await createTempHome();
  try {
    await saveCredential(home.path, 'kit', 'default', credential('https://api.example.com', 'a'));
    await saveCredential(home.path, 'kit', 'staging', credential('https://staging.example.com', 'b'));

    assert.equal(await deleteCredential(home.path, 'kit', 'staging'), true);
    assert.equal(await deleteCredential(home.path, 'kit', 'staging'), false);

    const file = await loadCredentials(home.path, 'kit');
    assert.deepEqual(Object.keys(file.profiles), ['default']);
  } finally {
    await home.cleanup();
  }
});

test('a missing credentials file is not an error', async () => {
  const home = await createTempHome();
  try {
    assert.deepEqual(await loadCredentials(home.path, 'kit'), { version: 1, profiles: {} });
  } finally {
    await home.cleanup();
  }
});

/* ---- endpoint binding: the security-critical part ---------------------- */

const file = (baseUrl: string): CredentialsFile => ({
  version: 1,
  profiles: { default: credential(baseUrl) },
});

const options = (baseUrl: string, trusted: boolean) => ({
  profile: 'default',
  baseUrl,
  baseUrlOrigin: trusted ? '--base-url' : 'kit.config.json',
  baseUrlTrusted: trusted,
  now: new Date('2026-01-01T00:00:00.000Z'),
});

test('a token is used for the endpoint it was issued for', () => {
  const resolved = resolveCredential(
    file('https://api.example.com'),
    options('https://api.example.com', true),
  );
  assert.equal(resolved?.token, 'tok_1');
});

test('a trailing slash is not a different endpoint', () => {
  const resolved = resolveCredential(
    file('https://api.example.com'),
    options('https://api.example.com/', true),
  );
  assert.equal(resolved?.token, 'tok_1');
  assert.equal(sameOrigin('https://a.example.com', 'https://a.example.com/x'), true);
  assert.equal(sameOrigin('https://a.example.com', 'https://b.example.com'), false);
});

test('a token is never sent to a different endpoint named by a trusted source', () => {
  assert.throws(
    () => resolveCredential(file('https://api.example.com'), options('https://evil.example', true)),
    (error: unknown) => error instanceof AuthError && error.code === 'auth.endpoint_mismatch',
  );
});

test('an untrusted project config silently withholds the token rather than leaking it', () => {
  // A `kit.config.json` committed to a repository can name any host. Running
  // the CLI inside that checkout must not post the token to it — and must not
  // hard-fail either, since that would let any checked-in file break the CLI.
  const resolved = resolveCredential(
    file('https://api.example.com'),
    options('https://evil.example', false),
  );
  assert.equal(resolved, undefined);
});

test('an environment token outranks the store and is not endpoint-bound', () => {
  const resolved = resolveCredential(file('https://api.example.com'), {
    ...options('https://other.example', true),
    envToken: { name: 'KIT_TOKEN', value: 'from-env' },
  });
  assert.equal(resolved?.token, 'from-env');
  assert.equal(resolved?.source, '$KIT_TOKEN');
});

test('an expired credential fails with a clear message rather than a 401 later', () => {
  const expired: CredentialsFile = {
    version: 1,
    profiles: {
      default: { ...credential('https://api.example.com'), expiresAt: '2025-01-01T00:00:00.000Z' },
    },
  };
  assert.throws(
    () => resolveCredential(expired, options('https://api.example.com', true)),
    (error: unknown) => error instanceof AuthError && error.code === 'auth.expired',
  );
});

test('no credential at all resolves to undefined', () => {
  assert.equal(
    resolveCredential({ version: 1, profiles: {} }, options('https://api.example.com', true)),
    undefined,
  );
});
