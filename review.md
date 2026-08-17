# pi-dsh Core Problem Review

## Scope

Read-only architectural review of the current `plan.md`, project contract, behavioral specs, and implementation. This review deliberately excludes test-count and test-coverage analysis. The repository changed during the review; file references reflect the latest source read during the parallel review.

Material claims are labeled:

- **Evidence** — directly supported by repository artifacts.
- **Inference** — conclusion drawn from that evidence.
- **Unknown** — not established by the repository.

## Executive verdict

**The plan correctly identifies and largely implements a durable session-engine problem. It has not yet established a better coding-agent product.**

The strongest architectural decision is placing durability at Pi's awaited loop and tool-dispatch boundaries while retaining Pi v4 as the only session vocabulary. A second dsh-shaped engine would create split-brain persistence and duplicate the wrong layer.

The largest unresolved safety problem is external side-effect reconciliation. After a crash, the engine can prove that a tool started but cannot prove whether its side effect completed. Repair records that ambiguity honestly, but the only protection against duplicate execution is an advisory message to the next model. The runtime does not enforce an operator gate, status probe, idempotency key, or prohibition on replaying a `replay: "never"` call.

The novel durable-constraints feature is structurally persistent across compaction, resume, and default tree forks. It is not structurally authoritative: constraints are injected as an older ordinary user message, and the public API rejects the mid-turn updates promised by the specification.

## The core problem

The project is not fundamentally about adding an event log. Pi already has session entries, records, branches, operation brackets, tool correlation IDs, and context derivation.

The actual problem is reliable continuity across five failure boundaries:

1. A process can crash after a side-effecting tool starts but before its result is durably recorded.
2. A resumed provider conversation cannot contain dangling tool calls.
3. Compaction can remove instructions from model-visible history while those instructions must remain active.
4. A request cannot be audited unless the effective provider, prompt context, tools, and generation settings are reconstructable.
5. Concurrent writers or acknowledged-but-unsynced appends can make the persisted transcript diverge from the live loop.

**Evidence:** `spec/durability.md:14-98` defines append/fsync, rollback, atomic publication, torn-tail repair, pre-tool checkpointing, single-writer ownership, direct awaited persistence, and ordered shutdown. `spec/repair.md:17-40` defines the irreducible distinction between a tool that never started and a tool whose external outcome is unknown.

## Ranked findings

### 1. Pi v4 plus explicit adapters is the correct foundation

**Confidence: High**

**Evidence:**

- `plan.md:9-16` selects Pi v4 as the canonical store and rejects a hybrid log.
- `plan.md:18-34` keeps dsh's failure semantics while rejecting its Cordis/plugin runtime.
- `AGENTS.md:18-24` requires framework-free adapters and states that pi-dsh must remain a better Pi rather than become more dsh.
- Pi's existing vocabulary already includes operation boundaries, step attempts, tool-start records, result IDs, replay classes, and open-operation discovery: `vendor/pi/harness/session/types.ts:87-160,311-317`.

**Inference:** A second dsh-style session engine would duplicate Pi's transcript, tree, context, and operation semantics. The adapter approach adds only the missing guarantees at the boundaries where they matter.

### 2. The durable tool checkpoint is the essential invariant

**Confidence: High**

**Evidence:**

- `spec/durability.md:67-75` requires `tool_started` to be durable before the tool body executes.
- `src/adapter.ts:366-387` constructs and awaits the `tool_started` record.
- `src/adapter.ts:440-449` invokes the real tool only after that checkpoint resolves.
- `src/persistence.ts:423-440` appends, fsyncs, and rolls back before resolving a mutation.

**Inference:** This is the minimum boundary needed to classify a missing tool result honestly. Without it, the repair layer could incorrectly label an already-executed side effect as safe to retry.

### 3. Repair detects side-effect ambiguity but does not enforce safe recovery

**Confidence: High**

**Evidence:**

- `spec/repair.md:35-40` states that “tool body still running” and “tool completed but result append was lost” are log-indistinguishable.
- `src/repair.ts:17-23,136-158` synthesizes `NOT_STARTED` or `OUTCOME_UNKNOWN` model-visible results.
- `src/adapter.ts:124-135,184-200` resumes the model from the repaired transcript.
- The default replay classifier is `never`, but the current public runtime options do not expose a `replayForTool` composition input: `src/adapter.ts:51-52,98-100`; `src/api.ts:23-34`.

**Inference:** The engine restores a provider-valid conversation and describes uncertainty correctly. It does not prevent the resumed model from calling the same non-idempotent tool again.

