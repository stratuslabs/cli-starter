# cli-starter

A template for building command-line tools that feel finished.

[![CI](https://github.com/stratuslabs/cli-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/stratuslabs/cli-starter/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-3c873a)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-blue)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Early days.** This is in use — [`@updatespage/cli`](https://github.com/stratuslabs/updates-page-cli)
> is built on it — but it is new, the API under `src/core/` may still move, and
> it has not been through many hands yet. Expect rough edges, and please report
> them; see [Contributing](#contributing).

Click **Use this template**, run one script, and you have a CLI with browser
sign-in, arrow-key menus, machine-readable output, and help that cannot drift
out of date — before you have written a single line of your own.

<!-- Render with `vhs docs/demo.tape`, then uncomment. See docs/demo.tape. -->
<!-- ![A terminal recording: the arrow-key menu, a table, --json, and an error with a hint](docs/demo.gif) -->

## Try it in thirty seconds

No account, no backend, nothing to configure:

```bash
git clone https://github.com/stratuslabs/cli-starter && cd cli-starter
npm install
npm run acme -- demo prompts     # arrow keys, filtering, secret input
npm run acme -- demo output      # tables, glyphs, --json
npm run acme -- --help           # help, derived from the registry
```

Then the part that needs a server — a stand-in is included:

```bash
npm run mock-server              # terminal 1
npm run acme -- login            # terminal 2 — the real browser flow, end to end
```

## Why this exists

Most CLIs are written twice: once to make them work, and again — usually never
— to make them pleasant. The second pass is where colour handling, `--json`,
exit codes, a real login, and prompts that survive SSH all live, and it is
always the pass that gets cut.

This is that second pass, done once, tested, and ready to copy.

## Make it yours

Click **Use this template**, then:

```bash
npm run rebrand
```

It asks for a binary name, a summary, and your API endpoint, then rewrites the
few files that carry the template's identity — redrawing the welcome banner from
your name, and deleting the example commands if you want. Run it on a clean tree and read the diff: it is a short script, and
everything it does is reversible.

Requires Node `>=22.13 <23 || >=23.4`. The gap is deliberate, not a typo —
23.0–23.3 are newer than the 22.13 floor and still lack what it provides.

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
nothing else — prompts, spinners, and warnings all go to stderr.
`acme list --json | jq` works, always.

**Tab completion that cannot go stale.** `acme completions zsh` (or `bash`,
`fish`) generates a script from the same registry help reads, so a command you
add is completable without touching a second file. Most CLIs ship a hand-written
completion script that is accurate the day it lands and wrong two releases
later. Flag values declared with `choices` complete too.

```bash
acme completions zsh > "${fpath[1]}/_acme"           # install
eval "$(acme completions zsh)"                       # or regenerate per shell
```

**A welcome screen, gated properly.** Typing the bare binary name shows a
neofetch-style banner above the help. It appears there and nowhere else: never
on a command that does work, never under `--json` or `--quiet`, never in a pipe,
never in CI. `rebrand` redraws the art from your name, and deleting `art` from
`src/app.ts` turns it off.

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

## How it compares

**`commander`, `yargs`, `cac`, `citty`** are argument parsers, and good ones.
They stop where this starts: no sign-in, no credential store, no colour
detection, no prompt kit, no exit-code taxonomy. You would assemble those
yourself, which is exactly the second pass that never happens.

**`oclif`** is the closest thing, and the honest comparison. It is a real
framework with plugins, generators, and auto-generated docs, maintained by
people whose job that is. If you want a plugin ecosystem, or you want somebody
else to own the maintenance, use oclif — it is the better answer to that
question.

This is the other trade. It is a **copy you own outright**, not a dependency
you upgrade: no framework conventions to learn, no plugin surface most CLIs
never use, nothing that can change underneath you, and every line is yours to
read and delete. The cost is that fixes made here do not reach you
automatically — [docs/upstream.md](docs/upstream.md) is about making that a
small job rather than an archaeology project.

Zero runtime dependencies, and that is not a boast about bundle size. It means
nothing in your supply chain that you did not put there, on a tool that holds
credentials.

## What it does not do

Setting this out so you can rule it out quickly:

- **No self-update.** Adopters distribute via npm, Homebrew, or binaries; a
  self-updater would be wrong for most of them.
- **No release workflow yet.** CI builds and tests. Getting it published is
  still yours to wire up — the biggest known gap.
- **No plugin system.** Commands are files you import. That is the whole model.
- **No completion of server-side values.** Commands, flags and `choices`
  complete; post ids and project names do not — that needs a cache and a story
  for being offline.
- **Node only.** If you want a single static binary, this is the wrong starting
  point; look at Go or Rust.

## Layout

```
src/
  app.ts          ← the only file that knows your brand. Edit this first.
  main.ts         ← the command registry. Add your commands here.
  bin.ts          ← the executable. Almost nothing in it.
  commands/       ← yours. notes.ts is the worked example; replace these.
  core/           ← the framework. You should not need to edit this.
test/
  support/        ← the harness and a runnable mock auth server
scripts/
  rebrand.ts      ← the one-time setup
  banner-font.ts  ← draws the welcome banner during rebrand
  mock-server.ts  ← keeps `login` working before your backend exists
docs/
```

The `src/core/` and `src/commands/` split is the important one. `core/` is
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
vhs docs/demo.tape # re-record the README's terminal demo (needs charmbracelet/vhs)
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

## Contributing

Issues and pull requests are welcome. It is early enough that feedback changes
the design rather than just the code, so the useful things to send are:

- **"I used this and hit X."** The most valuable report there is. A template is
  only as good as the first hour someone spends with it, and that hour is the
  part we cannot see.
- **A terminal that behaves differently.** Colour, Unicode and key handling are
  detected, not assumed, and detection is where this kind of code goes wrong.
  If your terminal, shell, CI runner or SSH setup renders something badly, say
  which one — that is a bug with a fix, not a quirk.
- **A flow the auth module does not cover.** It does authorization-code + PKCE,
  device code, and a pasted token. If your provider needs something else,
  open an issue describing the flow before writing code, so the seam it needs
  gets designed rather than bolted on.
- **Requests for what to build next.** Self-update, a release workflow, and
  request tracing are the obvious gaps. If one of those is what is stopping you
  adopting this, that is worth knowing and moves it up.

If you are sending code, two conventions that are load-bearing rather than
stylistic:

- **New behaviour needs a test that fails without it**, and verifying it
  actually fails is part of writing it. A test that passes both ways is worse
  than none, because it reads as covered.
- **`src/core/` is the part adopters do not edit**, so changes there are pulled
  downstream into every CLI built from this. Keep the boundary: framework in
  `src/core/`, your own commands in `src/commands/`.

`npm run build && npm run typecheck && npm test` is what CI runs.

## Licence

MIT.
