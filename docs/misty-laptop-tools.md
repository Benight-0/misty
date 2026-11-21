# Misty's private laptop tooling

Misty retains its VM agent, conversation, notes and configured model. A private
stdio MCP server exposes tools to Misty and delegated agents. The shared
browser/desktop session layer is described in [Misty shared tools](misty-shared-tools.md).
The existing laptop Codex chat relay remains independent.

## Implemented tools

| Tool | Behavior |
| --- | --- |
| `laptop_read_files` | Cline ranged/bounded file reads, with SHA-256 preimages; image/cache URI reads disabled |
| `laptop_search_codebase` | Cline regex search with ripgrep/fallback and actual matching text; mounted-drive mode includes hidden and previously excluded files |
| `laptop_run_commands` | Cline shell/direct-argv execution in the task workspace; Windows PowerShell syntax, hidden spawning, process-tree cancellation, bounded output |
| `laptop_fetch_web_content` | Bounded HTTP GET/text conversion; does not execute a second model or control Chrome |
| `laptop_apply_patch` | Cline patch parser/executor; verify preimage hashes for every source/destination; keep backups |
| `laptop_editor` | Cline create/unique-replace/line-insert editor, with preimage conflict checks and backups |
| `laptop_task` | Start a current owner work task, or control pause/resume/cancel |
| `laptop_status` | Private laptop freshness, enabled workspaces, task and operation states |
| `laptop_result` | Retrieve an existing operation receipt; never resubmit an uncertain side effect |

The six primitive implementations and schema/normalization helpers are adapted
from the pinned Cline audit. See [attribution and modifications](../tooling/cline/NOTICE.md)
and [the full reference](cline-tools-and-dependencies.md). Questions, skill
instructions and completion use Misty's existing host/conversation, avoiding
duplicate Cline UI callbacks or an agent-completing tool that ends the wrong run.
Team/connector/delegation tools and Cline's agent runtime are not imported.

## Private path

```text
Misty's existing Codex owner agent
    -> stdio MCP: /opt/misty-prominence/laptop_tools.py
    -> authenticated 127.0.0.1:8798/call on VM
    -> durable task/operation broker
    <- paired Windows worker polls over existing authenticated SSH infrastructure
    -> Cline-derived executors on laptop -> persisted receipts -> same agent
```

The service binds only VM loopback. The existing Cloudflare routes/public metrics
do not expose it. The reader credential can request owner-scoped work; the separate
paired-worker credential can claim and acknowledge operations, not authorize new
work. Tokens never appear in arguments, tool results or status. Apollo has no tool
registration/credential path here. Guest/social runs and workflows do not receive
the MCP server. Broker admission independently checks a current recorded owner
request or an active delegated agent task; title/page/file/model text cannot
supply either authority.

Windows Task Scheduler runs **Misty Laptop Tools** at logon, as the normal owner
user, using a GUI-subsystem launcher and a kill-on-close Windows Job Object. Child
commands use hidden process spawning. Existing activity/Codex tasks are not changed.

## Work scope and usage

