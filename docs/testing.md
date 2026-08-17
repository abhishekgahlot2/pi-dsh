# Testing

## Complete local gate

```sh
npm ci
npm run check
npm test
npm audit
node --check web/app/app.js
git diff --exit-code -- vendor/pi
```

Expected at this revision:

```text
18 test files
138 tests passed
0 known dependency vulnerabilities
```

## Focused suites

### Durability and repair

```sh
npx vitest run \
  test/persistence.test.ts \
  test/repair.test.ts \
  test/conformance.test.ts
```

### Compaction and constraints

```sh
npx vitest run \
  test/compaction.test.ts \
  test/constraints.test.ts
```

### Components and self-extension

```sh
npx vitest run \
  test/component-kernel.test.ts \
  test/extensions.test.ts \
  test/self-extension-e2e.test.ts
```

These tests cover dependency cycles, reverse disposal, replacement rollback, approval binding,
transactional registration, receipt failure rollback, worker crashes, non-JSON results,
synchronous infinite loops, post-run drain, source durability, restart non-restoration, and the
complete define→approve→run→use→stop flow.

### Session query and web

```sh
npx vitest run \
  test/session-query.test.ts \
  test/session-query-integration.test.ts \
  test/web-server.test.ts
```

These tests cover citations, cursor binding, windows, causal edges, lineage, surfaces, corruption,
symlink refusal, path traversal, no-lock reads, CSP, remote-bind opt-in, SSE updates, and shutdown.

## Real-provider smoke test

After the local suite is green:

1. Start `npm start` with a low-cost configured model.
2. Ask it to call `extension_inspect`.
3. Ask it to define the deterministic `hello_ext` example from the README.
4. Run `/extension inspect` and verify source is redacted in live inspection but present in the raw
   assistant tool-call event.
5. Approve the exact revision/hash.
6. Ask the model to call `extension_run`.
7. In a later turn, ask it to invoke `hello_ext` and expect `hello <name>`.
8. Ask `session_search` for that name and require one `sessionId:seq:line` citation.
9. Stop the extension and `/quit`.

This verifies provider schema compatibility and model usability. It incurs provider cost and is
not part of the automated suite.

## Crash testing

Automated tests inject persistence failures and interrupted operation states without risking your
workspace. For a real process-kill smoke, use a disposable repository and a non-side-effecting or
idempotent tool. Killing a process during Bash may leave an operating-system child alive; inspect
process state before retrying.

The correct recovery result for a tool that durably started but lacks a durable result is
`OUTCOME_UNKNOWN`, not automatic retry.

## Viewer smoke

```sh
npm run web -- --port 0
```

Open the printed URL and check:

- session list and Chat/Trajectory tabs;
- category and surface filters;
- cross-session search citations;
- window and trace actions;
- extension lifecycle rows;
- payload/schema/timing tabs;
- live updates after a new CLI turn.

Automated tests cover DOM landmarks, scripts, CSS serving and API contracts. Screenshot comparison
requires a connected browser or a manual capture.
