/**
 * PKCE (RFC 7636) and the CSRF `state` value.
 *
 * PKCE matters here more than it does in a web app. The redirect target is
 * `http://127.0.0.1:<port>`, which every other process on the machine can also
 * listen on and which no server can authenticate. Without a code challenge, an
 * authorization code observed in transit — in a browser history entry, in a
 * shell's process list, by another local process racing for the port — can be
 * redeemed by whoever holds it. With PKCE the code is worthless without the
 * verifier, which never leaves this process.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Pkce {
  /** Sent only in the token exchange, never in the browser URL. */
  verifier: string;
  /** Sent in the browser URL. */
  challenge: string;
  method: 'S256';
}

const base64url = (input: Buffer): string =>
  input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 32 bytes → 43 characters, comfortably inside RFC 7636's 43–128 range. */
export const createPkce = (): Pkce => {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
};

/** Opaque, unguessable, and echoed back by the server so we can match it. */
export const createState = (): string => base64url(randomBytes(24));

/**
 * Compare in constant time.
 *
 * `a === b` on a secret leaks its prefix through timing. The length check
 * before the comparison is unavoidable — `timingSafeEqual` throws on a length
 * mismatch — and harmless, because the length of a `state` is not secret.
 */
export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};
