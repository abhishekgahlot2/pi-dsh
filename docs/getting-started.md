# Getting started

## Install

```sh
git clone --recurse-submodules https://github.com/abhishekgahlot2/pi-dsh.git
cd pi-dsh
npm ci
cp .env.example .env
```

If you cloned without submodules:

```sh
git submodule update --init --recursive
```

## Configuration

`npm start` and `npm run web` load `.env` through `tsx`.

| Variable | Required | Default | Meaning |
|---|---:|---|---|
| `PIDSH_MODEL` | yes | — | OpenRouter-compatible model id. |
| `OPENROUTER_API_KEY` | usually | key-file fallback | Provider credential. |
| `PIDSH_BASE_URL` | no | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL. |
| `PIDSH_CONTEXT_WINDOW` | no | `128000` | Context-window policy used by compaction. |
| `PIDSH_MAX_TOKENS` | no | `8192` | Maximum provider output tokens. |
| `PIDSH_SESSIONS_ROOT` | no | `.pi-dsh/sessions` | Durable session directory. |
| `PIDSH_OPENROUTER_KEY_NAME` | no | `openrouter_key` | Named entry to read from `~/ai_keys_loop`. |

### Credentials

The ordinary setup places the key in ignored `.env`:

```dotenv
PIDSH_MODEL=<model-id>
OPENROUTER_API_KEY=<key>
```

For the local key-file fallback, use one `name=value` line in `~/ai_keys_loop`:

```text
openrouter_key=<key>
```

If your file uses another name:

```dotenv
PIDSH_OPENROUTER_KEY_NAME=<entry-name>
```

Never paste a key into a prompt, session constraint, extension source, test fixture, or Git
command. Session logs are intentionally auditable and can contain model-visible input.

## Start and stop

```sh
npm start
```

The first line prints the session id:

```text
session 01...
>
```

Use `/quit` for ordered shutdown. `Ctrl-C` also requests shutdown, aborts active work, drains
post-run lifecycle work and persistence, disposes extension workers, and releases the lock.

## Resume

```sh
npm start -- --resume <session-id>
```

Opening performs storage repair before admitting work. If the previous process died during a tool
call, the transcript receives a synthetic error describing either `NOT_STARTED` or
`OUTCOME_UNKNOWN` before the model continues.

## Viewer

```sh
npm run web
```

Open <http://127.0.0.1:8787>. The viewer discovers `.jsonl` files under the same configured
session root. If agent and viewer use different working directories, pass the root explicitly:

```sh
npm run web -- --sessions-root /absolute/path/to/.pi-dsh/sessions
```

The server refuses non-loopback hosts unless you deliberately add `--allow-remote`. Remote mode
has no authentication.

## Common failures

### `PIDSH_MODEL is required`

Create `.env` and set `PIDSH_MODEL`.

### `401 User not found`

The request reached the provider, but the selected key is invalid, deleted, or associated with an
unavailable account. Create a valid key or point `PIDSH_OPENROUTER_KEY_NAME` at the correct local
key-file entry.

### `Session already has an active run`

pi-dsh is single-run per session. Wait for the current run or abort it; do not start a second
prompt concurrently.

### `SESSION_POST_RUN_DRAIN`

The model turn has durably finished, but deferred extension lifecycle work is still settling. The
session intentionally refuses new admission until that drain finishes.

### Writer-lock error

Another live process owns the session. Attach to that process or close it. A dead owner's lock is
detected and replaced on open.
