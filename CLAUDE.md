# pi-dsh

All project instructions live in AGENTS.md — read it first and follow it exactly:

@AGENTS.md

Claude-specific notes:
- Before touching `vendor/pi/`, stop: that tree is machine-synced (`npm run sync`).
- Treat executable tests and invariant comments as the public behavioral contract.
- Verification bar: `npm run check` and `npm test` must both pass before claiming done.
