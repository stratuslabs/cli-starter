/**
 * The pluggable auth seam.
 *
 * A template cannot assume anyone's identity server, so every URL the login
 * flows touch is declared here and supplied by `src/app.ts`. Adopting this
 * template for a different product means editing one object, not editing the
 * flows.
 *
 * The shape follows OAuth 2.0 (authorization code + PKCE, RFC 7636; device
 * authorization grant, RFC 8628) because that is what most servers already
 * speak — but nothing here requires a full OAuth implementation on the server.
 * A handful of endpoints that mint an API token is enough, which is exactly
 * what `docs/auth-server.md` specifies.
 */

export interface AuthProvider {
  /** Shown in prompts and success messages: "Signed in to Acme." */
  displayName: string;
  /**
   * The API origin. Tokens are bound to this — see `credentials.ts`.
   */
  baseUrl: string;
  /** Browser page that asks the human to approve this CLI. */
  authorizeUrl: string;
  /** Exchanges an authorization code (or device code) for a token. */
  tokenUrl: string;
  /** Identifies this CLI to the server. Public, not a secret. */
  clientId: string;
  scopes?: string[];

  /**
   * Starts the device flow. When absent, `--device` reports that this provider
   * does not support it instead of failing obscurely.
   */
  deviceCodeUrl?: string;

  /** Returns the signed-in identity. Used by `whoami` and to verify a token. */
  identityUrl?: string;

  /**
   * Invalidates a token server-side.
   *
   * Without this, `logout` only deletes the local copy — which is a lie if the
   * user ran it because they think the token leaked.
   */
  revokeUrl?: string;

  /** Where a human can mint a token by hand, for the paste path. */
  tokenHelpUrl?: string;
}

/** The normalized result of any of the three flows. */
export interface AuthResult {
  token: string;
  /** Seconds, as the server reported it. */
  expiresIn?: number;
  account?: { id?: string; name?: string; email?: string };
}

/** What a token endpoint returns. Extra fields are ignored. */
export interface TokenResponse {
  access_token?: string;
  token?: string;
  expires_in?: number;
  account?: { id?: string; name?: string; email?: string };
  error?: string;
  error_description?: string;
}

export const toAuthResult = (response: TokenResponse): AuthResult | undefined => {
  // `access_token` is the OAuth spelling; `token` is what a minimal
  // implementation tends to return. Accept both rather than making every
  // adopter reshape their endpoint.
  const token = response.access_token ?? response.token;
  if (typeof token !== 'string' || token === '') return undefined;
  return {
    token,
    ...(response.expires_in === undefined ? {} : { expiresIn: response.expires_in }),
    ...(response.account === undefined ? {} : { account: response.account }),
  };
};
