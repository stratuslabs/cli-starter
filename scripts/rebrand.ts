/**
 * Make this template yours.
 *
 *   npm run rebrand
 *
 * Asks a handful of questions and rewrites the few files that carry the
 * template's identity. It deliberately touches as little as possible: the
 * whole design keeps branding in `src/app.ts` and the manifest, so this script
 * stays small enough to read before you run it.
 *
 * It uses the CLI's own prompts, which means running it is also the fastest
 * way to see what the menus feel like.
 *
 * Everything it does is reversible with `git checkout .` — run it on a clean
 * tree and read the diff.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { renderWord } from './banner-font.ts';
import { createInteractivePrompter, createPlainPrompter, type Prompter } from '../src/core/prompt.ts';
import { createTheme } from '../src/core/theme.ts';
import { detectColorLevel, detectUnicode } from '../src/core/env.ts';
import {
  PLACEHOLDER,
  PLACEHOLDER_ENV,
  PLACEHOLDER_HOME,
  PLACEHOLDER_WORD,
  REBRANDED_DOCS,
} from './placeholder.ts';

const root = dirname(import.meta.dirname);

const theme = createTheme({
  colorLevel: detectColorLevel(process.env, {
    stdoutIsTty: process.stdout.isTTY === true,
    stdinIsTty: process.stdin.isTTY === true,
    columns: process.stdout.columns ?? 80,
  }),
  unicode: detectUnicode(process.env, process.platform),
  columns: process.stdout.columns ?? 80,
});

const out = { write: (chunk: string) => process.stdout.write(chunk) };

const prompter: Prompter =
  process.stdin.isTTY === true
    ? createInteractivePrompter({ stdin: process.stdin, output: out, theme })
    : createPlainPrompter({ input: process.stdin, output: out, theme });

const say = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const edit = async (relative: string, change: (text: string) => string): Promise<void> => {
  const path = join(root, relative);
  const before = await readFile(path, 'utf8');
  const after = change(before);
  if (after !== before) await writeFile(path, after, 'utf8');
};

/** Escape for use inside a single-quoted TypeScript string literal. */
const literal = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * The `art:` block for `src/app.ts`, drawn from the new binary name.
 *
 * Returns an empty string — removing the field — when the name contains a
 * character the block font has no glyph for. The banner is then simply off,
 * which `shouldShowBanner` already handles, rather than shipping a logo with a
 * hole in it. Either way the comment above it tells the reader what to do.
 */
