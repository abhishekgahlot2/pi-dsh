# pi-dsh

A minimal personal coding-agent harness: Pi's agent loop and tools on top, a dsh-grade
event-sourced session engine underneath, and durable constraint events as the one novel
feature. The model is configuration (`PIDSH_MODEL` env var / `src/config.ts`), never
hardcoded and never named in docs.

## The contract (read before changing anything)

This harness makes deliberate, documented trade-offs. Do not "fix" them silently:

- **The session log is authoritative at turn boundaries.** Within a turn, Pi's loop owns
  the in-memory message array and the log is write-behind. Crash mid-turn is handled by
  repair-on-load, never by trusting memory.
- **Single writer.** One process per session file. No lanes, no concurrent writers.
- **Compaction is closed-prefix only** with a stability check and provenance citations.
  No mid-history surface replacement.
- **Adapter-first composition, no plugin kernel.** Engine modules are plain framework-free
  TypeScript, constructed through explicit interfaces. Provider, tools, execution environment,
  and store are replaceable by changing composition and restarting. Persistence is a direct
  awaited call; shutdown is ordered (stop admission → abort → drain → close store). Cordis,
  dynamic loaders, profiles, and model-written plugins are outside the runtime contract.
- **The last line of the contract: pi-dsh earns existence only while it is a better Pi —
  never by becoming more dsh.** When in doubt, delete.
- **Constraints are first-class events** (`constraint/add`, `constraint/revoke`), folded
  into an active set and re-injected into every request as a deterministic prompt
  section. They survive every compaction by construction.

## Layout

| Path | What | Rules |
|---|---|---|
| `upstream/pi-mono` | Pi, pinned submodule | read-only reference; source of vendor sync |
| `upstream/deepseek-harness` | dsh, pinned submodule | read-only reference; **never vendor its code** — port failure semantics as tests |
| `vendor/pi/` | synced subset of Pi we compile | NEVER hand-edit; change the file list in `scripts/sync-vendor.mjs`, rerun it. Upstream SHA recorded in `vendor/pi/UPSTREAM.json` |
| `src/` | our engine: event log, persistence, repair, compaction, constraints, loop adapter | the only place we write real code |
| `web/` | read-only local trajectory viewer over Pi v4 JSONL | never opens writable session storage; HTTP/SSE server binds to loopback by default |
| `test/` | vitest; includes crash-injection tests ported from dsh's spec intent | a guarantee without a test is a wish |

## Commands

```sh
npm run check          # tsc --noEmit over vendor + src
npm test               # vitest run
npm run web            # local read-only session/trajectory viewer on 127.0.0.1:8787
npm run sync           # re-sync vendor/pi from upstream/pi-mono (updates UPSTREAM.json)
git submodule update --remote upstream/pi-mono   # bump upstream, then npm run sync
```

## Vendoring policy ("maintain both forks")

- Both upstreams live as pinned submodules under `upstream/`. Update them deliberately,
  one at a time, and re-run `npm run sync` + `npm test` before accepting a bump.
- Pi code is vendored (MIT, license retained at `vendor/pi/LICENSE`).
- dsh code is **never** vendored. dsh contributes failure semantics and test intent only.

## Secrets

`OPENROUTER_API_KEY` from the environment, or read `openrouter_key=` from
`~/ai_keys_loop`. Never commit keys. Never print keys in logs or test output.

## Conventions

- ESM only, TypeScript strict, Node >= 22.19 (vendored files use `.ts`-extension imports).
- 2026-standard TS/JS: `toSorted`, `structuredClone`, iterator helpers; no `var`, no CommonJS.
- Match vendored Pi style inside `vendor/pi`; match `src/` style in `src/`.
- Invariant comments and executable tests form the public behavioral contract.

## Engine build order

1. `src/env.ts` + `src/persistence.ts` + `src/repo.ts` — Pi v4 storage with dsh's
   durability discipline: write→fsync ordering, torn-tail
   scan+truncate+fsync on load, atomic first publication, and one writer lock.
2. `src/adapter.ts` + `src/request-snapshot.ts` + `src/api.ts` — drive Pi's loop directly,
   persist every model-visible item with backpressure, and expose the public session lifecycle.
3. `src/repair.ts` — interrupted-turn closers on load: interrupted tool
   call ⇒ "outcome unknown, do not retry blindly".
4. `src/compaction.ts` + `src/turn-runner.ts` + `src/summarizer.ts` — closed-prefix
   transactions plus threshold/overflow orchestration.
5. `src/constraints.ts` — constraint events, fold, deterministic prompt section.
6. `src/main.ts` — CLI REPL wiring loop + tools + pi-ai (openai-completions against the
   configured baseURL/model from `src/config.ts`).
