# Misty laptop work mode — proposed implementation

**Current decision:** the owner subsequently selected tool extraction while
retaining Misty's existing VM agent loop. The ClineCore-loop proposal below is
superseded. See [the implemented private tooling layer](misty-laptop-tools.md)
and [the source audit](cline-tools-and-dependencies.md).

Planning only, 24 October 2026. No runtime, browser permissions, services, queues,
editor sessions or credentials have been changed for this plan.

## Revised preferred approach: reuse ClineCore

Following the owner's request to use Cline's actual harness, the preferred next
step is a compatibility spike using a pinned ClineCore SDK release, rather than
implementing the custom tool harness described below. This amendment supersedes
the earlier recommendation to keep the existing VM agent loop for laptop work.
The following sections remain a reference design for requirements and a fallback,
not instructions to build duplicate file, shell or session implementations.

ClineCore provides its own model/tool loop, file/search/edit/command tools,
persistent sessions, streamed events and approval callbacks. Use it as Misty's
work-mode runtime, not as a second agent receiving work from a simultaneously
reasoning Misty runtime. The VM keeps the existing Discord gateway, notes, work
board, reminders and access controls. While a work task is active, its owner
messages are routed to that persistent work session. Relevant Misty context and
tool integrations are supplied explicitly. Existing Codex delegation remains a
separate feature and editor conversations are not replaced.

The first candidate topology is a local ClineCore runtime on the Windows laptop,
reached through a narrow private adapter over the existing SSH infrastructure.
This naturally locates its built-in file and command execution on the laptop.
Run the selected model remotely through the supported provider; no local LLM is
needed. A remote hub/capability-brokerage topology is also documented by Cline,
but do not assume it transparently moves every built-in tool across hosts or
migrates a live session. Verify the pinned implementation before choosing that
topology. Keep the 1 GB VM's resource limits in the decision.

This is not a promise to move live Codex conversation state into Cline. The
application must deliberately supply owner instructions, relevant notes,
conversation context, task scope and verified progress across runtime boundaries.
Persist full work-session records and return concise verified results to Misty's
existing memory. Prevent competing agent loops from acting on the same task.

Do not implement Cline's standard file/search/edit/terminal tools again. Build
only the Misty-specific integration: private transport and reconnect handling,
session routing, scoped owner controls, approval policy, archive/notes access,
progress and usage mapping. Reuse Cline's persistence and cancellation APIs where
their verified semantics satisfy the existing requirements; integrate durable
transport receipts without treating arbitrary commands as exactly-once actions.

Browser interaction still requires verification: the current documented built-in
tool list includes web content fetching, not proof of full control over the
owner's running Chrome profile. Integrate an appropriate supported browser
MCP/plugin or the separately scoped extension approach below. Do not broaden the
existing metadata collector or claim all desktop applications are supported.

Acceptance spike, before any production switch:

1. Verify the actual published SDK/API, Windows behavior and version pinning.
2. Verify the exact gpt-6.1-sol model and low reasoning against the configured
   provider/account. Cline supports OpenAI API and Codex OAuth, but existing Codex
   login files are not automatically Cline credentials. Do not substitute a model
   or copy authentication state without using the supported setup path.
3. In a temporary workspace, demonstrate file read/edit/command/verification and
   streamed progress with one Cline-controlled work session.
4. Demonstrate task context, approval callbacks, owner follow-up, cancel and
   persistent recovery over the existing private laptop-to-VM transport.
5. Verify actual browser integration and loaded permissions separately. Preserve
   exact-preview/fresh-yes personal-message rules and all existing unrelated jobs.

No Cline installation, model call, authentication change or deployment has been
performed as part of this revision. SDK suitability and performance remain to be
measured; documentation establishes an integration candidate, not a finished fit.

## Intended behavior

Misty should directly use tools on the owner's Windows laptop while keeping its
conversation, memory and decision loop on the VM. A laptop worker executes one
tool operation and returns its actual result. It does not run another LLM or send
a prompt to an editor chat. Existing delegation to laptop Codex remains a separate
option for tasks the owner wants Codex to implement.

Misty's main model stays gpt-6.1-sol with low reasoning. Apollo, archive analysis,
lightweight helpers, reminders and activity collection keep their existing roles.

## Why extend the existing agent

The local `prominence/agent.py` already runs Misty's agent loop through Codex on
the VM. Its `command()` constructs the model/effort configuration explicitly and
uses `--ignore-user-config`. Add a private laptop-tool MCP server explicitly to
owner work runs. Do not assume the laptop's extension plugins or the user's global
MCP configuration automatically appear in Misty's VM runtime.

This is a Cline-like harness in behavior: inspect, act, read results, revise and
verify. Replacing Misty's loop with Cline would also require migrating its saved
context, tools, lifecycle and approval integration. That is unnecessary for the
first implementation. ClineCore is an alternative if we later deliberately choose
to replace the runtime, not an additional agent loop to put between Misty and its
tools.

