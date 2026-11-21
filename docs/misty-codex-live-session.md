# Misty and open VS Code chats

Implemented and enabled on 22 October 2026.

## What changed

Approve the prompt and destination in Misty's Discord card as before. The laptop
relay now discovers the owner of that exact Codex chat. An already-open chat uses
its existing editor session, model, context and permissions. It no longer requires
another app-server to take that editor's writer lock.

The adapter waits while the selected chat is busy or already has queued messages.
When ready, it gives the approved text to the owner's native follow-up coordinator
with a stable message ID. The coordinator checks idleness before execution. The
adapter never uses the steering or interrupt endpoints. The editor displays the
turn as its own conversation activity.

Owner snapshots and revision-checked patches track the accepted turn and its final
answer. The separate read-only app-server supplies persisted receipts for recovery.
It must not override the live owner's status: an unfinished rollout read by a
different app-server can temporarily appear `interrupted` even while the owner is
still working. A regression covers that observed behavior.

When no editor owns the chat, the ordinary official app-server path remains.
Existing conversations are not silently replaced with new ones. A writer appearing
during fallback causes a bounded resume failure and visible reconnect reason.

## Submission recovery

- The same prompt/destination hash and existing Discord approval controls apply.
- The local journal records the chosen route and submission intent before sending.
- A lost response is reconciled against the stable message ID, native queue and
  accepted turn. It does not trigger another send or backend fallback.
- Recovery searches older receipt pages when necessary, rather than only the most
  recent 30 turns. Normal live polling checks the recent page and owner stream.
- If the editor closes after accepting a queued message, the message stays in its
  queue. The relay waits for the editor to return; it does not run a second copy.
- Unconfirmed outcomes remain explicit. Inspect the selected chat and its queue
  before issuing a replacement request.

## Compatibility and limits

`app/codex-live-session.mjs` uses the **internal** local `codex-ipc` interface from
extensions **26.51007.21434** and **26.51021.22027**, including stream version 11 and
follower queue version 1. This is not a documented public OpenAI integration contract. The adapter checks
the binary's extension manifest and registered extension inventory before live
submission. An extension update needs compatibility verification; it must not be
handled by guessing new protocol versions or removing writer locks.

VS Code can register a staged update while an open editor still runs the preceding
release. These two validated versions can coexist; manifest and inventory versions
need not be identical. The relay resolves its read-only app-server binary from the
single registered, validated extension at each reconnect, rather than retaining a
stale installation path. Unknown releases and ambiguous/missing installations
remain rejected. The existing live editor keeps its model, permissions and session.

The native follower queue operation replaces a complete per-chat queue; it has no
atomic append API. The adapter reads the current shared state and refuses to write
over an observed nonempty queue, including a second check immediately before
admission. An exactly simultaneous queue edit in another client remains a race in
this private API. Do not treat this as a general multi-client queue service. Queue
content is written only through the owner; the adapter never edits Codex state or
vendor files directly. Native composer preparation may append its usual final line
break to the submitted text; the approved prompt in Misty's journal stays exact.

The laptop must remain awake and online. A 2.7-second connectivity test is not an
estimate for coding tasks, which still depend on their workload and model.

## Verification

All **44** focused Node tests passed, including existing approval/card/security
checks and new cases for fragmented framing, owner binding, workspace/version
checks, busy and occupied queues, lost responses, paginated receipt recovery,
editor closure after queue admission, live status authority and safe stream patches.

The owner opened test conversation `01a163ff-6754-7bd3-a3cb-be4b7c77223b` in VS Code.
A harmless local test passed through the live adapter and returned:

```
Misty open-session relay works.
```

The accepted turn was `01a164bd-e738-7001-815e-df5b15f789e1`. Submission progress
was reported after 175 ms, the running receipt after 649 ms, and the final answer
after 2,661 ms. VS Code's Codex process remained PID 40396, started at 22:42:29;
the editor was not restarted. The earlier development test exposed the false
`interrupted` reader status and is preserved in the isolated test journal rather
than rewritten as a successful relay result.

These live checks used an isolated local journal, not fabricated owner messages,
approvals or jobs in the production bot database. Existing VM approval/SSH/result
behavior is covered separately; this is not a new owner-driven Discord end-to-end
test.

The laptop relay was restarted with a consistent journal backup under
`data/deployment/misty-relay/before-live-20261022T175522Z`. To roll back, stop only
`Misty Codex Relay`, restore the two original source files from that directory,
then restart the task. Preserve the current journal so completed submissions cannot
be replayed. The separate VM archive/collector services need no restart.
