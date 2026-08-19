/**
 * Run the mock auth server so `acme login` works in a fresh clone.
 *
 *   npm run mock-server        # terminal 1
 *   npm run acme -- login       # terminal 2
 *
 * It is the same server the tests use, on the port `src/app.ts` points at by
 * default — so the browser flow works end to end before you have written any
 * backend at all. Delete this once you have a real one; `docs/auth-server.md`
 * describes what to build.
 */

import { startMockAuthServer } from '../test/support/mock-auth-server.ts';

const PORT = Number(process.env['PORT'] ?? 8787);

const server = await startMockAuthServer(PORT);

/**
 * A pre-issued token, so you can exercise commands without signing in first.
 *
 * Useful when you are iterating on a command and do not want a browser round
 * trip every time you restart the server.
 */
const SEEDED_TOKEN = 'tok_dev';
server.issuedTokens.add(SEEDED_TOKEN);

process.stdout.write(
  [
    `Mock auth server listening on ${server.url}`,
    '',
    '  It approves every sign-in immediately and issues fake tokens.',
    '  Not a real identity server — see docs/auth-server.md.',
    '',
    '  Try:  npm run acme -- login',
    '        npm run acme -- whoami',
    '        npm run acme -- notes',
    '',
    `  Or skip signing in — this token is already valid:`,
    `      export KIT_BASE_URL=${server.url}`,
    `      export KIT_TOKEN=${SEEDED_TOKEN}`,
    '',
  ].join('\n'),
);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