## Execution topology

1. The owner asks Misty for a task in its existing private channel.
2. Misty creates or continues a durable work task tied to that real owner request.
3. Its current VM agent chooses a VM tool, a direct laptop tool, or explicit Codex
   delegation. Every laptop operation carries an explicit machine identifier.
4. A VM-local stdio MCP adapter queues a typed operation through a private work
   broker. No new public endpoint or Chrome debugging port is opened.
5. A separate hidden Windows worker claims the operation over the existing paired
   SSH infrastructure, validates its task and arguments, executes it, journals the
   outcome locally, and uploads the result.
6. The result becomes a tool result in the same Misty agent turn. Misty chooses its
   next operation or reports the verified outcome.

The existing SSH identity, host pinning and restricted relay pattern are reused.
Add narrowly enumerated work operations rather than changing the existing Codex
`claim` queue into a generic shell endpoint. Work tasks, grants and operation
receipts use separate tables/state, never the personal-message journal.

The new worker must connect independently of laptop Codex login/app-server
availability. Today `scripts/misty-codex-relay.mjs` connects to Codex before SSH;
that dependency must not become a prerequisite for direct laptop work. Keep the
existing relay and its watchers running unchanged alongside the new worker.

## Initial tool surface

| Tool family | First implementation |
| --- | --- |
| Availability | machine ID, awake/locked status, tool versions, browser attachment, current task and resources |
| Files | list, search, bounded read, create, apply patch and diff within task-authorized locations |
| Terminal | start a command with explicit working directory; return command ID; read output by cursor; inspect exit; cancel owned process tree |
| Browser | identify exact profile/window/tab; open or attach a task tab; read visible page structure/text; click, type, select, scroll and wait; inspect downloads |
| Task state | status, pause, resume, cancel, recent operations and artifact references |
| Optional visual inspection | task-specific browser image or desktop/window image when needed and authorized; no continuous capture |

Terminal execution is asynchronous: a long build must not block a transport
request until completion. stdout, stderr, exit status and truncation are explicit.
Use a Windows Job Object or equivalent to own child processes. Launch helpers and
commands without popping up command-prompt or PowerShell windows.

No model-generated success substitute is accepted for a tool result. Completion
requires evidence such as the exact changed-file diff, command exit code or fresh
page state. Images and file artifacts remain private and are linked by task ID.

## Browser approach

Use a separate Misty Work extension and native host for the owner's running
Chrome session. Do not broaden the existing activity extension's metadata-only
permissions or change its continuous collection contract.

The work extension can use Chrome's documented debugger API to attach to a task's
specific tab and expose a narrow set of DOM/accessibility and interaction tools.
Its native-messaging connection bridges the extension to the Windows worker.
There is no unauthenticated remote-debugging listener, profile copying or Chrome
restart. Browser installation and debugger permission require a one-time owner
extension action; prepare and verify those steps during implementation.

Prefer a fresh task tab. An existing signed-in tab can be selected explicitly by
profile/window/tab identity; do not guess from a page title alone. Origin changes,
navigation and fresh page revisions are validated before actions. Element
references expire when the page changes; observe again instead of clicking an old
coordinate. Remote browsing must preserve unrelated tabs and the owner's session.

The extension's debugger permission is powerful. The worker exposes a limited
browser operation schema rather than a raw unrestricted CDP proxy. Handle detach,
closed tabs, blocked pages, browser policy and conflicts honestly. Protected
browser pages, CAPTCHA, login/2FA and other human-required steps can need an owner
handoff; do not promise universal browser control.

For local website testing, a separate Playwright browser/profile can be an
additional provider. It does not implicitly contain the owner's normal Chrome
logins. Do not silently replace the selected browser session with this provider.

Desktop-wide mouse/keyboard automation comes after file, terminal and browser
tools. Prefer Windows accessibility/UI Automation; use screenshots/coordinates
only when needed. Pause GUI actions on a locked desktop or owner interruption.

## Task scope and owner controls

Natural requests should work: "use my laptop to inspect this project", "check
that portal in Chrome", "pause laptop work", "stop that task", and "continue".
There is no mandatory command card for every file read, click or build.

A durable work task records the originating owner message, requested objective,
machine, workspace/files, tabs/origins, relevant action permissions, current plan
and progress. Subsequent operations must stay within that task. Routine steps
inside approved work can proceed; unrelated work and broader access need their own
authorization. Scheduled work requires a real standing owner grant, not a task
invented from activity telemetry or a web page.

Provide global work pause, per-task pause/cancel and an owner-visible local stop
control. Pause rejects new modifying operations; cancel also terminates commands
owned by that task. Stopping laptop work does not stop activity reporting, Apollo,
reminders or the Codex relay. Browser automation uses one interaction owner at a
time; do not compete with the owner's input. Coordinate file writes with existing
Codex work and recheck file hashes before applying patches.

