/**
 * `kit login` — sign in.
 *
 * Three flows, tried in the order that asks least of the user:
 *
 *   1. **browser** — a loopback redirect with PKCE. Nothing to copy, nothing to
 *      paste, and the token never touches the shell.
 *   2. **device code** — a short code typed into a browser anywhere. Chosen
 *      automatically over SSH or without a display, and forced by `--device`.
 *   3. **token paste** — the floor, for sealed containers. `--token -` reads
 *      stdin so the value never appears in argv, where `ps` and shell history
 *      can see it. That is how our other CLI takes its key today, and it is the
 *      main thing this command exists to replace.
 */

import { APP, resolveAuthProvider, resolveBaseUrl, tokenEnvName } from '../app.ts';
import { canOpenBrowser, deviceLogin } from '../kit/auth/device.ts';
import { loopbackLogin } from '../kit/auth/loopback.ts';
import type { AuthResult } from '../kit/auth/provider.ts';
import { defineCommand } from '../kit/command.ts';
import type { RunContext } from '../kit/context.ts';
import { saveCredential, type StoredCredential } from '../kit/credentials.ts';
import { AuthError, CliError, InterruptedError, isInterruption } from '../kit/errors.ts';
import { HttpClient } from '../kit/http.ts';
import { box } from '../kit/render.ts';
import { describeIdentity, fetchIdentity, openSession, profileName, type Identity } from './session.ts';

/** Read the whole of stdin, for `--token -`. */
const readStdin = async (ctx: RunContext): Promise<string> => {
  const stdin = ctx.env.stdin;
  if (stdin === undefined) {
    throw new CliError('stdin.unavailable', 'No stdin to read a token from.');
  }
  const chunks: string[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
  }
  return chunks.join('').trim();
};

const tokenFlow = async (ctx: RunContext): Promise<AuthResult> => {
  const flagValue = ctx.flags.string('token');

  if (flagValue === '-') return { token: await readStdin(ctx) };
  if (flagValue !== undefined && flagValue !== '') {
    ctx.say(
      ctx.theme.warn(
        'A token passed on the command line is visible to other processes and saved in your shell history.',
      ),
    );
    ctx.say(ctx.theme.muted(`  Prefer: ${APP.name} login --token -   (reads it from stdin)`));
    return { token: flagValue };
  }

  const value = await ctx.prompt.secret({
    message: `Paste your ${APP.auth.displayName} token:`,
    validate: (input) => (input.trim() === '' ? 'A token is required.' : undefined),
  });
  return { token: value.trim() };
};

const browserFlow = async (ctx: RunContext): Promise<AuthResult> => {
  ctx.say(`Opening your browser to sign in to ${APP.auth.displayName}${ctx.theme.glyph.ellipsis}`);

  return loopbackLogin({
    provider: authProviderFor(ctx),
    fetch: ctx.env.fetch,
    openExternal: (url) => ctx.env.openExternal(url),
    onUrl(url, opened) {
      // If the browser could not be opened, the URL is the whole flow — so it
      // is printed prominently rather than swallowed as a warning.
      if (opened) {
        ctx.say(ctx.theme.muted(`  If it did not open: ${url}`));
      } else {
        ctx.say(ctx.theme.warn('Could not open a browser automatically.'));
        ctx.say(`  Open this URL to continue:\n  ${ctx.theme.url(url)}`);
      }
      ctx.say(ctx.theme.muted('  Waiting for you to finish in the browser…'));
    },
    signal: ctx.signal,
  });
};

const deviceFlow = async (ctx: RunContext): Promise<AuthResult> =>
  deviceLogin({
    provider: authProviderFor(ctx),
    fetch: ctx.env.fetch,
    async onPrompt(details) {
      const target = details.verification_uri_complete ?? details.verification_uri;
      // The code is the one thing the user must transcribe correctly, so it is
      // boxed and spaced rather than buried in a sentence.
      for (const line of box([details.user_code], ctx.theme, { title: 'Your code' })) {
        ctx.say(line);
      }
      ctx.say(`  Open ${ctx.theme.url(details.verification_uri)} and enter the code above.`);
      ctx.say(ctx.theme.muted('  Waiting for approval…'));
      if (details.verification_uri_complete !== undefined) {
        await ctx.env.openExternal(target).catch(() => {
          // Expected on the machines this flow exists for.
        });
      }
    },
    signal: ctx.signal,
  });

/** The provider for this invocation. Delegates; see app.ts for why. */
const authProviderFor = (ctx: RunContext) =>
  resolveAuthProvider(APP, ctx.flags);

