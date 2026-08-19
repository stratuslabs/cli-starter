/**
 * Configuration, resolved once, with provenance.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **There is exactly one implementation of the precedence chain.** Every
 *    place that wants to know "what would this run actually use?" calls
 *    `SettingResolver`. A second hand-rolled copy drifts from the first
 *    immediately — that is the single most repeated defect in our other
 *    codebase, where `setup`, `doctor`, and the runner each re-derive it.
 * 2. **Every resolved value remembers where it came from.** That is what makes
 *    `doctor` useful, and what lets an error say "your project config is
 *    overriding this" instead of "wrong value".
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { ConfigError } from './errors.ts';

export type SourceKind = 'flag' | 'env' | 'config' | 'default';

export interface Resolved<T> {
  value: T;
  source: SourceKind;
  /** The flag, environment variable, or file path that supplied it. */
  origin: string;
  /**
   * Whether the origin is one the user chose deliberately.
   *
   * A config file discovered by walking up from the working directory is
   * **untrusted**: you can land in it by `cd`-ing into a repository someone
   * else wrote. It may set a model or an output format; it may not redirect
   * credentials. See `credentials.ts`.
   */
  trusted: boolean;
}

export interface ConfigLocation {
  path: string;
  trusted: boolean;
  kind: 'explicit' | 'project' | 'user';
}

export interface LoadedConfig {
  location: ConfigLocation | undefined;
  data: Record<string, unknown>;
}

export interface ConfigLookupOptions {
  /** Lower-case brand slug: `<brand>.config.json` and `~/.<brand>/config.json`. */
  brand: string;
  cwd: string;
  homeDir: string;
  /** From `--config` or `<BRAND>_CONFIG`. */
  explicitPath?: string | undefined;
}

/** Where the config file is, and whether we trust it with security decisions. */
export const resolveConfigLocation = async (
  options: ConfigLookupOptions,
  exists: (path: string) => Promise<boolean>,
): Promise<ConfigLocation | undefined> => {
  if (options.explicitPath !== undefined && options.explicitPath !== '') {
    const path = resolvePath(options.cwd, options.explicitPath);
    if (!(await exists(path))) {
      throw new ConfigError('config.missing', `Config file not found: ${path}`, {
        hint: 'Check the path passed to --config.',
        details: { path },
      });
    }
    return { path, trusted: true, kind: 'explicit' };
  }

  // Walk up from the working directory: a config at the repository root should
  // apply to a command run from a subdirectory.
  const projectName = `${options.brand}.config.json`;
  let directory = resolvePath(options.cwd);
  for (;;) {
    const candidate = join(directory, projectName);
    if (await exists(candidate)) return { path: candidate, trusted: false, kind: 'project' };
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const userPath = join(options.homeDir, `.${options.brand}`, 'config.json');
  if (await exists(userPath)) return { path: userPath, trusted: true, kind: 'user' };

  return undefined;
};

export const loadConfigFile = async (
  location: ConfigLocation | undefined,
): Promise<LoadedConfig> => {
  if (location === undefined) return { location: undefined, data: {} };

  let raw: string;
  try {
    raw = await readFile(location.path, 'utf8');
  } catch (error) {
    throw new ConfigError('config.unreadable', `Could not read ${location.path}.`, {
      cause: error,
      details: { path: location.path },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError('config.invalid', `${location.path} is not valid JSON.`, {
      hint: 'Fix the syntax, or delete the file to start from defaults.',
      cause: error,
      details: { path: location.path },
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('config.invalid', `${location.path} must contain a JSON object.`, {
      details: { path: location.path },
    });
  }

  return { location, data: parsed as Record<string, unknown> };
};

export interface SettingRequest<T> {
  /** Flag name, without dashes. */
  flag?: string;
  /** Environment variable, spelled in full. */
  env?: string;
  /** Key in the config file. */
  configKey?: string;
  fallback?: T;
}

export interface SettingResolverOptions {
  flags: Record<string, string | boolean | string[] | undefined>;
  /** Flags the user actually typed, as opposed to defaults. */
  provided: ReadonlySet<string>;
  processEnv: Record<string, string | undefined>;
  config: LoadedConfig;
}

/**
 * The one place precedence is expressed: flag → environment → config → default.
 *
 * Do not re-implement this ordering anywhere else. If you need a rule that is
 * not here, add it here and export it.
 */
export class SettingResolver {
  private flags: Record<string, string | boolean | string[] | undefined>;
  private provided: ReadonlySet<string>;
  private processEnv: Record<string, string | undefined>;
  private config: LoadedConfig;

  constructor(options: SettingResolverOptions) {
    this.flags = options.flags;
    this.provided = options.provided;
    this.processEnv = options.processEnv;
    this.config = options.config;
  }

  string(request: SettingRequest<string>): Resolved<string | undefined> {
    if (request.flag !== undefined && this.provided.has(request.flag)) {
      const value = this.flags[request.flag];
      if (typeof value === 'string') {
        return { value, source: 'flag', origin: `--${request.flag}`, trusted: true };
      }
    }

    if (request.env !== undefined) {
      const value = this.processEnv[request.env];
      if (value !== undefined && value !== '') {
        return { value, source: 'env', origin: request.env, trusted: true };
      }
    }

    if (request.configKey !== undefined && this.config.location !== undefined) {
      const value = this.config.data[request.configKey];
      if (typeof value === 'string') {
        return {
          value,
          source: 'config',
          origin: this.config.location.path,
          trusted: this.config.location.trusted,
        };
      }
    }

    return { value: request.fallback, source: 'default', origin: 'built-in', trusted: true };
  }

  boolean(request: SettingRequest<boolean>): Resolved<boolean | undefined> {
    if (request.flag !== undefined && this.provided.has(request.flag)) {
      const value = this.flags[request.flag];
      if (typeof value === 'boolean') {
        return { value, source: 'flag', origin: `--${request.flag}`, trusted: true };
      }
    }

    if (request.env !== undefined) {
      const value = this.processEnv[request.env];
      if (value !== undefined && value !== '') {
        return {
          value: value !== '0' && value.toLowerCase() !== 'false',
          source: 'env',
          origin: request.env,
          trusted: true,
        };
      }
    }

    if (request.configKey !== undefined && this.config.location !== undefined) {
      const value = this.config.data[request.configKey];
      if (typeof value === 'boolean') {
        return {
          value,
          source: 'config',
          origin: this.config.location.path,
          trusted: this.config.location.trusted,
        };
      }
    }

    return { value: request.fallback, source: 'default', origin: 'built-in', trusted: true };
  }
}

/** Human-readable provenance, used by `doctor` and by error hints. */
export const describeSource = <T>(resolved: Resolved<T>): string => {
  switch (resolved.source) {
    case 'flag':
      return `passed as ${resolved.origin}`;
    case 'env':
      return `from $${resolved.origin}`;
    case 'config':
      return `from ${resolved.origin}${resolved.trusted ? '' : ' (project config)'}`;
    default:
      return 'default';
  }
};
