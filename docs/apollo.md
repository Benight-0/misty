# Apollo: quiet conversation inbox

Current owner preference, 24 October 2026: Apollo saves interesting discussions
quietly, and delivers new visible Codex updates live. It sends no unsolicited discussion DMs, pings,
urgency exceptions or scheduled digests. Misty remains the general agent.

## Ask naturally

- "what relevant discussions were there today?"
- "anything interesting since yesterday?"
- "what did I miss?"
- "send the source" / "what was the context?"
- "what did Codex finish?"
- "pause monitoring" / "resume monitoring"

`!ping`, `!help`, and `!status` work in the existing owner-only Apollo DM.
Requested replies, optional lookup progress and newly captured Codex updates may be delivered.
Resume restarts monitoring decisions; it NEVER enables conversation alerts.

## Models

Both background relevance decisions and owner conversation/tool retrieval use
exactly `gpt-6-luna`, explicitly `none` reasoning. The deployed runtime is pinned;
unsupported/costlier model overrides and high reasoning are rejected. `low` is
permitted when explicitly configured and verified, with no model fallback.
Misty remains `gpt-6.1-sol`/high; its existing lightweight helpers and shared
archive-analysis models are not changed. Responses function-tool continuations
preserve Apollo's selected model/effort on every round.
Apollo's scoped client reads `final_answer` as the structured result instead of
concatenating intermediate commentary. Tool-round phase history stays intact;
the shared archive/Misty client is unchanged.

## What is stored

The existing single watcher continues per-message DM/group decisions and server
batches of 50 messages or 15 minutes, whichever comes first. It preserves the
saved S/SP/G/GP/I selections, fixed per-channel timers, two inference lanes,
compact evidence-checked interests/profile, preceding-day context and exclusions.
SP/GP include mildly relevant distinct developments; S/G use normal relevance.
Both bot DMs stay excluded. No additional collection or full-history analysis loop.

Relevant decisions become durable `apollo_findings` rows in the existing
`/var/lib/apollo-bot/chat.sqlite`: concise summary, relevance reason/category,
room/server/platform, topic, event times, exact original IDs and verified-at-capture
links/hashes, classification/coverage and watcher provenance. Distinct later
same-topic developments are saved; the old interruption cooldown is not a reason
to discard them in a quiet inbox. Exact job/evidence duplicates are suppressed.
Server batch memories and raw-message retention remain unchanged.

Existing relevant decisions are imported without resetting cursors/buffers.
Historical delivered/unknown receipts remain intact. Queued background notices
are preserved as stored records; ambiguous sends are never retried. Codex events
advance their existing cursor into saved inbox records and live owner DMs. Only new events captured after this opt-in are delivered; old stored updates remain quiet. Delivery receipts survive restarts and ambiguous sends are never retried. This exception does not enable discussion alerts.
Legacy records lacking current room provenance are retained but excluded from
normal discussion recaps when current selection cannot be established.

## Retrieval and sources

`apollo_inbox` queries saved findings using IST today/yesterday/since-yesterday,
recent or custom millisecond ranges, room/topic text, discussion/Codex kind and
stable pagination. It does not reevaluate the archive or start another model loop.
Current ignored/untracked chats are omitted. Recap context persists and is marked
only after a confirmed owner reply; it is context tracking, not a read receipt.
`apollo_inbox_item` verifies current eligibility and reads retained original text.
Missing/expired originals are labeled unavailable; edited originals are identified.
Saved summaries and historical links do not promise permanent raw-chat access.
Only currently verified supported source links are attached to owner answers.
Apollo's archive and Codex tools remain read-only; it cannot submit code tasks,
change commitments or send personal-account messages. Existing exact-preview/
fresh-yes rules remain with Misty's sender.

## Runtime, verification and rollback

Same `apollo-bot.service`, same identity/account/database, same one watcher.
Source: `/opt/apollo-bot`. No fresh handoff, duplicate watcher or scheduled digest.
Misty's watcher remains off; its reminders/work reporting/laptop-activity check
remain active. The public metrics dashboard receives no private inbox payloads.

Focused tests: `apollo-inbox`, `apollo`, `misty-notifications`,
`misty-direct-codex` and `misty-messages` Node suites. The isolated real-model
`scripts/check-apollo-inbox.mjs` verifies background selection and owner recap/
source tools through the actual configured runtime using a fictional in-memory
archive. No Discord API client or real test DM is used.

`scripts/deploy-apollo-inbox.py` is the guarded update. It snapshots affected
source/unit/config, takes a consistent SQLite backup after a graceful Apollo
stop, verifies additive migration preserves cursors/buffers/receipts, then starts
the same service. Misty's changed role uses `selfupdate.py snapshot/check/log/
restart`. Never rerun `deploy-apollo.py` or `handoff-apollo.py` on production.

Deployment evidence and rollback paths are in
`data/deployment/apollo-inbox/deployment.json`. To roll back, stop Apollo first,
restore only the affected source/unit files from the named backup, and retain
the CURRENT database/cursors/receipts. Never restore an old DB over live state.
Do not restart old proactive code against this quiet-delivery preference; retain
the quiet guard or repair forward. The shared collector can stay online while
Apollo is stopped. Original snapshot/backup artifacts remain intact.
