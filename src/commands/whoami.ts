/**
 * `kit whoami` — who am I signed in as, and where.
 *
 * Deliberately answers "where" as well as "who". With profiles and an
 * overridable endpoint, "signed in as Dana" is only half the story — the other
 * half is which server said so.
 */

import { defineCommand } from '../kit/command.ts';
import { definitionList } from '../kit/render.ts';
import { fetchIdentity, openSession } from './session.ts';

export const whoamiCommand = defineCommand({
  name: 'whoami',
  summary: 'show the signed-in account',
  examples: [{ cmd: 'whoami --json', note: 'get the account id for a script' }],

  async run(ctx) {
    const session = await openSession(ctx, { require: true });
    const identity = await fetchIdentity(session);

    ctx.emit({ ok: true, profile: session.profile, baseUrl: session.baseUrl, identity });

    if (ctx.globals.json) return;

    const rows = [
      { term: 'account', description: identity?.name ?? identity?.email ?? identity?.id ?? 'unknown' },
      { term: 'endpoint', description: `${session.baseUrl} ${ctx.theme.muted(`(${session.baseUrlOrigin})`)}` },
      { term: 'profile', description: session.profile },
      { term: 'token', description: ctx.theme.muted(session.tokenSource ?? 'unknown source') },
    ];
    if (identity?.account?.tier !== undefined) {
      rows.push({ term: 'plan', description: identity.account.tier });
    }

    for (const line of definitionList(rows, ctx.theme)) ctx.out(line);
  },
});
