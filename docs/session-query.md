# Session query and causal history

The trajectory viewer is for humans; the session-query tools make the same durable history useful
to the agent. Queries operate over live or cold Pi v4 JSONL files without opening writable storage
or acquiring writer locks.

## Citations

Every event result carries:

```json
{
  "sessionId": "01...",
  "seq": 42,
  "line": 43
}
```

`seq` is the durable monotonic event sequence. `line` is the one-based physical JSONL line, where
line 1 is the header.

## Surfaces

| Surface | Meaning |
|---|---|
| `current` | Entry remains on the model's current derived context surface. |
| `shadowed` | Entry was replaced by a compaction summary. It remains in the append-only log. |
| `log-only` | Operational fact retained for audit but not rendered as model conversation. |

Surface classification is not importance. A `tool_started` checkpoint is usually `log-only` but
may be the most important event during crash repair.

## Tools

### `session_search`

Search semantic event text across bounded session files. Filters include session id, cwd,
category, role, run id, tool-call id, extension id, corruption state, parent id, and surface.

```text
Find the session where we rejected Cordis. Return the strongest citations.
```

Results use query-bound opaque cursors. Reusing a cursor with different normalized query/filter
parameters is rejected.

### `session_event_window`

Read one event plus an exact number of preceding and following durable events:

```text
Read 3 events before and after session 01... seq 42.
```

### `session_trace`

Return direct metadata-backed relationships. Supported edges include:

- entry parent and children;
- operation start and run members;
- assistant tool request, `tool_started`, and result entry;
- queued/cancelled message target;
- compaction replacement, source, and derived event;
- extension intent, originating run/tool call, and lifecycle receipts.

The service does not invent a relationship from timestamps or textual similarity.

### `session_lineage`

Return known ancestors and descendants from `parentSessionId` headers. An absent parent is marked
unresolved rather than silently treated as a root.

## Bounds and corruption

Search is scan-first and bounded by session count, bytes, result count, snippet length, and query
length. Targeted reads reject session files above the bounded read limit. Session names use a
conservative id pattern, and symlinked session files are ignored.

A malformed interior JSONL line marks the session corrupt and stops projection beyond that line.
A final syntax-torn or newline-less record is reported as an uncommitted tail and excluded. Query
never truncates or repairs a file.

## HTTP API

The read-only viewer exposes the same service:

```text
GET /api/query/search?q=<text>&session=<id>&surface=<surface>&limit=<n>
GET /api/sessions/:id/events/:seq/window?before=<n>&after=<n>
GET /api/sessions/:id/events/:seq/trace
GET /api/sessions/:id/lineage
```

The server binds to loopback by default, applies a same-origin Content Security Policy, rejects
path traversal, and refuses non-loopback hosts without explicit `--allow-remote`. It has no
authentication; do not expose it directly to an untrusted network.