export const loginCommand = defineCommand({
  name: 'login',
  summary: 'sign in to your account',
  description:
    'Signs in through your browser by default. On a machine without one — an SSH ' +
    'session, a container — a device code is used instead. The token is stored in ' +
    '~/.kit/credentials.json with 0600 permissions and is only ever sent to the ' +
    'endpoint it was issued for.',
  flags: {
    device: {
      type: 'boolean',
      summary: 'use a device code instead of opening a browser',
      conflictsWith: ['token'],
    },
    token: {
      type: 'string',
      placeholder: '<token|->',
      summary: 'sign in with an existing token; use - to read it from stdin',
      conflictsWith: ['device'],
    },
    force: {
      type: 'boolean',
      summary: 'sign in again even if this profile is already signed in',
    },
  },
  examples: [
    { cmd: 'login', note: 'open a browser and sign in' },
    { cmd: 'login --device', note: 'sign in from a machine with no browser' },
    { cmd: 'login --token - < token.txt', note: 'sign in unattended, without exposing the token in argv' },
    { cmd: 'login --profile staging', note: 'keep a second account alongside the first' },
  ],

  async run(ctx) {
    const profile = profileName(ctx);
    const base = resolveBaseUrl(APP, ctx.flags);

    if (!ctx.flags.boolean('force')) {
      // This block asks one question — "are you already signed in and does it
      // work?" — so anything that stops it answering means no, and sign-in
      // proceeds. Letting openSession throw here makes `login` the one command
      // an expired credential breaks, and its own error tells you to run
      // `login`: a loop out of which only --force, undocumented for this,
      // would get you. The same applies to a stored token bound to another
      // endpoint, which is precisely what you are here to replace.
      const existing = await openSession(ctx).catch(() => undefined);
      if (existing?.token !== undefined) {
        const identity = await fetchIdentity(existing).catch(() => undefined);
        // Already signed in and the token still works: say so and stop, rather
        // than silently minting a second credential.
        if (identity !== undefined) {
          ctx.say(ctx.theme.ok(`Already signed in as ${describeIdentity(identity)}.`));
          ctx.say(ctx.theme.muted(`  Use --force to sign in again, or \`${APP.name} logout\` first.`));
          ctx.emit({ ok: true, alreadySignedIn: true, profile, identity });
          return;
        }
      }
    }

    const useDevice =
      ctx.flags.boolean('device') ||
      (!ctx.flags.has('token') && !canOpenBrowser(ctx.env.processEnv, ctx.env.platform));

    let result: AuthResult;
    if (ctx.flags.has('token')) {
      result = await tokenFlow(ctx);
    } else if (useDevice) {
      if (!ctx.flags.boolean('device')) {
        ctx.say(ctx.theme.muted('No browser available here — using a device code instead.'));
      }
      result = await deviceFlow(ctx);
    } else {
      result = await browserFlow(ctx);
    }

    if (result.token === '') {
      throw new AuthError('auth.empty_token', 'No token was provided.');
    }

    const credential: StoredCredential = {
      token: result.token,
      baseUrl: base.value,
      createdAt: ctx.env.now().toISOString(),
      ...(result.account === undefined ? {} : { account: result.account }),
      ...(result.expiresIn === undefined
        ? {}
        : { expiresAt: new Date(ctx.env.now().getTime() + result.expiresIn * 1000).toISOString() }),
    };

    // Check the token before writing it anywhere.
    //
    // The three outcomes are deliberately not two. A *rejected* token must not
    // be saved — persisting it turns every later command into a confusing 401
    // instead of a clear "you are not signed in". An *unreachable* server is
    // not evidence of a bad token, so that one is saved with a warning. Only a
    // verified token gets an unqualified success line.
    const probe = new HttpClient({
      baseUrl: base.value,
      fetch: ctx.env.fetch,
      userAgent: `${APP.name}/${APP.version}`,
      token: result.token,
      signal: ctx.signal,
    });

    let identity: Identity | undefined;
    let verified = false;
    const identityUrl = authProviderFor(ctx).identityUrl;
    if (identityUrl !== undefined) {
      try {
        identity = await probe.get<Identity>(identityUrl);
        verified = true;
      } catch (error) {
        if (error instanceof AuthError) {
          throw new AuthError('auth.rejected', 'That token was rejected — nothing was saved.', {
            hint: `Run \`${APP.name} login\` to sign in again.`,
            cause: error,
          });
        }
        // Save-on-unreachable is a judgement about the *server*, and Ctrl-C
        // is not evidence about the server. Left here, cancelling the probe
        // saved the credential and reported success — the one outcome the
        // user was actively trying to prevent.
        if (isInterruption(error, ctx.signal)) throw new InterruptedError();

        ctx.say(ctx.theme.warn('Saved, but the account could not be confirmed just now.'));
        ctx.say(ctx.theme.muted(`  ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    await saveCredential(ctx.env.homeDir, APP.brand, profile, credential);

    if (!verified) {
      ctx.say(ctx.theme.muted(`  Token saved to ~/.${APP.brand}/credentials.json (0600).`));
      ctx.emit({ ok: true, profile, verified: false });
      return;
    }

    ctx.say(ctx.theme.ok(`Signed in as ${describeIdentity(identity)}.`));
    if (profile !== 'default') ctx.say(ctx.theme.muted(`  Profile: ${profile}`));
    ctx.say(ctx.theme.muted(`  Token saved to ~/.${APP.brand}/credentials.json (0600).`));
    ctx.emit({ ok: true, profile, verified: true, identity });
  },
});

export { tokenEnvName };
