/**
 * The real environment, built from `process`.
 *
 * This is the only module that reads globals. Tests construct a
 * `CliEnvironment` by hand instead of calling anything here, which is why they
 * need no temp-directory cleanup, no network, and no subprocess.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import type { CliEnvironment, CliStreams } from './env.ts';

/**
 * Open a URL in the user's default browser.
 *
 * Rejects when there is nothing to open with — a headless box, a container, a
 * missing `xdg-open`. Callers must treat that as "print the URL instead", never
 * as a fatal error, because the sign-in still works if the human can get the
 * URL to a browser some other way.
 */
export const openExternalUrl = async (url: string): Promise<void> => {
  const { platform } = process;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  // The empty string is `start`'s title argument. Without it, a URL containing
  // `&` is parsed as the window title and the browser never opens.
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: platform !== 'win32' });
    child.once('error', reject);
    child.once('spawn', () => {
      // Detach so the CLI can exit without waiting for the browser.
      child.unref();
      resolve();
    });
  });
};

export const nodeStreams = (): CliStreams => ({
  stdout: { write: (chunk) => process.stdout.write(chunk) },
  stderr: { write: (chunk) => process.stderr.write(chunk) },
});

export const nodeEnvironment = (signal?: AbortSignal): CliEnvironment => ({
  processEnv: { ...process.env },
  cwd: process.cwd(),
  homeDir: homedir(),
  platform: process.platform,
  tty: {
    stdoutIsTty: process.stdout.isTTY === true,
    stdinIsTty: process.stdin.isTTY === true,
    // `columns` is undefined when stdout is not a terminal; 80 is the
    // conventional assumption and keeps redirected output stable.
    columns: process.stdout.columns ?? 80,
  },
  stdin: process.stdin,
  fetch: globalThis.fetch,
  openExternal: openExternalUrl,
  now: () => new Date(),
  ...(signal === undefined ? {} : { signal }),
});

/**
 * Abort on the first Ctrl-C, and let a second one kill the process outright.
 *
 * The first signal unwinds cleanly: spinners stop, raw mode is released, the
 * cursor comes back. If a command ignores the abort, the user should not have
 * to reach for `kill`.
 */
export const installSignalHandlers = (): AbortController => {
  const controller = new AbortController();
  let signalled = false;

  const onSignal = (): void => {
    if (signalled) {
      process.exit(130);
    }
    signalled = true;
    controller.abort();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return controller;
};
