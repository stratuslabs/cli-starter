/**
 * The version, read from `package.json` at startup.
 *
 * Both of our other CLIs hard-code a version string that duplicates the
 * manifest — one of them is already out of step with it. A constant that must
 * be kept in sync by hand will eventually not be, so this reads the manifest
 * instead and there is nothing to forget.
 *
 * The upward walk exists because the file sits at a different depth depending
 * on whether the CLI is running from `src/` under type stripping or from
 * `dist/` after a build.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const findPackageVersion = (startDir: string): string => {
  let directory = startDir;
  for (;;) {
    try {
      const raw = readFileSync(join(directory, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Not here, or not readable — keep walking.
    }
    const parent = dirname(directory);
    // A CLI that cannot find its own manifest should still run; only `--version`
    // is degraded, and saying so is better than crashing at startup.
    if (parent === directory) return '0.0.0-unknown';
    directory = parent;
  }
};

export const CLI_VERSION = findPackageVersion(import.meta.dirname);
