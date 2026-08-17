# pi-dsh

**A small Pi coding-agent runtime that survives crashes, remembers why things happened, and can
mount human-approved tools while it runs.**

pi-dsh keeps Pi's readable loop and four coding tools, then adds crash-consistent sessions,
durable constraints, causal history search, a replaceable component graph, approval-gated host
self-extension, and a read-only trajectory viewer.

![pi-dsh durable trajectory viewer](https://abhishekgahlot2.github.io/pi-dsh/docs/assets/trajectory.png)

> **Project status:** experimental personal harness. TypeScript is strict, the Pi vendor tree is
> conformance-tested, and the current revision passes 138 tests. Approved extension JavaScript is
> trusted local code—not safely sandboxed untrusted code.

## Why this exists

| Problem | pi-dsh behavior |
|---|---|
| The process dies around a side-effecting tool | A durable pre-tool checkpoint distinguishes `NOT_STARTED` from `OUTCOME_UNKNOWN`; resume never invents a successful result. |
| Long history needs compaction | Compaction shadows a closed, tool-balanced prefix and records direct provenance instead of rewriting the log. |
| Important instructions disappear from context | Constraints are durable events reconstructed for every request, independent of compacted transcript text. |
| An old decision is buried in another session | The agent can search cold session logs and return stable `sessionId:seq:line` citations. |
| You need a task-specific tool now | The model may define host JavaScript, but a human must approve the exact revision and source hash before it can run. |
| You want to know what actually happened | The viewer exposes requests, tools, usage, compaction, repair, extensions, surfaces, lineage, and causal relationships. |

## Quickstart

Requirements: Node.js 22.19+, npm, an OpenRouter-compatible API key, and a selected model id.

```sh
git clone --recurse-submodules https://github.com/abhishekgahlot2/pi-dsh.git
cd pi-dsh
npm ci
cp .env.example .env
```

Edit `.env`:

```dotenv
PIDSH_MODEL=<openrouter-model-id>
OPENROUTER_API_KEY=<your-key>
```

You may keep the key outside the repository instead; see
[Getting started](docs/getting-started.md#credentials).

Start the agent:

```sh
npm start
```

In a second terminal, start the read-only viewer:

```sh
npm run web
```

Open <http://127.0.0.1:8787>. The CLI prints the session id needed for resume and targeted history
queries.

## What you can do

### Keep a rule alive for the whole session

```text
/constraint add protect-vendor Never modify files under vendor/ or upstream/
```

The rule survives provider steps, compaction, process restart, and default tree forks. Revoke it
explicitly:

```text
/constraint revoke protect-vendor
```

### Recall an earlier decision with evidence

Ask the agent:

```text
Use session_search to find prior discussions about the component kernel.
Trace the most relevant event and cite every claim as sessionId:seq:line.
```

The query service reads live or cold Pi v4 logs without acquiring their writer locks. It can
search, read a bounded event window, trace direct relationships, and walk session lineage.

### Create and approve a temporary tool

Ask the model to call `extension_define` with one exact function expression:

```js
async (ctx) => {
  ctx.registerTool(
    {
      name: "hello_ext",
      description: "Return a deterministic greeting",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    },
    async (args) => ({ greeting: "hello " + args.name })
  )

  ctx.registerPrompt({
    id: "hello-hint",
    text: "Use hello_ext when asked for the extension greeting."
  })
}
```

Definition schedules an immutable revision; it does **not** execute the source. Inspect it:

```text
/extension inspect
```

Approve the exact revision and hash shown by the CLI, then run it:

```text
/extension approve hello-ext <revision-id> <source-hash>
/extension run hello-ext <revision-id>
```

The generated tool appears on the next admitted request. Stop or remove it with
`/extension stop hello-ext` or `/extension remove hello-ext`. Definitions and workers are
process-local and intentionally disappear after restart.

Read [Self-extension](docs/self-extension.md) before approving non-trivial code.

### Inspect the causal trajectory

The web application has two projections:

- **Chat** — model-visible user, assistant, and tool-result messages.
- **Trajectory** — the complete durable ledger, including operational records that never enter
  model context.

Events are marked `current`, `shadowed`, or `log-only`. Search across sessions, open a bounded
window around one event, or trace direct parent/run/tool/queue/compaction/extension relationships.
The viewer is read-only and never repairs, truncates, locks, or appends to a session file.

## Feature map

### Agent and tools

- Pi's agent loop
- `read`, `bash`, `edit`, and `write`
- streaming provider requests
- steering, follow-ups, abort, resume, and tree forks
- configurable model, base URL, context window, output limit, and session root

### Durable session engine

- Pi v4 as the only session vocabulary
- append → fsync → acknowledge ordering
- atomic first publication and directory sync
- failed-append rollback
- torn final-line repair; interior corruption refusal
- one cross-process writer lock per session
- ordered shutdown: stop admission → abort → drain → dispose → close

### Recovery and context

- durable checkpoint before every tool body
- append-only interrupted-run repair
- `NOT_STARTED` versus `OUTCOME_UNKNOWN` classification
- closed-prefix compaction with surface-stability checks
- provenance for shadowed and retained history
- threshold and provider-overflow compaction
- durable add/revoke constraints

### Runtime composition

- per-session typed component graph
- dependency activation and reverse-order disposal
- immutable graph snapshots
- idle-only replacement with rollback
- provider is graph-visible but deliberately non-replaceable

### Causal query

- bounded scan search with query-bound cursors
- stable `{ sessionId, seq, line }` citations
- `current`, `shadowed`, and `log-only` surfaces
- event windows and direct causal traces
- session ancestry and descendants
- model-facing and read-only HTTP consumers share the same query implementation

### Host self-extension

- inspect → define → approve → run → stop/update/rollback/remove lifecycle
- exact approval binding to session, extension, revision, and source hash
- worker-thread execution with parent-owned wall-clock termination
- transactional manifest verification before contributions become visible
- process-local tool and static prompt contributions
- durable intent/lifecycle receipts with direct run and tool-call correlation
- synchronous infinite loops cannot wedge the main agent process

## CLI commands

| Command | Effect |
|---|---|
| `/constraint add <id> <text>` | Add or reactivate a durable constraint. |
| `/constraint revoke <id>` | Revoke an active constraint. |
| `/extension inspect` | Show component graph, definitions, revisions, trust statement, and active workers. |
| `/extension approve <id> <revision> <hash>` | Approve exactly one immutable extension revision. |
| `/extension run <id> <revision>` | Run an approved revision immediately while idle. |
| `/extension stop <id>` | Stop its worker and remove contributions. |
| `/extension rollback <id> <revision>` | Stop current and run a previously approved revision. |
| `/extension remove <id>` | Stop and forget the process-local definition. |
| `/compact` | Request manual closed-prefix compaction. |
| `/quit` | Drain and close the session cleanly. |

Resume an existing session:

```sh
npm start -- --resume <session-id>
```

## Model-facing tools

| Family | Tools |
|---|---|
| Coding | `read`, `bash`, `edit`, `write` |
| History | `session_search`, `session_event_window`, `session_trace`, `session_lineage` |
| Extensions | `extension_inspect`, `extension_define`, `extension_run`, `extension_stop`, `extension_update`, `extension_rollback`, `extension_remove` |

Model-facing extension lifecycle calls are deferred. They append an intent during the active turn,
then apply it only after `operation_finished` is durable and the session has closed admission for
post-run drain. A tool or prompt surface never changes halfway through a request.

## Test

```sh
npm run check
npm test
npm audit
```

Expected at this revision: **18 test files, 138 passing tests, zero known dependency
vulnerabilities**.

The suite covers Pi storage conformance, fsync/rollback/locks, crash repair, compaction,
constraints, component replacement and rollback, query citations and corruption, worker crashes
and infinite loops, approval/source binding, complete self-extension lifecycle, HTTP traversal and
symlink rejection, CSP, SSE cleanup, and ordered shutdown.

See [Testing](docs/testing.md) for focused commands and the real-provider smoke workflow.

## Trust and deliberate limits

- **Approved extension JavaScript is trusted local code.** Worker threads plus `node:vm` provide
  lifecycle containment and preemption, not a security boundary.
- Extension source is durable in the assistant tool-call history and visible in raw ledger
  payloads. Lifecycle receipts contain metadata and hashes, not a second source copy.
- Browser/client extensions are not supported. The web application remains read-only.
- Definitions and workers are process-local and are not auto-restored on resume.
- One writer owns a session. There are no concurrent writers or multi-lane orchestration.
- Provider is non-replaceable; other component replacement is idle-only.
- `OUTCOME_UNKNOWN` is honest ambiguity, not automatic reconciliation of external side effects.
- Constraint mutation is currently accepted only while the public session API is idle.
- Proactive compaction estimates transcript messages, not every fixed-prefix request token.
- Remote viewer binding requires `--allow-remote`; the server has no authentication.

## Repository map

| Path | Purpose |
|---|---|
| `src/api.ts` | Public runtime/session API and ordered lifecycle. |
| `src/adapter.ts` | Pi loop ↔ durable session boundary. |
| `src/persistence.ts` | Crash-consistent Pi v4 JSONL storage. |
| `src/component-kernel.ts` | Bounded component graph and replacement. |
| `src/session-query*.ts` | Causal search/window/trace/lineage and model tools. |
| `src/extensions.ts` | Approval, revisions, workers, contributions, and receipts. |
| `src/extension-worker.ts` | Worker-side VM and host RPC protocol. |
| `web/` | Read-only HTTP/SSE server and trajectory browser. |
| `test/` | Unit, integration, conformance, crash, security, and E2E tests. |
| `vendor/pi/` | Machine-synced Pi subset; never hand-edit. |
| `upstream/` | Pinned Pi and dsh reference submodules. |

## Further reading

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Self-extension](docs/self-extension.md)
- [Session query](docs/session-query.md)
- [Testing](docs/testing.md)

dsh code is not vendored. It contributes failure semantics and test intent. Pi remains the only
runtime session model and Pi v4 remains the only durable session vocabulary.

## Secrets and local data

Never commit `.env`, `.pi-dsh/`, `.omx/`, extension drafts, or API keys. Session logs may contain
prompts, model output, extension source, tool arguments, paths, and constraint text. Local sessions,
behavioral notes, and planning artifacts are ignored by default.
