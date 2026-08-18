/**
 * `kit demo` — a live tour of the UI primitives.
 *
 * This exists to be *deleted*. It is here so that five seconds after cloning
 * the template you can see the menus, the table, the spinner, and the error
 * rendering on your own terminal, and so that each primitive has one worked
 * example to copy. `scripts/rebrand.ts` offers to remove it.
 *
 * It also demonstrates the two rules a real command must follow:
 * data goes to `ctx.out`, chrome goes to `ctx.say`, and every command that
 * prints anything also supports `--json`.
 */

import { defineCommand } from '../kit/command.ts';
import { createSpinnerFactory } from '../kit/spinner.ts';
import { box, plural, table } from '../kit/render.ts';

interface DemoRow {
  id: string;
  title: string;
  status: 'draft' | 'scheduled' | 'published';
  views: number;
}

const ROWS: DemoRow[] = [
  { id: 'p_8f21', title: 'Dark mode is here', status: 'published', views: 12480 },
  { id: 'p_7c02', title: 'Faster search', status: 'published', views: 9310 },
  { id: 'p_6b55', title: 'Scheduled digests', status: 'scheduled', views: 0 },
  { id: 'p_5a19', title: 'Draft: pricing update', status: 'draft', views: 0 },
];

const outputCommand = defineCommand({
  name: 'output',
  summary: 'show the table, status glyphs, and JSON output',
  description:
    'The same data rendered two ways. Compare `demo output` with ' +
    '`demo output --json | jq` — the human version goes to stdout as text, the ' +
    'JSON version is the only thing on stdout when --json is set.',

  run(ctx) {
    ctx.emit({ ok: true, posts: ROWS });
    if (ctx.globals.json) return;

    const statusGlyph = (status: DemoRow['status']): string => {
      if (status === 'published') return ctx.theme.success(ctx.theme.glyph.tick);
      if (status === 'scheduled') return ctx.theme.warning(ctx.theme.glyph.bullet);
      return ctx.theme.muted(ctx.theme.glyph.dot);
    };

    for (const line of table(
      [{ header: '' }, { header: 'ID' }, { header: 'TITLE' }, { header: 'VIEWS', align: 'right' }],
      ROWS.map((row) => [
        statusGlyph(row.status),
        ctx.theme.muted(row.id),
        row.title,
        row.views === 0 ? ctx.theme.muted('—') : row.views.toLocaleString('en-US'),
      ]),
      ctx.theme,
    )) {
      ctx.out(line);
    }

    ctx.say('');
    ctx.say(ctx.theme.muted(plural(ROWS.length, 'post')));
  },
});

const promptsCommand = defineCommand({
  name: 'prompts',
  summary: 'try the interactive menus',
  description:
    'Walks through a select, a confirm, and a text prompt. Run it with piped ' +
    'stdin (`printf "2\\ny\\nAda\\n" | kit demo prompts`) to see the same flow ' +
    'render as numbered lists for scripts.',

  async run(ctx) {
    const choice = await ctx.prompt.select<string>({
      message: 'Pick a colour',
      footnote: ctx.prompt.isInteractive() ? '↑/↓ to move, Enter to pick, Esc to go back' : undefined,
      options: [
        { value: 'red', label: 'Red', hint: 'warm' },
        { value: 'green', label: 'Green', hint: 'calm' },
        { value: 'blue', label: 'Blue', hint: 'cool' },
        { value: 'ultraviolet', label: 'Ultraviolet', hint: 'not available', disabled: true },
      ],
      allowBack: true,
    });

    if (choice.kind === 'back') {
      ctx.say(ctx.theme.muted('Cancelled.'));
      return;
    }

    const colour = choice.kind === 'value' ? choice.value : choice.text;
    const confirmed = await ctx.prompt.confirm({ message: `Use ${colour}?`, initial: true });
    if (!confirmed) {
      ctx.say(ctx.theme.muted('Nothing changed.'));
      return;
    }

    const name = await ctx.prompt.text({
      message: 'Name this theme',
      initial: `${colour}-theme`,
      validate: (value) => (value.trim().length < 3 ? 'Use at least three characters.' : undefined),
    });

    ctx.say(ctx.theme.ok(`Saved ${ctx.theme.accent(name)}.`));
    ctx.emit({ ok: true, colour, name });
  },
});

const progressCommand = defineCommand({
  name: 'progress',
  summary: 'show the spinner and its non-TTY fallback',
  description:
    'Run this normally to see an animated spinner; pipe it to a file to see the ' +
    'same steps render as plain lines, which is what CI logs get.',

  async run(ctx) {
    const spinner = createSpinnerFactory({
      output: ctx.streams.stderr,
      theme: ctx.theme,
      animate: ctx.env.tty.stdoutIsTty && ctx.theme.colorLevel !== 'none',
      silent: ctx.globals.quiet || ctx.globals.json,
    });

    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      });

    const task = spinner('Connecting');
    await wait(400);
    task.update('Fetching posts');
    await wait(400);
    task.succeed(`Fetched ${plural(ROWS.length, 'post')}`);

    const second = spinner('Uploading cover image');
    await wait(300);
    second.warn('Uploaded, but the image was resized');

    ctx.emit({ ok: true });
  },
});

const errorCommand = defineCommand({
  name: 'error',
  summary: 'show how a failure is rendered',
  description: 'Raises a deliberate error so you can see the message, the hint, and the exit code.',
  flags: {
    kind: {
      type: 'string',
      placeholder: '<kind>',
      summary: 'which failure to raise',
      choices: ['auth', 'network', 'usage'],
      default: 'auth',
    },
  },

  async run(ctx) {
    const { AuthError, NetworkError, UsageError } = await import('../kit/errors.ts');
    const kind = ctx.flags.string('kind');

    if (kind === 'network') {
      throw new NetworkError('demo.network', 'Could not reach api.example.com.', {
        hint: 'Check your connection, then try again.',
      });
    }
    if (kind === 'usage') {
      throw new UsageError('Missing required flag --title.', {
        hint: 'See `kit demo error --help`.',
      });
    }
    throw new AuthError('demo.auth', 'Your saved sign-in has expired.', {
      hint: 'Run `kit login` to sign in again.',
    });
  },
});

export const demoCommand = defineCommand({
  name: 'demo',
  summary: 'a tour of the interface primitives (delete this before you ship)',
  description:
    'Examples of every UI primitive the template provides. Delete src/commands/demo.ts ' +
    'once you have your own commands — nothing else depends on it.',
  // No `defaultSubcommand` here on purpose: a group can have a default
  // subcommand or its own `run`, not both — the default would shadow the run
  // handler and nothing would ever reach it.
  subcommands: [outputCommand, promptsCommand, progressCommand, errorCommand],

  run(ctx) {
    for (const line of box(
      ['Try:', '  kit demo prompts', '  kit demo output --json', '  kit demo progress'],
      ctx.theme,
      { title: 'demo' },
    )) {
      ctx.say(line);
    }
  },
});
