# Architecture

pi-dsh keeps Pi's agent loop and Pi v4 session vocabulary, then adds three bounded runtime
capabilities: a replaceable component graph, a causal session-query service, and approval-gated
host self-extension.

```text
CLI / public API
       │
       ▼
 PiDshSession ───── component graph ───── extension worker
       │                  │                      │
       ▼                  ▼                      │
 Pi loop adapter ◄── tools + prompt snapshot ◄──┘
       │
       ▼
 durable Pi v4 JSONL ───── causal query ───── viewer / model tools
```

The durable log and live component graph have different jobs. The log is authoritative at turn
boundaries and after restart. The graph owns process-local implementations and workers. Durable
facts may describe a process-local extension, but replay never turns those facts back into
execution authority.

## Invariants

| Invariant | Consequence |
|---|---|
| Pi v4 is the only durable vocabulary | No parallel dsh-shaped transcript or event store exists. |
| One writer owns a session | CLI mutation and web observation cannot race two storage owners. |
| Model-visible input is snapshotted | Tool and prompt changes appear only on a later request. |
| Tool body follows durable `tool_started` | Missing result can be classified without pretending the body never ran. |
| Extension approval binds exact source hash | Updating source creates a new unapproved revision. |
| Process-local activation is not replayed | Resume cannot silently execute old dynamic code. |
| Causal edges are direct and metadata-backed | Query does not infer relationships from time or similar text. |

## Component graph

Each session owns a small typed `ComponentKernel`. Components declare a stable id, kind,
dependencies, activation function, and awaited disposer. The kernel activates dependencies in
topological order, disposes in reverse dependency order, rejects cycles and duplicate ids, and
rolls back a failed idle-time replacement.

The graph contains the provider, base tools, prompt contributors, session query, and extension
runtime. The provider is visible but intentionally non-replaceable. Other components may be
replaced only while the session is idle; the next admitted request snapshots the new tool and
prompt surface.

This is not Cordis and does not implement dsh profiles, bundles, reactive hot-swapping, or a
general plugin loader.

### Replacement sequence

```text
assert session idle
activate candidate
dispose active dependents
dispose previous component
publish candidate
reactivate dependents
```

If candidate activation or dependent rebinding fails, the kernel disposes the candidate,
reactivates the previous definition, and returns a stable error. Provider replacement is rejected
before this sequence because provider/model changes also affect compaction and summarization
policy.

## Causal session query

`SessionQueryService` reads Pi v4 JSONL without opening writable session storage or acquiring a
writer lock. It provides bounded scan search, event windows, direct relationship traces, and
session lineage. Every result cites `{ sessionId, seq, line }`.

Events are classified as:

- `current` — present on the current model surface;
- `shadowed` — replaced by compaction;
- `log-only` — durable operational history not projected into model context.

Trace relationships are direct and metadata-backed: entry parent/child, run membership, tool
request/result, queues, compaction replacement/source/derived links, and extension intent/lifecycle
links. Missing metadata produces no inferred edge.

The query layer is deliberately scan-first. It reads regular `.jsonl` files only, rejects unsafe
ids and symlinks, and applies hard session/byte/result/query bounds. Query cursors are bound to the
normalized query and filters so they cannot be reused against a different result set.

## Host self-extension

The model can inspect the runtime and submit one exact host JavaScript function expression:

```js
async (ctx) => {
  ctx.registerTool(
    { name: "example", description: "Return JSON", inputSchema: { type: "object" } },
    async (args, { signal, toolCallId }) => ({ args, toolCallId, aborted: signal.aborted }),
  )
  ctx.registerPrompt({ id: "example-hint", text: "Use example when requested." })
}
```

Definition is not execution. The submitted source is durable in the assistant tool-call history,
and the runtime schedules an intent for post-run drain. A human must approve the exact
`{ sessionId, extensionId, revisionId, sourceHash }` before a later model turn can schedule it to
run. Definitions and workers are process-local and are never restored automatically.

Each active revision owns one worker thread. The source is evaluated with `node:vm` inside that
worker, registrations are buffered until activation and manifest verification succeed, and tool
calls cross a validated request-id protocol. Parent-owned timers terminate the worker when
activation, handler execution, or disposal exceeds its bound, so a synchronous infinite loop
cannot block the agent process.

Approved extension JavaScript is trusted local code, equivalent to granting a powerful local
tool or Bash access. Worker threads and `node:vm` provide lifecycle containment and preemption,
not a security boundary. The host intentionally exposes only registration, bounded session
query, time, and identity helpers, but does not claim isolation from malicious approved code.

Browser JavaScript extensions are not supported. The web application remains a read-only
observer of durable receipts and causal traces.

## Lifecycle ordering

Model-facing lifecycle calls execute during a turn, so they never mutate the active tool/prompt
snapshot. They append a directly correlated `extension/intent-scheduled` receipt and return
`scheduled-for-next-turn`. After `operation_finished` is durable, the session closes admission,
drains queued lifecycle intents, then reopens admission. Shutdown waits for active work, the
post-run drain, component/worker disposal, the persistence queue, and finally releases the writer
lock.

```text
active run
  └─ model calls extension_define/run/stop
       └─ durable tool checkpoint
       └─ durable extension/intent-scheduled
       └─ tool result: scheduled-for-next-turn
  └─ operation_finished becomes durable
  └─ postRunDrain closes admission
       └─ apply queued lifecycle intents
       └─ append lifecycle receipts
  └─ next run snapshots the new graph surface
```

## Failure boundaries

- **Persistence failure:** an acknowledged mutation is fsynced; failed append rolls back before
  in-memory adoption where the owning subsystem can do so.
- **Extension activation failure:** buffered contributions are discarded and the worker is
  terminated.
- **Extension handler timeout:** cooperative abort is sent first; the parent terminates the worker
  after grace and removes contributions.
- **Component replacement failure:** candidate state is disposed and the previous graph is
  reactivated.
- **Malformed session:** query and viewer report corruption; neither repairs it. Writable open owns
  final-tail repair.
- **Shutdown failure:** cleanup errors are aggregated, but storage drain/close and lock release are
  still attempted in order.

## Trust boundaries

- The CLI/public runtime is the only writer path.
- The web server is an unauthenticated read-only observer and binds to loopback unless explicitly
  overridden.
- Session query reads cold files without acquiring writer locks.
- Extension workers isolate lifecycle and event-loop failure, not malicious privileges.
- Dynamic source, prompts, tool arguments, and model output are session data and may be visible in
  the raw ledger. Credentials are applied only at the live provider boundary.
