# cli-kit

A template for building command-line tools that feel finished.

Click **Use this template**, run one script, and you have a CLI with browser
sign-in, arrow-key menus, machine-readable output, and help that cannot drift
out of date — before you have written a single line of your own.

```
$ kit login
Opening your browser to sign in to Example…
✓ Signed in as Ada Lovelace (Analytical Engines).
  Token saved to ~/.kit/credentials.json (0600).

$ kit demo output --json | jq '.posts[0].id'
"p_8f21"
```

## Why this exists

Most CLIs are written twice: once to make them work, and again — usually never
— to make them pleasant. The second pass is where colour handling, `--json`,
exit codes, a real login, and prompts that survive SSH all live, and it is
always the pass that gets cut.

This is that second pass, done once, tested, and ready to copy.

## Start

Requires Node `>=22.13 <23 || >=23.4`.

```bash
npm install
npm run mock-server     # terminal 1 — a stand-in auth server
npm run kit -- login    # terminal 2 — the real flow, end to end
npm run kit -- demo prompts
```

Then make it yours:

```bash
npm run rebrand
```

It asks for a binary name, a summary, and your API endpoint, then rewrites the
few files that carry the template's identity. Run it on a clean tree and read
the diff — it is a short script, and everything it does is reversible.

## What you get

**Sign-in that is not a pasted API key.** `login` opens a browser and completes
a loopback redirect with PKCE. On a machine with no browser — SSH, a container —
it detects that and shows a device code instead. `--token -` reads a token from
stdin as the last resort, so a credential never lands in argv where `ps` and
your shell history can see it. Tokens are stored 0600, scoped to named
profiles, and bound to the endpoint that issued them.

**Help that cannot go stale.** Commands and flags are declared once; parsing,
dispatch, and every help screen are derived from that declaration. A test walks
the registry and fails if anything is undocumented. There is no separate help
string to forget to update.

**Output a script can use.** `--json` puts structured data on stdout and
nothing else — prompts, spinners, and warnings all go to stderr. `cli list
--json | jq` works, always.

**Errors that say what to do.** Every failure carries a `hint`, and each kind
gets its own exit code (`2` usage, `3` config, `4` auth, `5` network, …), so a
script can tell "sign in again" from "check your wifi".

**Terminal handling that is actually correct.** Colour is gated on stdout —
not stdin — and honours `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, and CI. Glyphs
fall back to ASCII outside a UTF-8 locale. Tables read the real terminal width.
Spinners animate on a TTY and print one line in a log. The cursor is always
restored, including on Ctrl-C.

**Prompts that survive real terminals.** Arrow keys in both encodings, `j`/`k`,
digit shortcuts, type-ahead across prompts, pasted input, and escape sequences
split across packets by SSH. Piped input drives the same flows as numbered
lists, so scripts and tests take the same path a human does. When there is
nobody to ask, a prompt fails immediately and names the flag that would have
answered it, instead of hanging a CI job.

## Layout

```
src/
  app.ts          ← the only file that knows your brand. Edit this first.
  main.ts         ← the command registry. Add your commands here.
  bin.ts          ← the executable. Almost nothing in it.
  commands/       ← yours. notes.ts is the worked example; replace these.
  kit/            ← the framework. You should not need to edit this.
test/
  support/        ← the harness and a runnable mock auth server
scripts/
  rebrand.ts      ← the one-time setup
  mock-server.ts  ← keeps `login` working before your backend exists
docs/
```

The `src/kit/` and `src/commands/` split is the important one. `kit/` is
upstream's; `commands/` is yours. Keeping the line clean is what lets you pull
later improvements in — see [docs/upstream.md](docs/upstream.md).

## Adding a command

```ts
export const listCommand = defineCommand({
  name: 'list',
  summary: 'list your posts',
  flags: {
    status: {
      type: 'string',
      summary: 'show only posts with this status',
      choices: ['draft', 'published'],
    },
  },
  examples: [{ cmd: 'list --status draft --json', note: 'draft ids, for a script' }],

  async run(ctx) {
    const session = await openSession(ctx, { require: true });
    const posts = await session.http.get('/api/v1/posts', {
      query: { status: ctx.flags.string('status') },
    });

    ctx.emit({ ok: true, posts });          // --json
    if (ctx.globals.json) return;

    for (const line of table(columns, rows, ctx.theme)) ctx.out(line);
    ctx.say(theme.muted(plural(posts.length, 'post')));
  },
});
```

Register it in `src/main.ts`. Help, `--json`, `--quiet`, colour, and error
handling come with it.

`src/commands/notes.ts` is that command, written out in full and runnable
against the mock server, with its tests in `test/notes.test.ts`. Copy it. The
walkthrough is in [docs/adding-a-command.md](docs/adding-a-command.md).

## The server side

The login flows need a handful of endpoints. They are ordinary OAuth-shaped
routes and do **not** require a full OAuth server — if you already have API
tokens, you are most of the way there.
[docs/auth-server.md](docs/auth-server.md) specifies exactly what to build, and
`test/support/mock-auth-server.ts` is a working reference implementation you can
read in one sitting.

## Development

```bash
npm run build      # tsc
npm run typecheck  # includes the tests
npm test           # node --test, in-process, no network
```

Tests drive the real `main()` with fake streams and a temp home directory —
nothing is spawned, nothing touches the network, and nothing leaks between
cases. That includes the interactive prompts: the key decoder is a pure
function, so pasted input and SSH-split escape sequences are ordinary unit
tests.

## Documentation

- [docs/adding-a-command.md](docs/adding-a-command.md) — the walkthrough
- [docs/auth-server.md](docs/auth-server.md) — what to build server-side
- [docs/exit-codes.md](docs/exit-codes.md) — the exit-code contract
- [docs/upstream.md](docs/upstream.md) — pulling in later improvements

## Licence

MIT.
