/**
 * Endpoint resolution — the one file that knows this CLI's own addresses, and
 * the first thing an adopter edits.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APP, BASE_URL_FLAG, resolveAuthProvider, resolveBaseUrl } from '../src/app.ts';
import { createFlagBag } from '../src/core/context.ts';

const flags = (value: string) =>
  createFlagBag({ [BASE_URL_FLAG]: value }, { [BASE_URL_FLAG]: 'flag' });

const derivedUrls = (provider: ReturnType<typeof resolveAuthProvider>): (string | undefined)[] => [
  provider.authorizeUrl,
  provider.tokenUrl,
  provider.deviceCodeUrl,
  provider.identityUrl,
  provider.revokeUrl,
];

test('a trailing slash on the endpoint does not double the path separator', () => {
  // `http://localhost:3000/` is what a browser's address bar hands you, so it
  // is what people paste. HttpClient normalises it away via `new URL`, but the
  // auth URLs are built by concatenation — so unnormalised, every ordinary
  // command works and only sign-in fails, against an endpoint that is fine.
  const provider = resolveAuthProvider(APP, flags('http://localhost:3000/'));

  for (const url of derivedUrls(provider)) {
    assert.ok(url !== undefined);
    assert.doesNotMatch(url.replace('http://', ''), /\/\//, url);
  }

  assert.equal(resolveBaseUrl(APP, flags('http://localhost:3000/')).value, 'http://localhost:3000');
});

test('every derived URL follows the endpoint override, not just baseUrl', () => {
  // Rewriting only baseUrl is a bug with a confusing symptom: sign-in succeeds
  // against the endpoint you asked for, then whoami fails against one you
  // never named.
  const provider = resolveAuthProvider(APP, flags('https://staging.example'));

  assert.equal(provider.baseUrl, 'https://staging.example');
  for (const url of derivedUrls(provider)) {
    if (url !== undefined) assert.ok(url.startsWith('https://staging.example'), url);
  }
});

test('the built-in default is used when nothing overrides it', () => {
  const base = resolveBaseUrl(APP, createFlagBag({}));
  assert.equal(base.value, APP.auth.baseUrl);
  assert.equal(base.origin, 'built-in default');
});