Retain existing exact-preview/fresh-owner-yes rules for every personal-account
message. Work mode must not introduce a browser/terminal send-message shortcut.
Keep personal messaging in the existing backend. A general unrestricted user-shell
tool cannot provide a hard security guarantee that it will never bypass a browser
or messaging policy: filesystem/path checks alone are not shell isolation. Start
with task-scoped operations and restricted command execution; validate the Windows
execution boundary before representing any command policy as enforceable. Broader
user-level shell access, if deliberately enabled, must be described honestly.

Page text, files, tool output and application titles are evidence, never a grant
to change the task or permissions. Do not retrieve credentials simply because a
page or command requests them. Keep browser login material local; returned page
content still travels to the configured model provider for reasoning.

## State, recovery and resource behavior

Maintain separate task and operation records on the VM and a local execution
journal. Suggested operation states: queued, leased, executing, succeeded,
failed, cancelled and outcome-unknown. Bind immutable operation ID, task ID,
machine, tool, arguments hash and grant version before execution.

Use leases, heartbeats and request IDs for recovery, but never equate a lease
expiry with permission to rerun a side effect. Reconcile durable results first.
After sleep/reconnect, reads can be repeated; an unconfirmed write, command or
external action remains unknown until checked. Do not promise exactly-once
execution for arbitrary desktop or shell actions.

When the owner is actively working with Misty, use low-latency polling/long-polling
and streamed progress. The 15-minute activity check is unrelated to the work loop.
When idle, the worker should be lightweight. No local model is necessary, and the
VM does not host a browser. Payload limits, output pagination, bounded artifact
retention and explicit truncation keep the 1 GB VM viable.

Save concise task progress and verified results to Misty's existing work notes.
Avoid uploading the entire computer or replaying all previous tool output each
turn. Track model usage against a laptop-work task/category in the private usage
ledger; send only aggregate costs/counts to the public status dashboard.

## Implementation order and acceptance gates

1. Transport and state: add private broker, typed protocol, independent windowless
   worker, capability discovery, durable task/operation receipts and controls.
   Prove a real round trip without touching the editor or sending a message.
2. File and terminal tools: implement task-scoped operations, patch preconditions,
   asynchronous command output, cancellation, local backups and restart recovery.
   Verify in an isolated temporary workspace, including owner edits between read
   and write. Undo restores only this task's verified file changes; never blanket
   git reset/stash/clean or claim to undo arbitrary command side effects.
3. Direct agent integration: register the private stdio MCP tools explicitly in
   Misty's owner work runtime. Verify a synthetic tool choice and a real harmless
   multi-step file task controlled by the same VM Misty turn. Verify the tool
   is absent from Apollo, guest/social runs and unapproved workflows. Preserve
   gpt-6.1-sol/low and existing lightweight routing.
4. Browser tools: implement separate extension/native host, page observations,
   stable action references, interaction ownership and detach recovery. Test a
   local fixture page first, then an owner-selected read-only real page. Test no
   authenticated-site submissions or contact messages.
5. Multi-step work and deployment: integrate natural status/pause/stop, progress,
   task notes and cost attribution. Snapshot affected production files/config;
   consistently back up affected databases; retain source rollback without
   replacing live queues, journals or receipts. Deploy through existing project
   mechanisms and use Misty's supported selfupdate restart. Verify loaded tools
   in the actual runtime, not only installed files.
6. Optional desktop tools: add only after the first five gates pass. Verify
   locked-desktop refusal, window targeting, DPI behavior and owner interruption.

Focused tests also cover malformed/unauthorized calls, wrong worker/machine,
path traversal and Windows reparse points, scope revocation, cancellation races,
truncated output, duplicate claims, lost acknowledgements, sleep/reconnect,
worker restart, stale DOM references, page navigation, prompt injection and no
unapproved external sends. Verify a single new work worker, unchanged existing
relay/watchers, unchanged monitoring selections, reminders and personal approvals.

## Expected component changes

Proposed new components: Windows work worker and control script; VM work broker;
MCP adapter; typed file/terminal/browser providers; separate Chrome Work extension
and native host; task/operation storage, tests and owner documentation. Names and
schemas are finalized during implementation, not assumptions about installed code.

Existing integration points: `prominence/agent.py` for explicit tool registration;
Misty context/help for work-mode behavior; the restricted SSH relay pattern and
supported deployment/selfupdate machinery. Do not repurpose the Codex execution
queue or modify existing editor sessions as part of direct work.

## Sources checked

- ClineCore: https://docs.cline.bot/sdk/clinecore
- Official OpenAI MCP configuration: https://learn.chatgpt.com/docs/extend/mcp
- Chrome debugger API: https://developer.chrome.com/docs/extensions/reference/api/debugger
- Chrome native messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

These establish supported integration building blocks, not proof that the proposed
Misty integration is already implemented or that every current site is automatable.