const artBlock = (binary: string): string => {
  const rows = renderWord(binary);
  if (rows === undefined) return '';
  return `\n  art: [\n${rows.map((row) => `    '${literal(row)}',`).join('\n')}\n  ],`;
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

try {
  say(theme.bold('Rebranding this template'));
  say(theme.muted('Run it on a clean git tree so you can read the diff afterwards.'));
  say();

  const name = await prompter.text({
    message: 'Binary name (what people type):',
    initial: PLACEHOLDER,
    validate: (value) =>
      /^[a-z][a-z0-9-]*$/.test(value.trim())
        ? undefined
        : 'Lower-case letters, digits and dashes; must start with a letter.',
  });
  const binary = name.trim();

  const packageName = await prompter.text({
    message: 'npm package name:',
    initial: `@your-org/${binary}`,
  });

  const summary = await prompter.text({
    message: 'One-line summary (shown at the top of --help):',
    initial: 'A polished CLI.',
  });

  const displayName = await prompter.text({
    message: 'Service name (shown in "Signed in to …"):',
    initial: 'Example',
  });

  const baseUrl = await prompter.text({
    message: 'API base URL:',
    initial: 'https://api.example.com',
    validate: (value) => {
      try {
        new URL(value);
        return undefined;
      } catch {
        return 'That is not a URL.';
      }
    },
  });

  const clientId = await prompter.text({
    message: 'OAuth client id for this CLI (public, not a secret):',
    initial: `${binary}-cli`,
  });

  const dropExamples = await prompter.confirm({
    message: 'Delete the example commands (demo, notes) and their tests?',
    initial: true,
  });

  // The brand slug drives `~/.<brand>/` and `<brand>.config.json`; the env
  // prefix drives KIT_TOKEN and friends. Both are derived so they cannot
  // disagree with the binary name.
  const brand = slug(binary);
  const envPrefix = brand.toUpperCase().replace(/-/g, '_');

  say();
  say(theme.muted('Writing…'));

  await edit('src/app.ts', (text) =>
    text
      .replace(/const DEFAULT_BASE_URL = '[^']*';/, `const DEFAULT_BASE_URL = '${literal(baseUrl)}';`)
      .replace(/(\n  name: )'[^']*',/, `$1'${literal(binary)}',`)
      .replace(/(\n  brand: )'[^']*',/, `$1'${literal(brand)}',`)
      .replace(/(\n  summary: )'[^']*',/, `$1'${literal(summary)}',`)
      .replace(/(\n  envPrefix: )'[^']*',/, `$1'${literal(envPrefix)}',`)
      .replace(/(\n    displayName: )'[^']*',/, `$1'${literal(displayName)}',`)
      .replace(/(\n    clientId: )'[^']*',/, `$1'${literal(clientId)}',`)
      // The footer credits the template; an adopted CLI should not carry it.
      .replace(/\n  footer: '[^']*',/, '')
      // A function replacement, so a `$` in the art is never read as a
      // capture-group reference.
      .replace(/\n  art: \[[\s\S]*?\n  \],/, () => artBlock(binary)),
  );

  await edit('package.json', (text) => {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    manifest['name'] = packageName.trim();
    manifest['description'] = summary;
    manifest['bin'] = { [binary]: './dist/bin.js' };
    const scripts = manifest['scripts'] as Record<string, string>;
    // The convenience script is named after the binary, so the README's
    // `npm run <name> -- login` keeps working.
    delete scripts[PLACEHOLDER];
    scripts[binary] = 'node --experimental-strip-types src/bin.ts';
    manifest['scripts'] = scripts;
    return `${JSON.stringify(manifest, null, 2)}\n`;
  });

  // Documentation is written against the placeholder; rewrite the invocations
  // so the README does not tell a new user to run a binary that does not exist.
  if (binary !== PLACEHOLDER) {
    for (const file of REBRANDED_DOCS) {
      await edit(file, (text) =>
        text
          .replace(PLACEHOLDER_WORD, binary)
          .replace(PLACEHOLDER_HOME, `~/.${brand}/`)
          .replace(PLACEHOLDER_ENV, `${envPrefix}_`),
      );
    }
  }

  if (dropExamples) {
    for (const file of [
      'src/commands/demo.ts',
      'test/demo.test.ts',
      'src/commands/notes.ts',
      'test/notes.test.ts',
    ]) {
      await rm(join(root, file), { force: true });
    }
    await edit('src/main.ts', (text) =>
      text
        .replace(/import \{ demoCommand \} from '\.\/commands\/demo\.ts';\n/, '')
        .replace(/import \{ notesCommand \} from '\.\/commands\/notes\.ts';\n/, '')
        .replace(/\n\s*\/\/ notesCommand is the worked example[^\n]*\n/, '\n')
        .replace(/notesCommand,\s*/, '')
        .replace(/,\s*demoCommand/, ''),
    );
    // The notes endpoints in the mock server exist only for that example.
    await edit('test/support/mock-auth-server.ts', (text) =>
      text
        .replace(
          /\n    \/\* ---- notes[\s\S]*?\n    \}\n(?=\n    \/\* ---- revoke)/,
          '\n',
        )
        .replace(/\n\/\*\*\n \* Fictitious data for the worked example[\s\S]*?\n\];\n/, '\n'),
    );
  }

  say();
  say(theme.ok(`This is now ${theme.accent(binary)}.`));
  say();
  say(theme.bold('Next:'));
  say(`  1. ${theme.muted('Read the diff:')} ${theme.command('git diff')}`);
  say(`  2. ${theme.muted('Check it still builds:')} ${theme.command('npm run build && npm test')}`);
  say(`  3. ${theme.muted('Build your auth endpoints:')} ${theme.command('docs/auth-server.md')}`);
  say(`  4. ${theme.muted('Add your first command:')} ${theme.command('docs/adding-a-command.md')}`);
  say();
  say(theme.muted('Until the server exists, `npm run mock-server` keeps login working.'));
} finally {
  prompter.close();
}
