#!/usr/bin/env node
/**
 * The executable.
 *
 * Kept to almost nothing on purpose. This is the only file that touches
 * `process.exit`, and the only place a global signal handler is installed —
 * everything else is a pure function that returns an exit code.
 *
 * The Node version check runs **before any other import**, because the error a
 * user gets from an unsupported runtime should be one clear sentence, not a
 * syntax error from deep inside a dependency.
 */

import { nodeVersionSupported } from './commands/doctor.ts';

const version = process.versions.node;

if (!nodeVersionSupported(version)) {
  process.stderr.write(
    `This CLI needs Node >=22.13 <23 || >=23.4 — you are on v${version}.\n` +
      '  Node 23.0 to 23.3 are newer than the 22.13 floor but still lack what it provides.\n',
  );
  process.exit(1);
}

const [{ main }, { installSignalHandlers, nodeEnvironment, nodeStreams }] = await Promise.all([
  import('./main.ts'),
  import('./kit/node-env.ts'),
]);

const controller = installSignalHandlers();

const exitCode = await main({
  argv: process.argv.slice(2),
  streams: nodeStreams(),
  env: nodeEnvironment(controller.signal),
});

// Set rather than call `process.exit`, so buffered stdout is flushed. Calling
// exit() truncates output that is being piped, which is exactly the case where
// losing the last line matters most.
process.exitCode = exitCode;
