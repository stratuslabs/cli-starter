/**
 * The template's placeholder binary name, and the patterns `rebrand.ts` uses
 * to rewrite the documentation.
 *
 * Its own module so a test can assert the invariant below without importing
 * `rebrand.ts`, which prompts on import.
 *
 * **The invariant: this word must never appear in the prose of the files
 * rebrand rewrites.** Those rewrites are whole-word find-and-replace, so a
 * placeholder that is also an ordinary English word gets substituted inside
 * sentences and corrupts the adopter's README on the one run they can least
 * afford it to go wrong.
 *
 * `kit` was the placeholder until it failed exactly that way — "a flow the
 * auth kit does not cover" is prose, and it matched. `cli` would be far worse:
 * this README says "CLI" in almost every paragraph. `acme` is chosen because
 * nobody writes it by accident, it reads as unmistakably a stand-in, and it
 * collides with no command in `src/commands/`.
 */
export const PLACEHOLDER = 'acme';

/** The binary as an invocation — `acme login`, never the bare word. */
export const PLACEHOLDER_WORD = new RegExp(`\\b${PLACEHOLDER}\\b(?= )`, 'g');

/** `~/.acme/` — the credential and config directory. */
export const PLACEHOLDER_HOME = new RegExp(`~/\\.${PLACEHOLDER}/`, 'g');

/** `ACME_TOKEN`, `ACME_BASE_URL`, … */
export const PLACEHOLDER_ENV = new RegExp(`\\b${PLACEHOLDER.toUpperCase()}_`, 'g');

/** The files rebrand rewrites, and therefore the ones the invariant covers. */
export const REBRANDED_DOCS = ['README.md', 'docs/adding-a-command.md', 'docs/auth-server.md'];
