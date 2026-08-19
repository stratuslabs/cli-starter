/**
 * `acme completions <shell>` — print a completion script.
 *
 * Writes to stdout so it can be redirected into the shell's completion
 * directory or `eval`'d straight from a startup file. Nothing else goes to
 * stdout: a stray progress line here ends up inside somebody's `.zshrc` as a
 * syntax error they have to bisect a shell startup to find.
 */

import { defineCommand } from '../core/command.ts';
import { completionsFor, SHELLS, type Shell } from '../core/completions.ts';
import { UsageError } from '../core/errors.ts';

export const completionsCommand = defineCommand({
  name: 'completions',
  summary: 'print a shell completion script',
  description:
    'Generates completions from the command registry, so they list exactly the ' +
    'commands and flags this build has. Redirect the output to your shell’s ' +
    'completion directory, or eval it from a startup file to regenerate on every ' +
    'new shell.',
  args: [{ name: 'shell', summary: `one of: ${SHELLS.join(', ')}`, required: true }],
  examples: [
    { cmd: 'completions zsh > "${fpath[1]}/_acme"', note: 'install for zsh' },
    { cmd: 'completions fish > ~/.config/fish/completions/acme.fish', note: 'install for fish' },
    { cmd: 'completions bash', note: 'print it, to eval from ~/.bashrc' },
  ],

  run(ctx) {
    const [shell] = ctx.args;

    if (shell === undefined || !SHELLS.includes(shell as Shell)) {
      throw new UsageError(
        shell === undefined ? 'Which shell?' : `Unknown shell ${JSON.stringify(shell)}.`,
        { hint: `Supported: ${SHELLS.join(', ')}.` },
      );
    }

    // ctx.out, not ctx.say — this *is* the data, and it is being piped to a file
    // far more often than it is being read.
    ctx.out(completionsFor(ctx.program, shell as Shell));
  },
});
