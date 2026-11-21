# Background chat reading and quiet inbox

Apollo owns background conversation reading and a quiet on-demand inbox. Misty remains the
general Prominence agent with archive access on demand, Codex and its own work
reporting. See [Apollo](apollo.md) and the [role split](misty-apollo-roles.md).
Apollo's reader and owner conversation both use `gpt-6-luna` with explicit `none`
reasoning. Conversation findings are stored, never proactively sent. New visible Codex events are saved and delivered live under the separate owner authorization; older stored events are not replayed.
Requested owner replies/progress continue normally. Monitoring does
not need the laptop; the collector, archive and summaries are shared.

## When it reads

| Source | Decision timing |
| --- | --- |
| Connected, tracked Discord/WhatsApp DM | Every incoming message |
| Discord group DM, Discord G/GP channel, or WhatsApp G group | Every incoming message |
| WhatsApp S group / selected S/SP server channel | 50 messages or 15 minutes per channel, whichever comes first |
| Ignored or disconnected chat | Excluded |

Each server channel has its own persistent, non-overlapping batch. It flushes at
message 50 or 15 minutes after the first waiting message, whichever comes first.
The timer is fixed rather than reset by later messages, and quiet channels flush
without another message. Empty channels make no model calls. Timer and buffer
survive restarts; completed batches are not repeated. Queued inference or retries
can delay inbox availability beyond the deadline.
The separate server summary worker's hourly quiet-room flush is unchanged.
The saved Discord classifications are 44 S, 4 SP, 2 GP, 48 I and 2 undecided.
GP means full-history group treatment with priority. I and undecided stay off.
Existing private-chat and WhatsApp selections are preserved. These are selections,
not a guarantee of source availability or complete platform history.

The event reader polls once a second. Immediate means no batching delay for DMs,
not zero latency: collection, inference, retries and bursts can add delay. It
checks incoming messages, while outgoing messages help establish context. Both
Misty's and Apollo's owner DMs are excluded so replies cannot create notification loops.
Existing historical downloads are not replayed as fresh notifications.

## What becomes a saved finding

The decision combines the triggering text, recent conversation, stored DM/group
summary and people observations, current owner interests with confidence/review
status, recent owner/Apollo conversation, and previously saved findings. Server decisions
also include compact notes from earlier batches in the preceding day, plus up to
200 recent messages within that day. Context, profile and source text have explicit
size limits; missing/expired/truncated evidence is marked rather than invented.

Apollo can mention a reminder, unanswered request, changed plan, useful action or
initiative, meaningful update, or something matching the owner's interests.
Routine filler, weak keyword matches, resolved requests and repeated topics
usually produce silence. This is a model judgment, not a guarantee of perfect
relevance. Quiet Apollo storage preserves distinct later developments, including
the same topic within an hour; exact evidence/job duplicates are suppressed.

Selected discussions go to Apollo's durable inbox with summary, topic/relevance,
room/server, source IDs/links and event/provenance timestamps. Sources and current
tracking/classification are checked again after inference. Existing queued notices
are stored; sent/unknown receipts remain unchanged and uncertain sends are never
retried. Owner-requested recaps query this inbox without reanalyzing the archive.
Follow-up context persists; originals may expire and are verified when requested.
Neither unsolicited DMs nor scheduled digests are sent or rerouted through Misty.

Alerts can propose actions. They do not schedule reminders, send third-party
messages, approve Codex cards or start unrelated work. The existing approval
policy still governs doing those things.

### Priority servers and groups (SP / GP)

The Discord classification supports `[SP]`: server storage and 50-message
batching follow the same 50-message/15-minute policy, while the reader reports
even mildly relevant items.
Several relevant items in a batch can be reported together. Ordinary S servers
keep their ordinary relevance threshold. Priority batches can use a longer message
and do not have the ordinary hard one-hour topic cooldown; the model still checks
previous alerts to avoid repeating unchanged information. Grounding and action
approval rules are unchanged. `[GP]` uses the same lower threshold per incoming
message, with G-style full-history retention and analysis.

S/SP channels start at activation; their old archived messages are excluded from
new collection, summaries and notification context. Raw text expires after 24h
only when a successful summary covers its current version. G/GP history uses
checkpointed pages and waits for available history retrieval to finish before
full analysis. History imports before activation cannot create alerts. Source
coverage is limited by Discord permissions and accessible threads. The collector
uses separate private/server recovery loops; G/GP pages are interleaved so a large
server selection cannot starve their history. New visible channels/threads can be
discovered from gateway events, with an hourly metadata refresh as a fallback.

## Runtime and recovery

- `apollo-bot.service` hosts the decision worker independently of long Codex jobs.
  Misty's bridge has `MISTY_CHAT_NOTIFICATIONS=off`.
- At most two decisions run together, with at most one server decision. A DM
  therefore has capacity while a server request is waiting on the model.
- Messages in the same room are decided in sequence. Retries back off from
  15 seconds to five minutes. Jobs older than one day are audited without alerts.
- Events, jobs, partial buffers, decisions, deduplication and server notes are
  durable SQLite state. Ingestion and cursor advancement commit together.
- Profile reads are shared and cached for five minutes. One archive snapshot
  fetches the triggering messages, context and summary together. Already included
  trigger messages are removed from the surrounding context to reduce repetition.

Ask Apollo naturally to pause or resume monitoring, or for its status. Resume
never enables unsolicited delivery; store-only mode stays in force. Its
notification tool includes the pause state, model, last successful poll, cursor,
job counts, partial server buffers and recent decisions. A paused worker keeps collecting queued
events and resumes decisions afterward; stale jobs still expire as above.

## Verification and deployment

The Apollo handoff passed 25 focused checks including the existing watcher and
Prominence bridge checks. An isolated live-model archive fixture retrieved an
original message and verified source with no production writes or Discord sends.
The one-time handoff installer and current service are documented in [Apollo](apollo.md).
The older upgrade procedure below describes the original Misty-hosted rollout;
do not use it to redeploy the current Apollo architecture.

Eight focused tests cover direct-message inclusion, parented WhatsApp groups,
exact per-channel batches, replay/restart recovery, ingestion during inference,
reserved DM capacity, room ordering, pause, source validation, retry and stale
jobs. They pass on Windows and the VM. The combined associate/bridge/notification
suite passes 24 checks. Three isolated live-model fixtures selected a direct
action request and a relevant 50-message server batch, while ignoring group filler.
Those model calls took about 2.5 seconds each; real archive context and bursts can
take longer. Fixtures never sent Discord messages or wrote production jobs.

Upgrade command (root, staged tree):

```sh
python3 scripts/deploy-misty-notifications.py /tmp/archival-migration/notification-upgrade
```

It backs up changed source and consistent bot/inbox databases, briefly restarts
the two bot services, and leaves the archive collector running. Rollback restores
source only; never overwrite current databases with older notification/delivery
receipts.
