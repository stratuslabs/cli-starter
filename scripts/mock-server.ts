/**
 * Run the mock auth server so `kit login` works in a fresh clone.
 *
 *   npm run mock-server        # terminal 1
 *   npm run kit -- login       # terminal 2
 *
 * It is the same server the tests use, on the port `src/app.ts` points at by
 * default — so the browser flow works end to end before you have written any
 * backend at all. Delete this once you have a real one; `docs/auth-server.md`
 * describes what to build.
 */

import { startMockAuthServer } from '../test/support/mock-auth-server.ts';

const PORT = Number(process.env['PORT'] ?? 8787);

const server = await startMockAuthServer(PORT);

process.stdout.write(
  [
    `Mock auth server listening on ${server.url}`,
    '',
    '  It approves every sign-in immediately and issues fake tokens.',
    '  Not a real identity server — see docs/auth-server.md.',
    '',
    '  Try:  npm run kit -- login',
    '        npm run kit -- whoami',
    '',
  ].join('\n'),
);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
