# Architecture

pi-dsh keeps Pi's agent loop and Pi v4 session vocabulary, then adds three bounded runtime
capabilities: a replaceable component graph, a causal session-query service, and approval-gated
host self-extension.

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
