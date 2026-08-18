# Exit codes

An exit code is API. A script wrapping this CLI branches on it, so these are
stable and should not be reassigned.

| Code | Name | Meaning |
|---:|---|---|
| `0` | ok | Success. |
| `1` | general | A failure with no more specific classification. |
| `2` | usage | The command line was wrong: unknown flag, missing argument, bad choice. Also returned when a prompt was needed and there was nobody to ask. |
| `3` | config | Configuration is missing, malformed, or contradictory. `doctor` returns this when it finds problems. |
| `4` | auth | Not signed in, signed in as the wrong account, or the token was rejected. |
| `5` | network | The server could not be reached, timed out, or returned a 5xx. |
| `6` | not found | The named thing does not exist. |
| `7` | conflict | The named thing exists but is in the wrong state for this operation. |
| `130` | interrupted | Ctrl-C. The shell convention is 128 + SIGINT. |

The split that matters most in practice is `4` versus `5`: "your credentials
are bad, sign in again" and "the network is down, retry later" call for
opposite responses from a script, and a CLI that returns `1` for both forces
the caller to grep English.

## In scripts

```bash
if ! output=$(kit whoami --json); then
  case $? in
    4) kit login ;;
    5) echo "service unavailable, retrying later" ;;
    *) echo "$output" >&2; exit 1 ;;
  esac
fi
```

## Under `--json`

Failures print to **stdout** as JSON, so the same pipe carries both outcomes:

```json
{
  "ok": false,
  "error": {
    "code": "auth.not_signed_in",
    "message": "You are not signed in to Example.",
    "hint": "Run `kit login`, or set $KIT_TOKEN."
  }
}
```

`error.code` is a stable dotted identifier and is the right thing to branch on
when the exit code is not specific enough. `message` and `hint` are for humans
and may be reworded.

## Adding one

Add it to `EXIT` in `src/kit/errors.ts`, give it a `CliError` subclass, and add
a row to the table above. Do not reuse a number for a different meaning.
