# pi-dsh

A minimal personal coding-agent harness with Pi's readable agent loop and tools on top of a
durable, event-sourced session engine. It ports selected failure semantics from DeepSeek Harness
(dsh) as executable tests without adopting dsh's plugin runtime or event vocabulary.

The distinguishing feature is durable session constraints: explicit instructions are stored as
first-class events and reconstructed for every provider request, so compaction does not silently
remove them.

## Status

Implemented:

- Pi loop integration with read, bash, edit, and write tools
- Pi v4 as the single session vocabulary
- append → fsync durability, rollback, atomic publication, torn-tail recovery, and writer locks
- durable tool-start checkpoints and append-only interrupted-run repair
- closed-prefix transactional compaction with provenance
- durable add/revoke constraint events
- create, resume, steer, follow-up, abort, fork, compact, and subscribe APIs
- dependency-free local trajectory viewer with Chat/Trajectory views and live SSE updates

The strict typecheck and 93 local tests pass. The paid constraint-adherence benchmark and a live
provider crash smoke test are still product-validation gates; the local suite does not substitute
for them.

## Requirements

- Node.js 22.19 or newer
- npm
- an OpenRouter API key in `OPENROUTER_API_KEY`, or `openrouter_key=...` in `~/ai_keys_loop`
- an explicitly selected model in `PIDSH_MODEL`

## Install

```sh
git clone --recurse-submodules https://github.com/abhishekgahlot2/pi-dsh.git
cd pi-dsh
npm ci
```

If the repository was cloned without submodules:

```sh
git submodule update --init --recursive
```

## Test

Run the complete local verification:

```sh
npm run check
npm test
```

Expected result at this revision: 13 test files and 93 passing tests, including Pi storage
conformance, crash durability, repair races, compaction, constraints, API lifecycle, and web/SSE
coverage.

To verify that the committed Pi subset still matches the pinned upstream submodule:

```sh
npm run sync
npm run check
npm test
git diff --exit-code -- vendor/pi
```

`npm run sync` deliberately refreshes `vendor/pi/UPSTREAM.json`, including its synchronization
timestamp, so review that file before committing an upstream refresh.

## Run the agent

Create a local `.env` and select any current OpenRouter model ID:

```sh
cp .env.example .env
# Edit PIDSH_MODEL in .env.
npm start
```

`npm start` loads `.env` automatically. The API key may remain in `~/ai_keys_loop` as
`openrouter_key=...`; it does not need to be copied into the repository.

The CLI prints the session ID. Supported commands include:

```text
/constraint add <id> <instruction>
/constraint revoke <id>
/compact
/quit
```

Resume an existing session:

```sh
PIDSH_MODEL="<model-id>" npm start -- --resume <session-id>
```

Configuration is available through `PIDSH_BASE_URL`, `PIDSH_CONTEXT_WINDOW`,
`PIDSH_MAX_TOKENS`, `PIDSH_SESSIONS_ROOT`, and `PIDSH_OPENROUTER_KEY_NAME`. The last
variable selects a named `key=value` entry from `~/ai_keys_loop` without copying the secret.
The default session directory is `.pi-dsh/sessions` under the working directory.

## Inspect trajectories

Start the read-only local viewer:

```sh
npm run web
```

Open <http://127.0.0.1:8787>. The viewer shows sessions, model-visible chat, the complete durable
event ledger, request snapshots, tool checkpoints/results, constraints, compaction, repair,
usage, payload schemas, correlations, and live file updates.

For a non-default session directory:

```sh
npm run web -- --sessions-root /absolute/path/to/sessions
```

The viewer never opens writable session storage, acquires a session writer lock, or repairs the
log. Prompting remains in the CLI so the single-writer contract is preserved.

## Architecture

- `src/` — durable engine, adapters, public API, provider wiring, and CLI
- `test/` — regression, crash-injection, conformance, and web/SSE tests
- `web/` — dependency-free read-only trajectory server and browser UI
- `vendor/pi/` — machine-synced Pi subset; never hand-edit
- `upstream/pi-mono/` and `upstream/deepseek-harness/` — pinned reference submodules

dsh code is not vendored. It contributes failure semantics and test intent. Pi remains
the only runtime session model, while provider, tools, execution environment, and storage are
replaceable through explicit composition and process restart.

## Deliberate limits and known gaps

- one writer per session; no concurrent writers or multi-lane orchestration
- the web viewer is read-only
- an interrupted side-effecting tool can be classified as `OUTCOME_UNKNOWN`, but external-state
  reconciliation remains tool/operator policy rather than a universally enforceable guarantee
- constraint changes are currently accepted only while the public session API is idle
- proactive compaction estimates transcript messages, not the entire fixed request prefix
- arbitrary `prepareNextTurn` message changes are not copied into the durable request snapshot

See [plan.md](plan.md) and [review.md](review.md) for the decision record and remaining
product-validation work. Private behavioral design notes are ignored; executable tests are the
public contract.

## Secrets and local data

Never commit API keys or `.pi-dsh/` session logs. Session files can contain prompts, model output,
tool arguments, working paths, and constraint text. Both `.pi-dsh/` and `.omx/` are ignored.
