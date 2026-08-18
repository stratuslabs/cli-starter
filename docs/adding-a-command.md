# Adding a command

Two steps: declare it, register it. Everything else — help, `--json`,
`--quiet`, colour, exit codes, error rendering — comes with it.

**There is a working one to copy.** `src/commands/notes.ts` is a real command
that authenticates, calls an API, and renders a table or JSON, with tests in
`test/notes.test.ts`. It runs today against the mock server:

```bash
npm run mock-server            # terminal 1
npm run kit -- login           # terminal 2
npm run kit -- notes
npm run kit -- notes --status draft --json | jq -r '.notes[].id'
```

The data is invented, and deliberately not borrowed from a public API — an
example that depends on someone else's endpoint rots the first time they change
it, and it would put a network call in a test suite that otherwise has none.
Copy the file, rename it, and delete the original (or let `npm run rebrand`
remove it).

The rest of this page is the same thing, explained.

## 1. Declare it

`src/commands/posts.ts`:

```ts
import { defineCommand } from '../kit/command.ts';
import { table, plural } from '../kit/render.ts';
import { openSession } from './session.ts';

export const postsCommand = defineCommand({
  name: 'posts',
  aliases: ['p'],
  summary: 'list your posts',          // one line, no full stop
  description:
    'Lists the posts on your changelog, newest first. Use --json to get ' +
    'ids for a script.',

  args: [{ name: 'id', summary: 'show one post instead of the list' }],

  flags: {
    status: {
      type: 'string',
      summary: 'show only posts with this status',
      choices: ['draft', 'scheduled', 'published'],
    },
    limit: { type: 'string', placeholder: '<n>', summary: 'how many to show', default: '20' },
  },

  examples: [
    { cmd: 'posts --status draft', note: 'what is not published yet' },
    { cmd: 'posts --json | jq -r ".posts[].id"', note: 'ids, for a script' },
  ],

  async run(ctx) {
    const session = await openSession(ctx, { require: true });
    const { posts } = await session.http.get<{ posts: Post[] }>('/api/v1/posts', {
      query: { status: ctx.flags.string('status'), limit: ctx.flags.string('limit') },
    });

    ctx.emit({ ok: true, posts });
    if (ctx.globals.json) return;

    if (posts.length === 0) {
      ctx.say(ctx.theme.muted('No posts yet.'));
      return;
    }

    for (const line of table(
      [{ header: 'ID' }, { header: 'TITLE' }],
      posts.map((post) => [ctx.theme.muted(post.id), post.title]),
      ctx.theme,
    )) {
      ctx.out(line);
    }
    ctx.say(ctx.theme.muted(plural(posts.length, 'post')));
  },
});
```

## 2. Register it

In `src/main.ts`, import it and add it to `commands`. That array is the whole
registry — help, dispatch, and completions all read from it.

That is why there is no separate help text to update: a command that is
registered is documented, and `test/kit/help.test.ts` fails the build if a flag
or argument has no summary.

## The rules

**`ctx.out` is data. `ctx.say` is chrome.**

```ts
ctx.out(line);   // stdout — the thing a script parses
ctx.say(line);   // stderr — progress, counts, confirmations. Silenced by --quiet.
```

Getting this backwards is what makes a CLI unpipeable. If in doubt: could
someone reasonably pipe this into `jq` or `grep`? Then it is `out`.

**Always call `ctx.emit` once**, with the structured result. Under `--json` it
is serialized to stdout; otherwise it is dropped. A command without it silently
produces nothing useful under `--json`.

**Throw, do not exit.** `process.exit` skips spinner teardown and leaves the
terminal in raw mode with a hidden cursor.

```ts
import { NotFoundError } from '../kit/errors.ts';

throw new NotFoundError('post.not_found', `No post with id ${id}.`, {
  hint: `Run \`${ctx.program.name} posts\` to see the ids you have.`,
});
```

The `hint` is the part people actually use — make it a command they can paste.

**Never reach around the injected environment.** No `process.env`, no
`node:fs` on the home directory, no bare `fetch`. Everything is on `ctx`:
`ctx.env.processEnv`, `ctx.env.homeDir`, `session.http`. This is what makes the
command testable in-process, and it is the difference between a five-line test
and a fixture directory.

## Subcommand groups

```ts
export const categoriesCommand = defineCommand({
  name: 'categories',
  summary: 'manage categories',
  defaultSubcommand: 'list',        // `cli categories` still works
  subcommands: [listCommand, createCommand],
});
```

A group has *either* a `defaultSubcommand` *or* its own `run`, never both — the
default would shadow the handler. There is a test for that.

## Prompting

```ts
const choice = await ctx.prompt.select({
  message: 'Which category?',
  options: categories.map((c) => ({ value: c.id, label: c.name, hint: c.colour })),
  allowBack: true,
});
if (choice.kind === 'back') return;
```

Arrow keys on a terminal, a numbered list when piped, and an immediate failure
naming the missing flag when there is nobody to ask. You do not choose between
them.

Every prompt should have a flag that answers it, so the command is scriptable:

```ts
const id = ctx.flags.string('category-id') ?? (await pickCategory(ctx));
```

## Long operations

```ts
const spinner = createSpinnerFactory({
  output: ctx.streams.stderr,
  theme: ctx.theme,
  animate: ctx.env.tty.stdoutIsTty,
  silent: ctx.globals.quiet || ctx.globals.json,
});

const task = spinner('Uploading cover image');
try {
  await upload();
  task.succeed('Cover image uploaded');
} catch (error) {
  task.fail('Upload failed');
  throw error;
}
```

Always stop the spinner on both paths, or the error prints over a spinning
frame.

## Testing it

```ts
test('posts lists what the API returns', async () => {
  const result = await run({
    argv: ['posts', '--json'],
    processEnv: { KIT_TOKEN: 'tok_test', KIT_BASE_URL: 'https://api.example.test' },
    fetch: async () => new Response(JSON.stringify({ posts: [{ id: 'p_1', title: 'Hi' }] })),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.output.stdout).posts.length, 1);
});
```

No subprocess, no network, no temp directory to clean up. Add a test that fails
without your change — verify that it does, because a test that passes both ways
is worse than none: it reads as covered.

## Before you call it done

- [ ] every flag and argument has a `summary`
- [ ] at least one `example`
- [ ] `ctx.emit` is called exactly once
- [ ] data on `ctx.out`, chrome on `ctx.say`
- [ ] failures throw a `CliError` subclass with a `hint`
- [ ] any prompt has a flag that answers it
- [ ] `npm run build && npm run typecheck && npm test`