**Unknown:** Whether configured models reliably obey the advisory warning under realistic pressure.

**Highest-priority architectural gap:** resumed `OUTCOME_UNKNOWN` calls need an enforced reconciliation boundary for non-replayable tools—operator confirmation, a tool-specific status probe, or an idempotency mechanism—rather than model compliance alone.

### 4. `src/persistence.ts` is a parallel storage backend, not merely a wrapper

**Confidence: High**

**Evidence:**

- `plan.md:36-40` describes the durable store as wrapping Pi's JSONL storage.
- `src/persistence.ts:188-442` independently implements load, publication, locking, mutation construction, queueing, state application, fork, append, fsync, rollback, and the `SessionStorage` surface.
- Vendored Pi retains its separate implementation at `vendor/pi/harness/session/jsonl/storage.ts`.

**Inference:** Pi's codec, state machine, session types, and loop remain canonical, so this is not a second session engine. It is nevertheless a second JSONL storage implementation that can drift whenever Pi changes storage behavior.

The plan should name this as the primary maintenance liability instead of calling it a thin wrapper.

### 5. Constraint survival is structurally sound

**Confidence: High**

**Evidence:**

- Constraints are append-only `constraint/add` and `constraint/revoke` custom entries: `src/constraints.ts:6-7,111-129`.
- Folding reads the full root-to-leaf branch rather than transformed model context: `src/constraints.ts:51-79,98-109`.
- Every provider call re-reads the current branch and folds constraints: `src/adapter.ts:435-466`.
- Compaction appends a summary entry without deleting the pre-cut entries: `src/compaction.ts:276-315`.
- Default public forks force tree scope: `src/api.ts:66-70`.
- Pi tree forks copy entries while preserving order: `vendor/pi/harness/session/state.ts:253-289`.

**Inference:** Given no intervening mutation, the active constraint set survives threshold compaction, overflow compaction, repair/resume, and default tree forks.

### 6. Constraint persistence is not constraint authority

**Confidence: High structurally; Medium behaviorally**

**Evidence:**

- `src/constraints.ts:83-87` renders constraints as an `AgentMessage` with `role: "user"`.
- `src/request-snapshot.ts:9-26` prepends that message to the transcript while leaving the system prompt unchanged.
- `spec/constraints.md:50-67` specifies deterministic rendering and per-request injection but no instruction-priority invariant.

**Inference:** A later conflicting user prompt has the same role and a more recent position. The architecture guarantees that the constraint is present, not that it outranks later temptation.

The planned adherence benchmark is therefore a product gate, not optional polish. Even a successful benchmark would measure model behavior rather than establish a structural priority guarantee.

### 7. Mid-turn constraint updates contradict the specification

**Confidence: High**

**Evidence:**

- K15 requires constraints added during an open operation to affect the next request: `spec/constraints.md:80-85`.
- `src/api.ts:192-204,212-231` calls `assertIdle()` from both `addConstraint` and `revokeConstraint`.
- `src/main.ts:65-77` waits for a complete prompt run before accepting another CLI command.

**Inference:** The current product cannot tighten or revoke a durable constraint between model/tool steps in one active run. This is a semantic contradiction in the novel feature, not a test-coverage issue.

Allowing mid-turn updates also requires an atomic rule for the current branch-read → fold → request-snapshot sequence in `src/adapter.ts:453-466`.

### 8. Proactive compaction underprices the effective request

**Confidence: High**

**Evidence:**

- Threshold pricing uses the derived transcript messages: `src/compaction.ts:68-80,226-233`.
- Constraints are added later by `src/request-snapshot.ts:15-17`.
- System prompt and complete tool schemas are also outside the transcript estimate.
- Overflow recovery is bounded and runs after the provider rejects the request: `src/turn-runner.ts:70-100`.

**Inference:** Large constraints, system prompts, or tool schemas can make the real request overflow while proactive compaction still believes usage is below its threshold. Because constraints themselves are intentionally uncompacted, overflow recovery may make no useful progress.

### 9. Request snapshots do not satisfy the written reconstruction contract

**Confidence: High**

**Evidence:**

- `plan.md:205-213` requires semantic request reconstruction including context/messages.
- `src/request-snapshot.ts:9-27` stores model identity, system prompt, tool schemas, sampling options, and the rendered constraint section, but not `effectiveContext.messages` or message IDs.
- User `prepareNextTurn` logic can change the in-memory request context before the provider call: `src/turn-runner.ts:48-68`.