The active `data/deployment/laptop-tools/roots.json` uses `{"scope":"all-drives"}`.
The paired Windows worker discovers mounted drive roots at runtime and currently
advertises `C:\`, `G:\` and `H:\`. Misty can choose any working directory on an
advertised drive; direct file tools can use absolute paths anywhere the logged-in
Windows user can access. The model cannot change the drive catalog. Each task has
an objective, workspace or VM browser location, verified origin, explicit
write/command/action flags and six-hour expiry. New calls must remain within
that task's verified authority.

Laptop operations queue directly for the paired worker without a per-operation
model review or approval code. The broker still requires a recent verified owner
request and a task with the needed write/command flags. Misty's prompt tells it
to ask before deleting unspecified targets or running actions likely to
materially damage the computer or data. The same prompt applies to its native
VM tools, described in [the owner loop](misty-owner-loop.md).

Natural owner requests can be: “use the laptop tools to inspect this project”,
“fix this file locally and run its checks”, or “pause laptop work”. Misty first
uses status, starts a scoped task, executes named tools and reports actual receipts.
No mandatory Codex command card is added to this direct tooling path.

Example tool arguments (IDs are placeholders):

```json
{"action":"start","objective":"Inspect the requested project","workspace":"C:\\Users\\Public\\Downloads\\misty","write":false,"commands":false}
```

```json
{"task_id":"TASK-ID","files":[{"path":"README.md","start_line":1,"end_line":40}]}
```

Write calls additionally require `expectedHashes` for **every** changed path;
`null` explicitly means the file did not exist. Use hashes from a fresh read.
Existing files are copied to private preimages before execution. Patch application
is not a multi-file transaction and timed-out writes can have unknown outcomes.
Preimages assist manual rollback; they are not automatically restored over
later owner edits.

Misty can also read/control through its existing Python tool environment:

```text
python3 /opt/misty-prominence/laptop_tools.py status
python3 /opt/misty-prominence/laptop_tools.py result OPERATION-ID
python3 /opt/misty-prominence/laptop_tools.py pause [TASK-ID]
python3 /opt/misty-prominence/laptop_tools.py resume [TASK-ID]
python3 /opt/misty-prominence/laptop_tools.py cancel TASK-ID
```

Controls require the current real owner request. Cancellation is final for that
task; start a new task if needed. Global pause suppresses only laptop tool work,
not activity sampling, Apollo, reminders or Codex chat jobs. A local immediate
stop is `Stop-ScheduledTask -TaskName 'Misty Laptop Tools'`; restarting that task
recovers receipts and marks interrupted work unknown rather than replaying it.

## Recovery, limits and privacy

- Task and operation IDs/digests bind immutable arguments. The VM never leases a
  started operation twice. The laptop records execution before starting and
  returns stored results on duplicates. Reconnect uploads saved receipts first.
- Queue expiry, pause, cancellation and unknown states are explicit. A lost result
  or three-minute execution lease does not justify repeating a command or write.
  `laptop_result` reads the same operation. A late real receipt may resolve unknown.
- Results/backups normally retain seven days. Unresolved receipts and undelivered
  results are not silently pruned as successful work. Output caps and bounded
  batches apply; the model must page/narrow large requests.
- File APIs in mounted-drive mode accept paths outside the working directory,
  including hidden/configuration files, subject to the logged-in Windows user's
  permissions. Cache URIs remain unsupported. No images, clipboard, input capture
  or page-body telemetry has been added to the existing activity collector.
- **Shell execution is trusted user-level execution, not an OS sandbox.** A program
  can access resources beyond its working directory. The prompt is guidance,
  not a technical block. Misty's role forbids using
  scripts to bypass personal-message rules.
- All personal-account messages still require the existing exact delivered
  preview and fresh owner yes. This interface adds no message send/approve tool.
- Browser and desktop access uses durable sessions, restricted action batches,
  and separate Windows/VM workers. See [shared tools](misty-shared-tools.md).

## Build and verification

```powershell
npm.cmd ci --prefix tooling/cline --ignore-scripts --no-audit --no-fund
node tooling/cline/build.mjs
node --test app/tests/laptop-tools.test.mjs app/tests/laptop-tools-review.test.mjs
Set-Location prominence
python -m unittest test_laptop_tools -v
```

The private deployment report records live hashes, snapshot location, supported
Misty self-update request/result and real Windows-to-VM fixture receipts. Live
smoke fixtures are explicitly marked **deployment verification**, not fabricated
Discord owner messages or approvals. They perform only narrowly scoped fixture
operations; no DM, contact or server message is sent.

The MCP configuration follows [official OpenAI documentation](https://developers.openai.com/codex/mcp).
It is applied only to full owner turns through `agent.py`; model/effort settings,
existing session aliases and lightweight helper routing are preserved.
