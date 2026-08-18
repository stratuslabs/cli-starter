/**
 * The test harness.
 *
 * Every test drives the real `main()` in-process with fake streams, a fake
 * environment, and a temp home directory. Nothing is spawned, nothing touches
 * the network, and nothing leaks between cases.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { main } from '../../src/main.ts';
import type { CliEnvironment, CliStreams } from '../../src/kit/env.ts';
import { stripAnsi } from '../../src/kit/theme.ts';

export interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  /** Both streams with ANSI removed — what a human would read. */
  readonly plain: string;
}

export const createStreams = (): { streams: CliStreams; output: CapturedOutput } => {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        },
      },
    },
    output: {
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
      get plain() {
        return stripAnsi(stdout + stderr);
      },
    },
  };
};

export interface HarnessOptions {
  argv: string[];
  /** Lines fed to prompts. Absent means "no stdin", which refuses to prompt. */
  stdin?: string[];
  processEnv?: Record<string, string | undefined>;
  homeDir?: string;
  cwd?: string;
  /** Claim to be a terminal. The plain prompter is still used unless `stdin` is a TTY. */
  tty?: Partial<CliEnvironment['tty']>;
  fetch?: typeof globalThis.fetch;
  openExternal?: (url: string) => Promise<void>;
  now?: Date;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}

export interface HarnessResult {
  exitCode: number;
  output: CapturedOutput;
  homeDir: string;
}

/** A disposable `$HOME`, so credential tests never see each other's files. */
export const createTempHome = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const path = await mkdtemp(join(tmpdir(), 'cli-kit-test-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
};

export const run = async (options: HarnessOptions): Promise<HarnessResult> => {
  const { streams, output } = createStreams();
  const home = options.homeDir ?? (await createTempHome()).path;

  const env: CliEnvironment = {
    // Empty by default: a test must not pass or fail because of the developer's
    // shell. Anything the case needs, it states.
    processEnv: options.processEnv ?? {},
    cwd: options.cwd ?? home,
    homeDir: home,
    platform: options.platform ?? 'linux',
    tty: { stdoutIsTty: false, stdinIsTty: false, columns: 80, ...options.tty },
    ...(options.stdin === undefined
      ? {}
      : { stdin: Readable.from(options.stdin.map((line) => `${line}\n`)) }),
    fetch:
      options.fetch ??
      (() => {
        throw new Error('This test made an unexpected network call. Pass a fetch stub.');
      }),
    openExternal:
      options.openExternal ??
      (() => Promise.reject(new Error('openExternal was not stubbed in this test'))),
    now: () => options.now ?? new Date('2026-01-01T00:00:00.000Z'),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const exitCode = await main({ argv: options.argv, streams, env });
  return { exitCode, output, homeDir: home };
};

/**
 * A stdin that a test can push raw bytes into, for the interactive path.
 *
 * `setRawMode` is a no-op recorder rather than absent, because the prompter
 * calls it and a missing method would silently take a different code path than
 * production.
 */
export class FakeTty extends Readable {
  isTTY = true;
  isRaw = false;
  rawModeCalls: boolean[] = [];

  override _read(): void {
    // Pushed externally by the test.
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeCalls.push(mode);
    return this;
  }

  /** Send bytes as one chunk, exactly as a terminal would. */
  type(bytes: string): void {
    this.push(bytes);
  }
}
