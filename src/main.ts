/**
 * The program definition, and the entry point tests call.
 *
 * `bin.ts` is a four-line wrapper around `main`; everything interesting is a
 * plain function of `{ argv, streams, env }`, so a test drives a whole command
 * without spawning anything.
 */

import { APP, BASE_URL_FLAG, baseUrlEnvName } from './app.ts';
import type { ProgramDef } from './core/command.ts';
import type { CliEnvironment, CliStreams } from './core/env.ts';
import { GLOBAL_FLAGS, runCli } from './core/run.ts';

import { completionsCommand } from './commands/completions.ts';
import { demoCommand } from './commands/demo.ts';
import { doctorCommand } from './commands/doctor.ts';
import { loginCommand } from './commands/login.ts';
import { logoutCommand } from './commands/logout.ts';
import { notesCommand } from './commands/notes.ts';
import { whoamiCommand } from './commands/whoami.ts';

/**
 * Add your commands here.
 *
 * This array is the whole registry: help, dispatch, and shell completions all
 * read from it, so a command that is listed here cannot be undocumented and a
 * command that is not listed here does not exist.
 */
export const program: ProgramDef = {
  name: APP.name,
  version: APP.version,
  summary: APP.summary,
  globalFlags: {
    ...GLOBAL_FLAGS,
    config: {
      type: 'string',
      placeholder: '<path>',
      summary: 'use a specific config file',
      env: `${APP.envPrefix}_CONFIG`,
    },
    // Global rather than per-command: every command that talks to the API needs
    // it, and three copies of the same definition is three chances to declare a
    // different environment variable on one of them.
    [BASE_URL_FLAG]: {
      type: 'string',
      placeholder: '<url>',
      summary: 'talk to a different API endpoint',
      env: baseUrlEnvName(APP),
    },
  },
  // notesCommand is the worked example; the rest is framework plumbing.
  commands: [
    notesCommand,
    loginCommand,
    logoutCommand,
    whoamiCommand,
    doctorCommand,
    completionsCommand,
    demoCommand,
  ],
  ...(APP.footer === undefined ? {} : { footer: APP.footer }),
  ...(APP.art === undefined ? {} : { art: APP.art }),
};

export const main = (options: {
  argv: readonly string[];
  streams: CliStreams;
  env: CliEnvironment;
}): Promise<number> => runCli(program, options);
