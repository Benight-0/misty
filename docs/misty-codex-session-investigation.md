# Misty and an already-open Codex chat

Investigated on 22 October 2026. Times below are Asia/Kolkata.

## Finding

The delay is not adequately explained by stale editor display alone. The VS Code
Codex process retains the selected conversation's writer lock while the chat is
open, including between completed tasks. Misty's separate app-server attempts to
resume the same conversation. The observed delay occurred before execution began.

The installed VS Code extension also has a local owner/follower connection that
can address the already-open conversation. A read-only probe successfully found
its live owner and read its model settings. This is a promising integration route;
submission and completion were not yet tested at the time of this investigation.
The follow-up implementation is now enabled and verified; see
[the live-session adapter](misty-codex-live-session.md).

## Evidence

### The last approved test

VM job `0f65e14ddd`, selected conversation
`01a11d07-06bc-7602-b904-31f486263e03`:

| Event | Time |
| --- | --- |
| Approved job created on VM | 22:35:35.542 |
| Codex persisted `task_started` | 22:42:23.526 |
| New VS Code log session | 22:42:28 |
| Reopened extension spawned its Codex process | 22:42:30.974 |
| Codex persisted `task_complete` | 22:42:35.942 |
| VM recorded completed result | 22:42:36.549 |
| Reopened editor resumed the chat and saw the completed test | 22:42:45.857 |

The task took about **12.4 seconds after execution began**, following roughly
**6 minutes 48 seconds before execution**. It was not spending those seven minutes
generating the answer. The timestamps closely match the user's report that closing
and reopening VS Code unblocked it.

The earlier test `28aee18653` was approved at 21:57:26.813, began at
21:59:49.275, completed at 21:59:54.687 and reached the VM at 21:59:55.689.
The corresponding editor log session began at 21:59:34.

Sources were queried read-only: the laptop relay journal, VM `relay_jobs`,
the selected conversation's persisted lifecycle events, and VS Code's Codex logs.
The relay does not currently preserve per-attempt resume latency/errors, so the
historical lock wait cannot be attributed to an individual RPC from its journal.

### Current lock owner

Windows Restart Manager identified process **40396**, the installed VS Code
extension's `codex.exe`, as holding:

```
C:\Users\Public\.codex\thread-writer-locks\01a11d07-06bc-7602-b904-31f486263e03.lock
```

This is distinct from Misty's separate Codex process, **46460**, launched by relay
process **55908**. Process IDs are observations from this investigation and change
when processes restart. No locks were removed and no processes were restarted.

The relay's persisted active-turn check is insufficient: a chat can have no active
turn and still have its writer lock held by an open extension session. The relay
also discards RPC errors in its outer reconnect handler, obscuring this wait.

A separate short-lived diagnostic app-server reproduced the rejection without
starting a turn: `thread/read` returned `notLoaded` in 1 ms, while `thread/resume`
returned this RPC error after 703 ms:

```
thread 01a11d07-06bc-7602-b904-31f486263e03 already has an active writer
```

The diagnostic process was then closed. No prompt or `turn/start` was sent. The
normal relay currently catches this error and reconnects after 15 seconds, so
repeated rejected resume attempts can appear as one long job wait.

### Installed integration surfaces

- Extension: `openai.chatgpt` version `26.51007.21434`.
- Bundled binary: `codex-cli 0.162.0-alpha.17.2`.
- Both the extension and Misty independently launch app-server over stdio.
- The extension's public commands and settings do not expose a documented exact
  prompt/existing-chat submission API or a shared-backend URL setting.
- Deep links navigate to a chat; they do not implement prompt submission.
- The installed binary has daemon/proxy commands, but the current extension starts
  its own stdio backend. Starting another daemon does not attach it to that backend.
- The installed extension exports activation/deactivation, without a public relay
  API in its exported surface.

### Local owner/follower connection

The installed extension uses the Windows named pipe `\\.\pipe\codex-ipc` for
coordination. Frames are a four-byte little-endian length followed by JSON.
Requests carry method versions; responses identify the handling client.

Two read-only probes succeeded:

1. `thread-owner-discovery`, version 1, for the selected local conversation.
   The live owner responded and advertised support for untrusted app input.
2. `thread-follower-read-model-settings`, version 1, targeted at that owner.
   Returned model `gpt-6.1-sol`, `resumeState: resumed`, `mode: default`, and
   `threadSource: user`.

The probe did not send a prompt, perform inference, change settings, claim
ownership, or replay any approved job. It ignored unrelated broadcast bodies.

Static inspection found these additional internal mechanisms:

- `thread-follower-start-turn`, version 2, forwards a prepared turn to the owner.
  The webview handler calls its existing `startTurn(conversationId, turnStart)`.
- `thread-stream-state-changed`, version 11, communicates snapshots/patches.
- Follower coordination, model-setting reads and per-client owner discovery.
- Prepared turns support client user-message identifiers for correlation.

These are **internal, version-specific interfaces**, rather than a documented
OpenAI integration contract. A successful settings query establishes live
connectivity; it does not establish correct prompt admission, live completion,
reconnect recovery, or compatibility with later extension releases.

## Recommended implementation

Keep the existing Discord draft, exact prompt/destination approval, durable VM
queue and laptop journal. Add a version-checked local session adapter:

1. For an existing chat, discover whether a live editor/app owns that exact chat.
2. If owned, bind to the identified owner and read its current state/settings.
   Validate the selected conversation and workspace; preserve its model settings.
3. Wait visibly when the owner is busy. Submit the unchanged approved prompt once
   through its prepared-turn route when idle, with a stable client message ID.
4. Follow that owner's state stream. Match the accepted input, thread ID and turn
   ID, and return only that turn's completed final answer to the VM.
5. Persist submission intent/receipts before acknowledging progress. On timeout,
   disconnect or ownership change, reconcile the stable input/turn receipt rather
   than sending again. Do not switch to another backend after an ambiguous send.
6. When no owner exists, retain the current app-server path, with a bounded resume
   attempt and explicit lock-wait status. A discovery result alone is not an
   atomic lock, so handle a new editor owner appearing during fallback.
7. Reject unsupported internal protocol versions with an actionable status.
   Do not patch the installed OpenAI extension or remove its writer locks.

Required verification before enabling the adapter:

- An idle, open test chat receives exactly one approved text-only turn; the
  running editor and Discord both show completion without reopening VS Code.
- A busy chat waits without interrupting or steering the owner's active task.
- Closing the editor before submission uses the ordinary backend safely;
  closing it during submission/execution never duplicates the request.
- Owner changes, lost callbacks, worker restarts and stale protocol versions
  preserve the exact selected chat and report uncertain outcomes honestly.
- Existing exact-preview approval and replay-protection tests remain valid.

Switching only to `codex exec` does not address ownership of the same conversation.
Separate Misty-only conversations avoid this contention but change the user's
selected-chat workflow, so they are not a silent fallback.

## Status

Investigation complete. The original investigation left services running with
their existing behavior and sent no test messages. The owner subsequently
authorized implementation. The [live-session adapter](misty-codex-live-session.md)
is now installed, with a successful open-editor test and 44 passing focused checks.

Official references checked:

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex IDE settings](https://learn.chatgpt.com/docs/ide/settings)
- [Codex IDE commands](https://learn.chatgpt.com/docs/ide/commands)
