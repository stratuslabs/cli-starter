/**
 * `kit doctor` — what this CLI would actually do, and why.
 *
 * The point is **provenance**, not a list of green ticks. Almost every support
 * question of the form "it works on my machine but not in CI" is really "a
 * different config file won", and the only way to answer it is to print which
 * file, which variable, and which default produced each value.
 *
 * Exits non-zero when something is wrong, so it works as a health check.
 */

import { access, stat } from 'node:fs/promises';

import { APP, baseUrlEnvName, resolveBaseUrl, tokenEnvName } from '../app.ts';
import { defineCommand } from '../kit/command.ts';
import { credentialsPath, loadCredentials } from '../kit/credentials.ts';
import { detectColorLevel, detectUnicode, isCI, isInteractive } from '../kit/env.ts';
import { EXIT } from '../kit/errors.ts';
import { loadConfigFile, resolveConfigLocation } from '../kit/config.ts';
import { definitionList } from '../kit/render.ts';
import { fetchIdentity, openSession } from './session.ts';

interface Finding {
  label: string;
  value: string;
  /** Populated only when this line is a problem. */
  problem?: string;
  hint?: string;
}

const SUPPORTED_NODE = '>=22.13 <23 || >=23.4';

/**
 * The runtime check.
 *
 * The gap in the middle is real and is the reason this is not a simple
 * comparison: `node:sqlite` and the type-stripping flags were unflagged
 * separately on each release line, so 23.0–23.3 are *newer* than the 22.x floor
 * and still missing what 22.13 has.
 */
export const nodeVersionSupported = (version: string): boolean => {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  if (major > 23) return true;
  if (major === 23) return minor >= 4;
  if (major === 22) return minor >= 13;
  return false;
};

