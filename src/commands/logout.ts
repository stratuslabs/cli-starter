/**
 * `kit logout` — sign out.
 *
 * Revokes server-side first, then deletes the local copy. The order matters:
 * if revocation fails, the token is still live and the user needs to know,
 * so the local copy stays until they choose otherwise. Deleting first would
 * leave a working token in the wild with nothing left on this machine that
 * could revoke it.
 */

import { APP } from '../app.ts';
import { defineCommand } from '../kit/command.ts';
import { deleteCredential } from '../kit/credentials.ts';
import { openSession, profileName } from './session.ts';

export const logoutCommand = defineCommand({
  name: 'logout',
  summary: 'sign out and remove the saved credentials',
  description:
    'Revokes the saved token with the server, then deletes it from ' +
    '~/.kit/credentials.json. Other profiles are left alone.',
  flags: {
    local: {
      type: 'boolean',
      summary: 'delete the local token without contacting the server',
    },
  },
  examples: [
    { cmd: 'logout', note: 'revoke the token and forget it' },
    { cmd: 'logout --profile staging', note: 'sign out of one profile only' },
  ],

  async run(ctx) {
    const profile = profileName(ctx);
    const session = await openSession(ctx);

    if (session.token === undefined) {
      ctx.say(ctx.theme.ok('Already signed out.'));
      ctx.emit({ ok: true, profile, removed: false });
      return;
    }

    let revoked = false;
    const revokeUrl = session.provider.revokeUrl;
    if (!ctx.flags.boolean('local') && revokeUrl !== undefined) {
      try {
        await session.http.post(revokeUrl, { body: { token: session.token } });
        revoked = true;
      } catch (error) {
        // Say exactly what is still true. "Signed out" when the token is still
        // live is the kind of false reassurance someone acts on after a leak.
        ctx.say(ctx.theme.warn('Could not revoke the token with the server.'));
        ctx.say(ctx.theme.muted(`  ${error instanceof Error ? error.message : String(error)}`));
        ctx.say(
          ctx.theme.muted(
            `  The token is still valid. Remove it in your account settings, or re-run with --local to forget it here anyway.`,
          ),
        );
        ctx.emit({ ok: false, profile, revoked: false, removed: false });
        return 1;
      }
    }

    const removed = await deleteCredential(ctx.env.homeDir, APP.brand, profile);

    ctx.say(ctx.theme.ok(revoked ? 'Signed out and the token was revoked.' : 'Signed out.'));
    if (!revoked && ctx.flags.boolean('local')) {
      ctx.say(ctx.theme.muted('  The token was not revoked — it will keep working until it expires.'));
    }
    ctx.emit({ ok: true, profile, revoked, removed });
    return;
  },
});
