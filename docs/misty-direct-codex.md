Current delivery preference (24 October 2026): Apollo saves and delivers new visible Codex activity live. Old stored updates are not replayed; discussions remain quiet until requested. See [Apollo](apollo.md).

# Misty: direct Codex work and Apollo updates

Deployed 23 October 2026. This supersedes older instructions requiring a review
card for every request. The original card controls remain available.

## Talking normally

- ?In the Guide Website Codex chat, fix the sidebar overflow and verify the build.?
  Misty finds the real chat and can send the task directly.
- ?Complete that fix and test it.? Misty can follow through on that approved task
  in the same chat, up to six necessary follow-up turns over 24 hours.
- ?Show me the exact prompt and a command card first.? Misty prepares a card and
  waits for your action. Ambiguous tasks/destinations also need clarification.
- ?Find the Codex chat where we worked on the sidebar, and explain the last fix.?
  Both bots can search and read the synced visible history themselves.
- Tell Misty to stop work to revoke follow-ups. A turn already submitted can finish.

Clear current requests authorize that work; discussing an idea, old transcript
instructions and unsolicited new initiatives do not. A separate Luna scope check
compares the actual saved owner message, recent conversational context, exact
proposed prompt and destination. Refusals are returned to Misty for clarification
or a review card. This is an application permission check, not a claim that model
judgment is infallible. Existing chat and workspace validation still applies.

Each owner request has a durable dispatch receipt. Repeating the same call returns
that receipt; a different prompt/destination cannot silently replace it. Jobs use
the existing hash-bound queue and editor-aware laptop adapter. Busy chats wait;
uncertain sends are not repeated. New direct continuation grants retain the owner
request plus the dispatched task as scope and reuse the existing review, expiry
and stop controls. The main agent can investigate and perform necessary work in an
approved task; unrelated projects, broader access or external actions need their
own owner authorization.

## Activity status

Misty shows factual activity from streamed Codex events: thinking, searching the
database/web, reading files/Codex history, talking to Codex, editing files or
running commands. When idle it shows waiting for a new message. Pending remote
jobs show waiting for Codex or waiting for the laptop. Activity labels are fixed,
public-safe text; commands, search terms, names and file paths never become status.
Discord presence is limited to one update about every four seconds, so a very fast
lookup may finish before the visible status changes.

## Apollo

Apollo receives visible assistant commentary and completion/interruption events
from laptop Codex chats, including tasks run directly in VS Code. Saved records
include the chat title, an excerpt and its actual VS Code link. A completed turn
means Codex ended that turn, not independent verification of the implementation.
Apollo can search those transcripts, paginate relevant context and interpret the
answer in conversation; it cannot send Codex tasks or run laptop commands. Misty
continues to handle coding and approved projects.

Both bots use the same 155-chat initial history index; new catalog chats join it.
The full visible transcript remains paginated, with document timestamps showing
freshness. Hidden reasoning and tool logs are excluded. Active chats are prioritized
for refresh; history sync continues while remote work runs. Old compressed history
is still readable through the existing app-server reader.

The event watcher checks local uncompressed rollout tails every three seconds,
independently of execution and history uploads. The installed thread/list omits
paths, so read-only local Codex metadata supplies them after validating its schema.
Catalog discovery is refreshed every 15?30 seconds. No thread is resumed merely
to monitor it. Events begin at activation; historical completions are not replayed
as new notifications. Partial lines, offsets, a local outbox, VM event IDs and
Apollo inbox records and historical delivery receipts persist across restarts. Uncertain Discord deliveries
are recorded without automatic resending. Pausing Apollo monitoring also pauses
Codex ingestion; saved events remain available. Resume keeps discussions store-only; new Codex updates use their separate live-delivery authorization. The laptop must be awake and online
for execution and live Codex activity reporting. VM chat collection remains separate.

## Runtime

- Existing private bridge on 127.0.0.1:8792: Misty send/draft/history/archive operations.
- Separate credential on 127.0.0.1:8794: Apollo read-only Codex catalog, search,
  transcript, status and event operations. Send/draft/control/archive writes reject.
- The paired laptop publishes events through the existing authenticated SSH relay.
  There is no new public route, desktop port or firewall rule.
- Backup: `/var/lib/misty-prominence/codex-associate-before-20261023T152413Z`.
- Snapshot: `/var/lib/misty-prominence/versions/20261023-152414`.
- Manifest: `data/deployment/misty-codex-associate/deployment.json`.

Checks: 51 staged Node integration checks, nine Python activity/fork checks,
self-update checks, plus six real-model permission fixtures passed. The live
read-only completion test used a separate harmless Codex chat; no fake owner
message, approval or production Codex job was created for the tests. Real visible
commentary and completion events reached the VM and Apollo delivery receipts were
confirmed. A separate real Apollo model lookup used two read tools and retrieved
the exact saved phrase. Browser/Discord visual inspection was not available. Existing media/open helpers were merged
from production and preserved.
