# Cline-derived executor bundle

Upstream: https://github.com/cline/cline
Revision: `40c5d99031fe1128189c5b52e40638d2b7787754`
License: Apache-2.0, retained in `vendor/LICENSE`.
Original file hashes: `vendor/UPSTREAM.json`.

Vendored source files are unmodified. The local bundle build redirects shared
runtime, telemetry, file-index and result-cache imports to the narrow laptop
adapters. No telemetry, agent loop, model provider, editor UI or cloud connector
is included. Zod is bundled; esbuild is build-time only. Lockfile pins packages.

The build also adapts ripgrep invocation to exclude protected data/config/key
paths and includes the matched source line in results (upstream's JSON match
handler otherwise omitted it). These transformations are in `build.mjs`.

The external host adds canonical workspace/path checks, preimage hashes,
pre-write backups, authenticated dispatch, cancellation and durable receipts.
These checks do not turn ordinary user-level shell execution into an OS sandbox.
