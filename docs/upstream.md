# Pulling in later improvements

This is a **template repository**, not a dependency. When you clicked "Use this
template" you got a copy, and copies do not receive updates. That is the trade:
you can change anything, and nothing changes underneath you.

It also means a bug fixed upstream stays broken in your copy until you go and
get it. The layout is arranged to make that a small job rather than an
archaeology project.

## The line

```
src/kit/        upstream's.  Do not edit.
src/commands/   yours.       Upstream will never touch these.
src/app.ts      yours.       Written once by `npm run rebrand`.
src/main.ts     yours.       A registry; upstream only adds to the global flags.
```

Keeping `src/kit/` pristine is the whole mechanism. If you edit it, you own the
merge conflict forever. When you need behaviour it does not offer, add a
parameter and send the change upstream — that is the same rule the framework
applies to itself.

## Getting a newer kit

Once, to set up the remote:

```bash
git remote add upstream https://github.com/stratuslabs/cli-starter.git
git fetch upstream
```

Then, whenever you want the newer framework:

```bash
git fetch upstream
git checkout -b kit-update
git checkout upstream/main -- src/kit test/kit test/support
npm run build && npm run typecheck && npm test
```

Your commands, your branding, and your tests are untouched; only the framework
moves. Review the diff, run the suite, merge.

If `test/kit` fails after an update, read the failure before "fixing" it —
upstream tests encode invariants (credential permissions, colour gating,
endpoint binding) that are usually right.

## What can break

- **New global flags.** Upstream may add one; if you declared a command flag
  with the same name, yours wins, which may not be what you want. `npm test`
  catches the collision through the help-coverage tests.
- **`RunContext` gains a field.** Additive, so existing commands compile
  unchanged.
- **A `kit/` module is renamed.** Rare, and called out in the release notes.
  Your `src/commands/` imports are the only thing to update.

## If you would rather not track upstream

That is a perfectly good answer. Delete this file, drop the remote, and treat
the code as yours — it is dependency-free, and every module is small enough to
own outright. That is the other half of the trade a template makes.
