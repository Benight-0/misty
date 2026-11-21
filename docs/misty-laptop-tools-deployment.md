# Laptop tooling deployment — 24 October 2026

The direct tooling layer is installed on the existing laptop and VM. Misty's
existing owner agent receives the named MCP tools; there is no Cline model loop
or new editor session. Its verified model is `gpt-6.1-sol`, reasoning `low`.

See [tools, usage, boundaries and controls](misty-laptop-tools.md). Initial enabled
workspace is `C:\Users\Public\Downloads\misty`. Commands run as the normal
Windows user; this is not an OS sandbox. Browser click/type/DOM control is outside
this implementation; the fetch tool performs HTTP reads only.

## Evidence

- Supported restart log: `restarting for an update: Load direct laptop tool
  instructions; keep current owner state`. New bot process PID `336948`, started
  `2026-10-24T17:49:04.560Z` (23:19:04 IST), after the new instructions were installed.
  The supervisor PID remains `158873`; it is not the bot child PID.
- Live Codex MCP config inspection accepted `misty_laptop`, stdio transport,
  70-second tool timeout and the real owner provenance environment names.
  MCP initialize/list succeeded with all nine names, and authenticated status
  reported the laptop online. No LLM run or editor session was started to test this.
- VM service `misty-laptop-tools` listens only on `127.0.0.1:8798`. The existing
  paired worker uses SSH and separate existing worker/reader credentials.
  A real MCP task-start attempt without a recorded owner ID was rejected.
- One explicitly labelled deployment fixture was queued in the new tooling DB;
  it did not fabricate a Discord owner message or change production admission.
  Operation `6f32ef96-fc14-4033-8f06-5ba3f6ba97a8` read only the generated
  `tooling/laptop-tools-smoke.txt`. VM queue time was
  `2026-10-24T17:53:16.809Z`; acknowledged receipt time was
  `2026-10-24T17:53:19.900Z`. The file body and SHA-256 matched, and the same saved
  result was retrieved through Misty's authenticated MCP reader at
  `2026-10-24T17:53:23.079896Z`. The fixture file was then removed; receipts remain.
- **89 checks passed:** 13 new primitive/broker/transport checks; 14 Python MCP,
  agent/session and personal-message regression checks; 62 existing Node relay and
  personal-message/server-send regression checks. No live contact messages or
  test DMs were sent. All 18 vendored source hashes match the pinned Cline commit.
- The Windows scheduled task `Misty Laptop Tools` is running with `IgnoreNew`;
  exactly one worker was observed. Its launcher is a GUI-subsystem executable
  (PE subsystem 2). The existing activity and Codex relay tasks remain running.
  Misty, Apollo, archive website, activity and bridge services all checked active.

Machine-readable evidence and changed-file hashes are in
`data/deployment/laptop-tools/manifest.json`, `deployment.json`,
`runtime-verification.json` and `live-fixture.json`. TAP evidence is retained as
`node-tests.tap` and `regression-tests.tap`. This workspace has no Git repository;
no push or publication occurred.

## Recovery

Production source/config snapshot:
`/var/backups/misty/laptop-tools-20261024T174831Z`.
Supported Python snapshot:
`/var/lib/misty-prominence/versions/20261024-174831`.
The backup includes a consistent copy of the new tools database with
`PRAGMA integrity_check = ok` and a checked `rollback.py` (dry run passed).

To disable laptop execution immediately, stop only the Windows task:

```powershell
Stop-ScheduledTask -TaskName 'Misty Laptop Tools'
```

Normal pause/resume/cancel controls are documented in the usage guide. If source
rollback is needed, an operator can run the backup's `rollback.py BACKUP` to
inspect first, then use `--apply` after stopping that Windows task. It refuses to
overwrite newer source, restores only affected source and the introduced config
key, disables only the new broker, and queues Misty's supported selfupdate
restart. It never restores an old journal/cursor/receipt, workflow or focus DB.
Do not use a blanket restore of the whole Python snapshot over newer work.