**Inference:** The branch log may reconstruct a likely transcript, but it cannot prove the exact message array sent after arbitrary in-memory context preparation. The snapshot contract is stronger than the current payload.

### 10. The project currently delivers an engine, not “better Pi”

**Confidence: High**

**Evidence:**

- `AGENTS.md:3-5,23-24` defines a personal coding-agent harness whose existence depends on being better than Pi.
- `plan.md:117-132,182-185` defines the product proof through trajectory visibility and side-by-side comparison.
- `plan.md:146-151` explicitly defers both integrated live validation and the trajectory UI.
- `src/main.ts:44-79` is a readline loop that awaits the whole prompt and then prints one final assistant message; it does not render the live stream or trajectory.
- `src/tools.ts:33-39` ships read, bash, edit, and write.

**Inference:** The architecture may be a better session engine, but the delivered surface does not yet support the claim that it is a better daily coding agent. Most of the improvement is invisible without inspecting JSONL directly.

## Operational tradeoffs not bounded by the plan

### Synchronous durability latency

**Evidence:** Every mutation performs append → `syncFile` before resolving (`src/persistence.ts:423-428`). A model/tool cycle generates separate mutations for operation boundaries, request header, assistant attempt, messages, usage, tool start, and tool result (`src/adapter.ts:224-248,299-320,366-418,451-465`).

**Inference:** The design intentionally adds several serialized fsync waits to each model/tool cycle. No p50/p95 latency budget establishes whether this remains a better interactive Pi.

### Permanent log amplification

**Evidence:** A request header containing the effective model, system prompt, ordered tool schemas, options, and constraints is appended before every provider call (`src/request-snapshot.ts:20-26`; `src/adapter.ts:451-465`). Compaction appends a shadowing entry but does not reclaim physical history (`src/compaction.ts:276-315`).

**Inference:** JSONL size grows monotonically, with repeated tool schemas proportional to provider calls. No bytes-per-request or long-session storage budget is defined.

## Contract inconsistencies

1. **Write-behind wording:** `AGENTS.md:12-14` calls within-turn persistence write-behind, while the implementation deliberately awaits per-message fsync backpressure.
2. **Replay refinement:** `spec/repair.md` describes replay-safe refinement, but the public runtime does not expose the classifier and all tools default to `never`.
3. **Constraint ID reuse:** K7 permits re-adding a revoked ID, while K8 says text replacement uses a new ID (`spec/constraints.md:40-49`). The implementation permits reuse after revocation.
4. **Shutdown race:** `startRun` installs the abort controller before the adapter publishes an active run ID. A close in that narrow window can miss abort and wait for the full operation (`src/api.ts:167-182,212-223,246-252`). This is an availability problem; storage still drains before close.

## What is solved versus unresolved

### Solved structurally

- One canonical Pi v4 session vocabulary.
- Awaited durable operation and message boundaries.
- Durable checkpoint before tool execution.
- Torn-tail recovery and one-writer ownership.
- Provider-valid append-only repair.
- Closed-prefix compaction with retained provenance.
- Constraint survival across compaction, resume, and default tree forks.

### Unresolved

- Enforced reconciliation of unknown side effects.
- Authoritative instruction priority for durable constraints.
- Mid-turn constraint authoring.
- Effective-request token accounting.
- Exact semantic request reconstruction.
- Storage and fsync performance budgets.
- A user-facing trajectory that makes recovery understandable.
- Evidence that the complete harness is better than stock Pi in daily use.

## Smallest discriminating product proof

Run one recorded A/B workflow against stock Pi using the same model and repository:

1. Add one meaningful prohibition.
2. Execute a multi-tool coding task.
3. Force compaction.
4. Kill the process immediately after a non-idempotent tool is durably marked started.
5. Resume through the delivered CLI.

Capture only:

- Whether the task succeeds without violating the constraint.
- Whether recovery prevents blind replay rather than merely warning the model.
- Whether the recovery state is understandable without manually reading JSONL.
- Time to first visible output, total wall time, fsync count, and JSONL bytes added per provider request.

**Inference:** This single vertical scenario distinguishes a valuable product from a correct but invisible engine faster than building the deferred web UI or running a 150-case benchmark first.

## Final decision

**Approve the architectural foundation. Do not yet accept the claim that the core product problem is solved.**

The plan's durable-session mechanics are coherent and substantially aligned with the actual failure modes. The next architectural decision is not another engine stage. It is whether recovery and durable constraints become enforced user-facing behavior rather than advisory metadata supplied to the model.