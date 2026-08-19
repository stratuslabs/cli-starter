import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultSleep } from '../../src/kit/auth/device.ts';

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
