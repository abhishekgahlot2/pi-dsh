# pi-dsh build plan

Audit-verified plan (two workflow audits over both codebases, live pi-ai/OpenRouter test,
adversarial verifier). Scaffold is done: submodules pinned, `vendor/pi` (34 files) compiles,
deps installed, AGENTS.md/CLAUDE.md in place.

## Decision 0 — the store (verifier: "must be decided before any code")

**Pi's v4 session store is canonical.** Entries-only on the built-in `main` lane, plus
`operation_started`/`operation_finished` records as turn-commit boundaries (they are the
natural port of dsh's turn/end crash seam and cost nothing to adopt).

Why not a dsh-shaped linear log: Pi v4 is conformance-tested (30 cases), `CustomEntry
{customType, data}` already carries `constraint/add`, `constraint/revoke`, and
`request-header` with zero schema surgery, and fork/tree come free. A hybrid is the
verifier's #1 risk (split-brain persistence) — so: one store, Pi v4, full stop.

## Decision amendment (2026-08-17) — adapter-first, no Cordis runtime

The dsh behaviors are wanted; dsh's dynamic component platform is not. pi-dsh composes
Pi through explicit TypeScript interfaces and adapters. Vendored Pi remains pristine and
the engine stays constructible and testable without a container, loader, or plugin lifecycle.

- **Replaceability:** provider, tools, execution environment, and store are constructor
  inputs. Changing a composition is an edit plus restart. A runtime registry may be added
  later only if a demonstrated use case requires live replacement.
- **Direct durability:** adapter-to-store writes are awaited calls. Domain persistence never
  traverses an event bus.
- **Ordered shutdown:** stop admission → abort the turn → drain loop and persistence → close
  store and release its lock.
- **dsh boundary:** dsh contributes failure semantics, specifications, and test intent only.
  Its Cordis fork, profiles, bundles, HMR, and event vocabulary are not runtime dependencies.
- **Request snapshots:** every request records the effective provider and ordered tool schemas,
  independent of any future composition mechanism.

**Vendor stays pristine.** All fsync/timeout surgery lives in `src/` as subclasses/wrappers
(`src/env.ts` extends NodeExecutionEnv adding `syncFile`/`syncDir` via FileHandle.sync;
`src/persistence.ts` wraps the vendored JSONL storage so every append is write→fsync with
rollback, atomic first publication, plus a pid lockfile with stale detection for the
single-writer guarantee).

## Stages

### Stage 0 — Specs (~half day)
`spec/durability.md`, `spec/repair.md`, `spec/compaction.md`, `spec/constraints.md` —
numbered rules extracted from the audit dossier (each cites dsh file:line provenance).
Key rules already extracted: repair's NOT_STARTED vs OUTCOME_UNKNOWN split is only sound
if the log is flushed BEFORE each tool body runs → `beforeToolCall` is a mandatory fsync
checkpoint; compaction must use ONE token estimator on both sides of the non-shrink check.

### Stage 1 — Durable store (~1 day)
- `src/config.ts` — model/baseURL/key from env (`PIDSH_MODEL`, `OPENROUTER_API_KEY`),
  `~/ai_keys_loop` fallback. No model names in code or docs.
- `src/env.ts` — NodeExecutionEnv + syncFile/syncDir; bash default timeout 120s (cap 600s)
  + SIGTERM→2s grace→SIGKILL escalation (dsh `bash-local` semantics), as overrides.
- `src/persistence.ts` — fsync-wrapped v4 JSONL store + lockfile.
- Verify: vendored conformance suite (30 cases) green against the wrapped store + new
  crash file (kill -9 during append; torn-tail injection; fsync-order assertion).

### Stage 2 — Loop adapter + public API (~1 day)
- `src/api.ts` — the outer surface (verifier: currently undefined):
  `createSession/openSession → { prompt, steer, followUp, abort, resume, subscribe }`.
- `src/adapter.ts` — drive `runAgentLoop`/`runAgentLoopContinue` DIRECTLY with an awaited,
  try/catch-wrapped emit that appends+fsyncs before returning — the loop awaits every
  emit, so this gives **per-message durability with backpressure** (audit-verified).
  NEVER the `agentLoop()` EventStream iterator (fire-and-forget, no .catch — verifier risk #2).
  Capture points: `message_end` (canonical, one per model-visible item), `turn_end`
  → `operation_finished`; loop boundaries map onto Pi's EXISTING records
  (`operation_started/finished`, `step_attempt`, `tool_started` with `resultEntryId` +
  replay class, durable steer/follow-up queue records) — no invented event types.
  Request snapshot is SEMANTIC and credential-free (Codex change #1): model identity +
  full ordered tool schemas + allowlisted sampling options; never apiKey/headers/env/
  callbacks; `onPayload` mutation forbidden. `prepareNextTurn` swaps captured by
  wrapping the callback.
- Verify: scripted session, kill mid-turn, resume equals derived state; request-header
  entry reconstructs what the model saw.

### Stage 3 — Repair on load (~half day)
- `src/repair.ts` — dsh R-rules keyed on v4 records: dangling toolCall ids → synthesized
  isError tool results, `OUTCOME_UNKNOWN` ("do not retry blindly") when operation records
  show the body started vs `NOT_STARTED` ("retry if needed") when not; drop/skip trailing
  aborted/error assistant; then resume via `agentLoopContinue`.
- Verify: the 4 crash-race cases ported from dsh's repair.spec intent.

### Stage 4 — Compaction (~1 day)
- `src/compaction.ts` — closed-prefix, transactional: durable start marker, stability
  check serialized against the store's append queue, non-shrink rejection (same estimator
  both sides: provider usage tokens when present, chars/4 fallback), CompactionEntry with
  shadowed entry ids in `details` (provenance).
- **Constraint-eating bug (verifier risk #3):** the default context transform cuts
  everything before the last compaction — constraints must be folded from the FULL
  pre-cut branch (`findEntriesOnBranch`), never from post-cut transforms.
- Verify: race test (append during summarization ⇒ retry), non-shrink rejection,
  derive-after-compaction correctness, constraints survive compaction.

### Stage 5 — Constraints (~half day + benchmark)
- `src/constraints.ts` — `constraint/add`/`constraint/revoke` CustomEntries, last-wins
  fold over the full branch, deterministic prompt section injected every request.
- Fork semantics (Codex change #3): default "fork latest" uses `scope: "tree"` (custom/
  compaction leaves reject message-boundary forks); explicit forks use message entries;
  constraints remain entries so forks inherit them.
- Verify: kill-criterion benchmark — 3 constraints × 5 temptation tasks × 10 runs,
  on/off, via OpenRouter (configured model). Success = violations ≈ 0 with constraints on.
  Plus `default_fork_after_constraint_and_compaction` and
  `request_snapshot_redacts_credentials`.

### Stage 6 — Turn runner + CLI (~half day)
- `src/turn-runner.ts` — pi-ai discipline from the live test: api-level `stream()` with
  hand-built Model (compat auto-detected from baseUrl), `maxRetries: 0` + wrap in
  `retryAssistantCall`, check `isContextOverflow` BEFORE retry, treat
  `stopReason==='error' && /^No API key/` as fatal-config (abort session, not turn).
  Remember: `result()` NEVER rejects — always check stopReason before logging a turn.
- `src/main.ts` — minimal REPL: prompt → stream → tools → print; `--resume`.
- Verify: live smoke — real session: tool round-trip, constraint added, compaction
  forced, constraint still obeyed, kill -9 + resume.

### Stage 7 — Trajectory web UI (~2 days)
Goal: dsh's "every run is traceable" view for OUR sessions, so dsh and pi-dsh are
comparable side by side on the same task.
- **Why not copy dsh's web app:** `apps/web` is a component-platform browser application bound to
  dsh's server API and event vocabulary — vendoring it drags in the full dsh runtime
  plus a protocol our v4 store doesn't speak. We replicate the DESIGN (MIT, credited in
  NOTICE), never the code.
- `web/server.ts` — read-only HTTP + SSE over our store: list sessions, entries with seq,
  live follow (file watch).
- `web/app/` — single page: turn/tool timeline strip; source-badged event rows
  (SYSTEM / USER / CONTEXT / ASSISTANT / TOOL); right detail pane with
  Summary / Payload / Result / Schema / Timing tabs; search; Chat/Trajectory toggle;
  read-only live follow. Prompt controls remain CLI-owned: a second web-process writer
  would violate the single-writer contract, so a future control plane must attach to the
  running CLI rather than open the JSONL store independently.
- Verify: open a recorded session — every entry inspectable by source; live session
  follows < 1s behind; run the same task in dsh and pi-dsh and compare trajectories.

## Test ownership (verifier: previously unassigned)
- Stage 1 owns: conformance 30 + crash file (5) + fsync-order.
- Stage 3 owns: repair races (4).
- Stage 4 owns: compaction transaction (3) + constraint-survival.
- Stage 6 owns: live smoke + benchmark harness.

## Implementation status (2026-08-17)

- **Engine, CLI, and trajectory viewer complete:** Stages 0-7 are implemented through explicit adapters; vendored
  Pi remains byte-synced from upstream and dsh remains specs/test intent only.
- **Verified locally:** strict typecheck plus 93 tests, including all 30 vendored Pi backend
  conformance cases, fsync/rollback/torn-tail/lock tests, four repair races, transactional
  compaction, durable constraints, request redaction, queue records, ordered shutdown, read-only
  log projection, corrupt/torn-tail presentation, safe HTTP routing, and live SSE cleanup.
- **Deferred validation:** the paid 150-run constraint benchmark and live OpenRouter smoke are
  not run automatically. They require an explicitly selected `PIDSH_MODEL`, incur external cost,
  and remain the product-quality gate rather than a local correctness gate.
- **Delivered product layer:** `npm run web` serves the dependency-free, read-only Stage 7 UI:
  session archive, Chat/Trajectory views, searchable typed event rows, exact payload/schema/timing
  details, tool/run correlation, integrity warnings, and sub-second live invalidation. Automated
  HTTP/SSE/static checks are green; screenshot-based browser QA remains unverified because no
  controllable browser was connected in the implementation environment.
- **Known portability gap:** command timeout defaults to 120 seconds and rejects values above
  600 seconds. Pi's current Node environment kills its process group directly; a two-second
  SIGTERM grace would require replacing that shell runner, which is rejected here because it
  would duplicate and drift from Pi's process implementation.

## Standing risks
1. npm pi-ai dist ≠ repo src at same version — trust the installed package; verify
   behaviors against `node_modules`, never against `/tmp/pi-src` line numbers.
2. Any config callback that throws voids loop guarantees — every callback we register
   is try/catch-wrapped at registration.
3. Vendor drift — `npm run sync` + conformance suite on every submodule bump.

## Background & decision record (why this project exists)

- **Origin:** deep comparative audit of Pi vs dsh (two multi-agent workflows, a red-team
  capability matrix, two Codex reviews, one debate). Conclusion: Pi ships the proven
  surface but its event-sourced harness is an unwired stub covering ~35-40% of dsh's
  session layer (storage substrate mostly present; semantic layer — fsync, invariants,
  transactional compaction, semantic repair — absent). dsh ships the engine but its code
  is unvendorable (privately renamed Cordis fork wired via workspace overrides).
- **Why Pi doesn't just use Cordis:** nothing technical stops it; adopting a DI/effect
  framework would invert Pi's core identity (plain-TS extensions, framework-free,
  readable in an evening) and solve problems Pi deliberately avoids having (hot
  unload — Pi's answer is restart). Hence this repo: Pi's parts, dsh's behaviors.
- **Both forks maintained:** `upstream/pi-mono` + `upstream/deepseek-harness` as pinned
  submodules; `vendor/pi` machine-synced (`npm run sync`, SHA in UPSTREAM.json); dsh
  contributes specs only.
- **The one novel feature:** durable constraints ("never use library X" survives every
  compaction by construction). Kill criterion: the Stage 5 benchmark — if constraint
  violations don't drop to ≈0 with the feature on, the feature failed.
- **Success metric for the whole harness:** run the same task in dsh's web UI and
  pi-dsh's trajectory UI (Stage 7) and compare — traceability, resume-after-kill,
  constraint adherence. If pi-dsh isn't visibly better for personal daily use than
  stock Pi, fold the learnings back and stop.
- **Live-verified foundation:** pi-ai@0.84.2 (npm) against OpenRouter — streaming, tool
  round-trip with parsed arguments, error semantics (`result()` never rejects) all
  confirmed by real calls before this plan was written.

## Day schedule
- Day 1: Stage 0 (specs) ✅ DONE 2026-08-17 — spec/{durability,repair,compaction,constraints}.md
  written from dsh source (58 numbered rules, ~40 citations spot-verified, verifier-approved
  with all corrections applied incl. the blocking one-open-operation-per-lane bracket fix)
  + Stage 1 (durable store).
- Day 2: Stage 2 (adapter + public API).
- Day 3: Stage 3 (repair) + start Stage 4 (compaction).
- Day 4: finish Stage 4 + Stage 5 (constraints + benchmark).
- Day 5: Stage 6 (turn runner + CLI) + live smoke.
- Days 6-7: Stage 7 (trajectory web UI) + side-by-side comparison vs dsh.

## Codex review — VERDICT: APPROVE WITH CHANGES (2026-08-17, via codex CLI, code-verified)

Required changes, all incorporated into the stages above:

1. **Semantic, credential-free request snapshot (Stage 2).** "Request equivalence" means
   the semantic Pi boundary — Model identity, Context, allowlisted generation options,
   and the COMPLETE ordered tool descriptions + parameter schemas (tool names are
   insufficient). pi-ai Model/request options can carry apiKey, headers, env overrides,
   callbacks — none may ever enter the log. `onPayload` payload mutation is forbidden in
   this harness (byte-level wire reconstruction is explicitly outside the contract).
   Required test: `request_snapshot_redacts_credentials` — sentinel keys/headers must
   appear nowhere in JSONL while the snapshot still reconstructs model/provider/system
   prompt/messages/tool schemas/sampling.
2. **Use Pi's existing record vocabulary; invent nothing (Stages 2-3).** Pi already has
   `operation_started`/`operation_finished`, `step_attempt`, `tool_started` (with
   effective arguments, expected `resultEntryId`, and replay classification), and durable
   steer/follow-up queue records (`vendor/pi/harness/session/types.ts:87`). Loop
   boundaries map onto these; repair correlates `step_attempt.resultEntryId` and
   `tool_started.resultEntryId` against durable entries. No custom `turn/start`,
   `step/start`, `tool/call` events "to resemble dsh".
3. **Fork claim REFUTED — design change (Stage 5).** Pi's default branch fork requires a
   MessageEntry leaf and rejects custom/compaction leaves (`state.ts:267`, conformance
   case at `conformance.ts:1009`) — so a constraint or compaction entry at the leaf
   breaks default forking. Fix: default "fork latest" uses `scope: "tree"` under our
   single-main-lane contract (after confirming no open operation); user-selected forks
   use explicit message boundaries; constraints stay ENTRIES (fork copies entries,
   intentionally omits records — `conformance.ts:891`). Required test:
   `default_fork_after_constraint_and_compaction`.

## Review status
- Ralph architect review: **APPROVED** after two blocker-fix iterations. The final review
  verified automatic threshold/overflow compaction, durable-progress retry gating, default
  tree forks, projected-context token estimation, callback isolation, vendor byte identity,
  and the complete local suite.
- Both audit workflows complete; verifier's 5 risks and 9 gaps are all addressed above.

The engine/CLI increment is complete. The trajectory UI and paid/live validation remain the
separate deferred work described above. Nothing committed until you say so.
