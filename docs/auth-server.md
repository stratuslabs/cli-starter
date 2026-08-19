# The server side of sign-in

The CLI's login flows need five endpoints. None of them requires a full OAuth
server — if you already issue API tokens, most of the work is done and what
follows is a thin, short-lived layer in front of the tokens you have.

`test/support/mock-auth-server.ts` is a working implementation of everything on
this page, in about two hundred lines. Read it alongside this.

## The shape

```
GET  /cli/authorize            browser page: "allow <device> to act as you?"
POST /api/v1/cli/token         code + verifier  → token   (and device code → token)
POST /api/v1/cli/device/code   start a device flow
GET  /api/v1/cli/identity      who is this token?
POST /api/v1/cli/revoke        invalidate a token
```

Point `src/app.ts` at them and you are done.

## 1. `GET /cli/authorize`

The only endpoint a human sees. It arrives with:

| Parameter | Meaning |
|---|---|
| `client_id` | identifies the CLI |
| `redirect_uri` | `http://127.0.0.1:<port>/callback` |
| `state` | opaque; echo it back unchanged |
| `code_challenge` | base64url SHA-256 of a secret the CLI kept |
| `code_challenge_method` | always `S256` |
| `scope` | space-separated, optional |

Require a signed-in session. Show a page naming **what is being authorized and
by which device**, with approve and deny buttons — this is the user's only
chance to see what is happening, so do not auto-approve.

On approve, mint a short-lived, single-use authorization code, store it with the
challenge and the redirect URI, and redirect to
`redirect_uri?code=…&state=…`. On deny, redirect with
`?error=access_denied&error_description=…`.

**Validate `redirect_uri` before redirecting to it.** Accept only `127.0.0.1`
or `localhost` on an arbitrary port with the path `/callback`. An open
redirector here hands authorization codes to anyone who can craft a link.

Three things are easy to get wrong:

- **A logged-out user must come back here after signing in.** Store the return
  location explicitly. Frameworks that redirect to a login page from a custom
  `authenticate!` override often skip the "remember where you were" step, and
  the symptom is a user who signs in, lands on the dashboard, and leaves the
  CLI waiting forever. (This is exactly the case in our Rails app, where
  `ApplicationController` overrides `authenticate_user!` with a manual
  redirect and so bypasses Devise's failure app.)
- **Enforce entitlements here, not only at the token exchange.** If API access
  needs a paid plan, say so on this page with an upgrade link. Discovering it
  after a successful browser round-trip is a bad experience and a confusing
  `403` in the terminal.
- **Store the code hashed.** It is short-lived, so hashing costs nothing, and
  it keeps a database leak from being a live-credential leak.

## 2. `POST /api/v1/cli/token`

Form-encoded. Serves both flows, distinguished by `grant_type`.

**Authorization code:**

```
grant_type=authorization_code
client_id, code, code_verifier, redirect_uri
```

Look the code up, **delete it** (single use — a replayable code is a stealable
one), then check PKCE:

```
base64url(sha256(code_verifier)) == stored code_challenge
```

Reject if it does not match, if the code has expired, or if `redirect_uri`
differs from the one the code was issued for.

**Device code:**

```
grant_type=urn:ietf:params:oauth:grant-type:device_code
client_id, device_code
```

Respond by state, using the RFC 8628 error codes — the CLI handles each
differently, and collapsing them into one error makes it impossible to tell
"still waiting" from "denied":

| State | Response |
|---|---|
| not yet approved | `400 {"error":"authorization_pending"}` |
| polling too fast | `400 {"error":"slow_down"}` |
| user declined | `400 {"error":"access_denied"}` |
| code expired | `400 {"error":"expired_token"}` |
| approved | `200` with the token |

Success in both cases:

```json
{
  "access_token": "…",
  "expires_in": 3600,
  "account": { "id": "acct_1", "name": "Analytical Engines" }
}
```

`token` is accepted as an alias for `access_token`. `expires_in` and `account`
are optional.

## 3. `POST /api/v1/cli/device/code`

Form-encoded `client_id` and optional `scope`. Returns:

```json
{
  "device_code": "…",
  "user_code": "WXYZ-1234",
  "verification_uri": "https://example.com/cli/device",
  "verification_uri_complete": "https://example.com/cli/device?code=WXYZ-1234",
  "expires_in": 600,
  "interval": 5
}
```

Make `user_code` short and unambiguous — people read it off one screen and type
it into another. Avoid characters that look alike (`0`/`O`, `1`/`I`/`l`).
`interval` is the minimum seconds between polls; the CLI honours it and backs
off further on `slow_down`.

You also need a page at `verification_uri` where a signed-in user enters the
code and approves.

## 4. `GET /api/v1/cli/identity`

Bearer auth. Returns whoever the token belongs to:

```json
{
  "id": "user_1",
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "account": { "id": "acct_1", "name": "Analytical Engines", "tier": "pro" }
}
```

Used by `whoami`, by `doctor`, and by `login` to confirm a token works before
reporting success. Return `401` for a bad token — the CLI distinguishes
*rejected* (do not save it) from *unreachable* (save it, warn), and that
distinction depends on you returning the right status.

## 5. `POST /api/v1/cli/revoke`

JSON `{"token": "…"}`. Invalidate it and return `200`.

Without this, `logout` can only delete the local copy — which is a lie to
someone who ran it because they think the token leaked. If your tokens have no
revocation state, add one; `logout` reports honestly either way, but "revoked"
is the answer people want.

## Adapting an existing token model

If you already have an API-keys table, you likely need:

- a **short-lived authorization/device code** table — `code_digest`,
  `code_challenge`, `state`, `redirect_uri`, `user_code`, `device_code_digest`,
  `user_id`, `client_name`, `device_label`, `approved_at`, `expires_at`,
  `consumed_at` — plus a job to sweep expired rows;
- `revoked_at` on the tokens table, and a scope that excludes revoked tokens.
  Without it, `revoke` has nothing to write and `logout` cannot be honest;
- `source` (`dashboard` / `cli`) and `device_label`, so a user can see which
  token came from which machine and revoke one of them.

Hashing an existing plaintext token column is a separate, larger migration —
worth doing, but not a prerequisite for any of the above.

## Checklist

- [ ] `redirect_uri` restricted to loopback
- [ ] `state` echoed back unchanged
- [ ] PKCE `S256` verified on exchange
- [ ] authorization codes single-use, short-lived, stored hashed
- [ ] the approval page names the device and requires a signed-in user
- [ ] a logged-out user returns to the approval page after signing in
- [ ] entitlements checked at approval time, not just at exchange
- [ ] device errors use the RFC 8628 codes
- [ ] `identity` returns `401` for a bad token
- [ ] `revoke` actually invalidates