export const doctorCommand = defineCommand({
  name: 'doctor',
  summary: 'check the setup and show where every setting came from',
  description:
    'Prints the resolved configuration with its provenance, checks the credential ' +
    'store, and confirms the endpoint is reachable. Exits non-zero if anything is wrong.',
  flags: {
    offline: { type: 'boolean', summary: 'skip the checks that need the network (local checks still run)' },
  },
  examples: [{ cmd: 'doctor --json', note: 'machine-readable, for a health check' }],

  async run(ctx) {
    const findings: Finding[] = [];
    const exists = async (path: string): Promise<boolean> =>
      access(path).then(() => true, () => false);

    // ---- runtime -----------------------------------------------------------
    const nodeVersion = process.versions.node;
    findings.push({
      label: 'node',
      value: `v${nodeVersion}`,
      ...(nodeVersionSupported(nodeVersion)
        ? {}
        : {
            problem: `Node ${SUPPORTED_NODE} is required.`,
            hint: 'Upgrade Node, or use a version manager to select a supported release.',
          }),
    });

    // ---- terminal ----------------------------------------------------------
    const colorLevel = detectColorLevel(ctx.env.processEnv, ctx.env.tty);
    findings.push({
      label: 'terminal',
      value: [
        ctx.env.tty.stdoutIsTty ? 'tty' : 'not a tty',
        `${ctx.env.tty.columns} cols`,
        `colour: ${colorLevel}`,
        detectUnicode(ctx.env.processEnv, ctx.env.platform) ? 'unicode' : 'ascii',
        isCI(ctx.env.processEnv) ? 'CI' : isInteractive(ctx.env) ? 'interactive' : 'non-interactive',
      ].join(', '),
    });

    // ---- config ------------------------------------------------------------
    const location = await resolveConfigLocation(
      {
        brand: APP.brand,
        cwd: ctx.env.cwd,
        homeDir: ctx.env.homeDir,
        // Through the flag, not the raw variable: `--config` is declared with
        // its env fallback, so this is the one place precedence is decided.
        // Reading the variable directly makes `doctor --config <path>` report
        // on a file the user did not name — and pass when that file is missing,
        // which is the exact question they ran doctor to answer.
        explicitPath: ctx.flags.string('config'),
      },
      exists,
    );
    await loadConfigFile(location);

    findings.push({
      label: 'config',
      value:
        location === undefined
          ? ctx.theme.muted('none found (using defaults)')
          : `${location.path}${location.trusted ? '' : ctx.theme.muted(' — project config, not trusted for credentials')}`,
    });

    // ---- endpoint ----------------------------------------------------------
    const base = resolveBaseUrl(APP, ctx.flags);
    findings.push({
      label: 'endpoint',
      value: `${base.value} ${ctx.theme.muted(`(${base.origin})`)}`,
    });

    // ---- credentials -------------------------------------------------------
    const store = credentialsPath(ctx.env.homeDir, APP.brand);
    const credentials = await loadCredentials(ctx.env.homeDir, APP.brand);
    const profiles = Object.keys(credentials.profiles);

    if (await exists(store)) {
      const mode = (await stat(store)).mode & 0o777;
      findings.push({
        label: 'credentials',
        value: `${store} ${ctx.theme.muted(`(${profiles.length} profile${profiles.length === 1 ? '' : 's'}, mode ${mode.toString(8).padStart(4, '0')})`)}`,
        // A world-readable credentials file is the failure this whole store is
        // designed to prevent, so it is reported as a problem, not a note.
        ...(mode === 0o600
          ? {}
          : {
              problem: 'The credentials file is readable by other users.',
              hint: `Run: chmod 600 ${store}`,
            }),
      });
    } else {
      findings.push({ label: 'credentials', value: ctx.theme.muted('none saved') });
    }

    const envToken = ctx.env.processEnv[tokenEnvName(APP)];
    if (envToken !== undefined && envToken !== '') {
      findings.push({
        label: 'token',
        value: `$${tokenEnvName(APP)} ${ctx.theme.muted('(overrides the saved sign-in)')}`,
      });
    }

    // ---- sign-in -----------------------------------------------------------
    //
    // Whether a token resolves at all is a local question, so --offline skips
    // only the request that confirms it. Skipping the whole block lets doctor
    // exit 0 on a machine that was never signed in, immediately before every
    // API command fails with auth.not_signed_in.
    const session = await openSession(ctx);
    if (session.token === undefined) {
      findings.push({
        label: 'sign-in',
        value: ctx.theme.muted('not signed in'),
        problem: 'Not signed in.',
        hint: `Run \`${APP.name} login\`.`,
      });
    } else if (ctx.flags.boolean('offline')) {
      findings.push({
        label: 'sign-in',
        value: `${ctx.theme.muted(`token from ${session.tokenSource}`)} ${ctx.theme.muted('(not verified — offline)')}`,
      });
    } else {
      try {
        const identity = await fetchIdentity(session);
        findings.push({
          label: 'sign-in',
          value: `${identity?.name ?? identity?.email ?? identity?.id ?? 'ok'} ${ctx.theme.muted(`via ${session.tokenSource}`)}`,
        });
      } catch (error) {
        findings.push({
          label: 'sign-in',
          value: ctx.theme.muted('could not be confirmed'),
          problem: error instanceof Error ? error.message : String(error),
          hint: `Run \`${APP.name} login\` to sign in again.`,
        });
      }
    }

    const problems = findings.filter((finding) => finding.problem !== undefined);

    ctx.emit({
      ok: problems.length === 0,
      findings: findings.map((finding) => ({
        label: finding.label,
        value: finding.value,
        ...(finding.problem === undefined ? {} : { problem: finding.problem, hint: finding.hint }),
      })),
    });

    if (!ctx.globals.json) {
      for (const line of definitionList(
        findings.map((finding) => ({ term: finding.label, description: finding.value })),
        ctx.theme,
      )) {
        ctx.out(line);
      }

      if (problems.length === 0) {
        ctx.say('');
        ctx.say(ctx.theme.ok('Everything looks fine.'));
      } else {
        ctx.say('');
        for (const problem of problems) {
          ctx.say(ctx.theme.fail(problem.problem ?? ''));
          if (problem.hint !== undefined) ctx.say(`  ${ctx.theme.muted(problem.hint)}`);
        }
      }
    }

    // Non-zero on problems so this can be used as a readiness probe.
    return problems.length === 0 ? EXIT.ok : EXIT.config;
  },
});

export { baseUrlEnvName };
