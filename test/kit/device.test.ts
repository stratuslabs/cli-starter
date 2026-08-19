import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultSleep, deviceLogin } from '../../src/kit/auth/device.ts';
import { EXIT, InterruptedError, type NetworkError } from '../../src/kit/errors.ts';

const activeTimers = (): number =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

test('the poll interval keeps the event loop alive', async () => {
  // An unref'd timer does not, so once the initial HTTP connection goes idle
  // Node exits mid-poll and device sign-in never completes — a failure that
  // only shows up on the machines this flow exists for.
  const before = activeTimers();
  const waiting = defaultSleep(20);
  assert.equal(activeTimers(), before + 1);
  await waiting;
  assert.equal(activeTimers(), before);
});

test('a cancelled device request is a cancellation, not an unreachable server', async () => {
  // The polling loop checks the signal around its sleep, but an abort landing
  // mid-request surfaces from fetch — and that branch used to call Ctrl-C
  // "could not reach the sign-in server" and exit 5.
  const controller = new AbortController();

  await assert.rejects(
    deviceLogin({
      provider: {
        displayName: 'Example',
        baseUrl: 'https://api.example.test',
        authorizeUrl: 'https://api.example.test/authorize',
        tokenUrl: 'https://api.example.test/token',
        deviceCodeUrl: 'https://api.example.test/device/code',
        clientId: 'test',
      },
      fetch: () =>
        new Promise((_resolve, reject) => {
          controller.abort();
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }),
      onPrompt: () => {
        throw new Error('should not have got as far as prompting');
      },
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof InterruptedError, `got ${String(error)}`);
      assert.equal((error as InterruptedError).exitCode, EXIT.interrupted);
      return true;
    },
  );
});

test('a genuinely unreachable server is still a network failure', async () => {
  // The other half, so the fix cannot just relabel every failure.
  await assert.rejects(
    deviceLogin({
      provider: {
        displayName: 'Example',
        baseUrl: 'https://api.example.test',
        authorizeUrl: 'https://api.example.test/authorize',
        tokenUrl: 'https://api.example.test/token',
        deviceCodeUrl: 'https://api.example.test/device/code',
        clientId: 'test',
      },
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      onPrompt: () => {
        throw new Error('should not have got as far as prompting');
      },
    }),
    (error: unknown) => {
      assert.equal((error as NetworkError).code, 'auth.device_unreachable');
      return true;
    },
  );
});
