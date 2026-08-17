# Host self-extension

Self-extension lets the model propose a temporary host tool or prompt contribution for the current
process. It is designed around four separate decisions:

1. **Define** — validate source and create an immutable revision after the current run.
2. **Inspect** — review purpose, manifest, revision, source hash, trust statement, and status.
3. **Approve** — a human authorizes exactly one `{ session, extension, revision, hash }` tuple.
4. **Run** — start the approved revision in its own worker and publish contributions only after
   successful activation and exact manifest verification.

Definition is never implicit approval, and approval is never implicit execution.

## Source contract

Source must be exactly one async function expression:

```js
async (ctx) => {
  // register contributions
}
```

A parenthesized expression is also accepted. Modules, imports, exports, multiple top-level
expressions, and non-async functions are rejected.

The activation function must resolve `undefined`. Registrations are buffered transactionally;
nothing becomes visible if activation throws, times out, or registers a manifest that differs
from the reviewed declaration.

## Activation API

### `ctx.registerTool(manifest, handler)`

```js
ctx.registerTool(
  {
    name: "normalize_issue",
    description: "Normalize one issue object",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        severity: { type: "string" }
      },
      required: ["title", "severity"]
    }
  },
  async (args, { signal, toolCallId }) => ({
    id: toolCallId,
    title: args.title.trim(),
    severity: args.severity.toLowerCase(),
    cancelled: signal.aborted
  })
)
```

Arguments and call context are frozen. Results must be JSON-serializable. Extension tools do not
receive a streaming update callback.

### `ctx.registerPrompt({ id, text })`

Registers static prompt text for later requests. Prompt contributions are snapshotted together
with tool schemas, so stop/update cannot mutate an already assembled request.

### `ctx.querySession(request)`

Read-only access to the same bounded causal query service used by model-facing tools:

```js
const result = await ctx.querySession({
  action: "search",
  text: "release decision",
  limit: 8
})
```

Actions are `search`, `window`, `trace`, and `lineage`.

### `ctx.now()` and `ctx.id()`

Host-provided time and stable extension identity helpers.

## Manifest

`extension_define` also receives a manifest describing every expected tool and prompt. Activation
must register exactly those names and ids—no missing, extra, or duplicate contribution is accepted.
Base coding tools, session-query tools, and lifecycle tools are reserved and cannot be replaced by
an extension.

## Lifecycle timing

Model lifecycle tools run inside an active operation. They therefore append a directly correlated
`extension/intent-scheduled` receipt and return `scheduled-for-next-turn`. The source/tool-call
message is durable, then `operation_finished` becomes durable, then the session closes admission
and applies queued intents.

Human/API lifecycle methods are immediate but idle-only. CLI commands:

```text
/extension inspect
/extension approve <id> <revision> <source-hash>
/extension run <id> <revision>
/extension stop <id>
/extension rollback <id> <revision>
/extension remove <id>
```

Updates create new immutable revisions. Rollback runs a previously approved revision. Remove stops
the worker and forgets all process-local revisions; durable historical receipts remain.

## What is durable

Durable:

- the assistant tool call, including submitted extension source;
- lifecycle intent, approval, start, stop, update, rollback, removal, and failure receipts;
- extension id, revision id, source hash, action, direct run id and tool-call id correlation;
- contributed tool calls and results while the extension is active.

Process-local only:

- executable definition registry;
- approval state used for future execution;
- worker and registered handlers;
- active tools and prompt contributions.

Resume does not restore or run extension code.

## Execution and trust

Each active revision owns one `node:worker_threads` worker. The worker evaluates source through
`node:vm`, communicates through validated request ids, and buffers registrations until activation
passes. The parent owns wall-clock activation, handler and disposal deadlines. It first sends a
cooperative abort, then terminates a stuck worker after the grace period.

This prevents a synchronous infinite loop from freezing the main agent process. It does **not**
make approved code safe against a malicious author. Approved JavaScript is trusted local code,
comparable to granting Bash or a powerful local tool. Worker and VM boundaries are lifecycle
containment, not a secrets or privilege boundary.

Browser/client JavaScript extensions are intentionally unsupported.
