# Misty is a Prominence fork

Deployed 23 October 2026. Main bot: `misty-prominence.service` at
`/opt/misty-prominence`. Local fork: `prominence/`, with upstream Git history and
MIT license. Upstream commit: `2444dd36da25a1537aec98a4b817bfcea689fda9`.

## What runs

- Prominence's conversation/voice, persistent agent sessions, note memory, local
  FTS search, scheduled workflows, progress DMs, Discord tools, capability-gap
  tracking, self-update checks/snapshots/restarts and supervisor rollback.
- Codex CLI 0.164.0 replaces Claude Code as the main backend. Main model:
  `gpt-6.1-sol`, high effort. Lightweight gate/social/revoice requests:
  `gpt-5.6-luna`. Normal owner replies use the upstream conversational instructions;
  they no longer pass through the old mandatory neutral-answer/voice pipeline.
- The current Codex profile uses API-key authentication, not ChatGPT OAuth. The VM
  reuses the existing authorized OpenAI key privately. Its Codex home is separate
  from the laptop's sessions. The main agent works while the laptop is asleep.
- `misty-bot.service` remains as a bridge: exact approval cards/interactions,
  laptop job relay, work result updates, prior conversation and synced knowledge.
  It records owner events but does not generate normal conversational replies.
- `apollo-bot.service` owns background chat reading and a quiet inbox for requested recaps.
  Misty can query the same archive on demand, but does not push chat developments.
- `archival.service` and the website/collectors remain in place. Existing message
  history, analyses, identities, selections and exclusions were preserved.

## Using it

Talk naturally in the existing Misty DM. Examples:

- "What has been happening in my group DMs? Look at the new messages."
- "Find the conversation where Roumak mentioned that."
- "What does the stored summary say, and what did the original message say?"
- "Look through the Misty code and figure out why this keeps failing."
- "Send this prompt to my existing misty Codex chat."
- "Check this again tomorrow and tell me only if something changed."

For remote laptop work, Misty looks up the real catalog and prepares an exact
prompt/destination card. Review and approve it as before. Creating a draft cannot
execute it. Existing open VS Code chats keep using the tested live-session adapter.
The laptop must be awake for its Codex work; approved work can wait on the VM.

Upstream `/stop`, `/new` and `/workflows` are available. Memory notes, reminders,
archive search and current job details can also be requested in normal language.
Previous Misty conversation is available through `misty.py history`, with paging;
delivered work results enter the next owner agent turn as context. Apollo's chat
updates stay in Apollo's own conversation context.

Current projects, priorities, next actions and deadline reminders now use the
persistent [current work list](misty-focus.md), loaded into every owner turn.
Misty retains the real laptop Codex connection and the existing approval rules.

## Scope

Apollo's quiet background monitoring is documented in [misty-notifications.md](misty-notifications.md):
each incoming direct/group message, and server batches at 50 messages or
15 minutes from the first waiting message, with
interest/context checks and verified private source links.

Archive reads cover connected/selected Discord and WhatsApp DMs, group DMs and
selected server-style groups. Availability follows actual collection and retained
history, not a promise of complete lifetime coverage. Discord server collection
follows the saved classifications. WhatsApp G/S/I policies remain unchanged.

The deployment is owner-DM-only. Upstream server conversation, guest access,
moderation and imitation nickname/avatar changes remain in the fork and need an
explicit server configuration and Discord permissions. Automatic public statuses
are disabled in private-DM mode so private messages do not become public statuses.
Requested statuses still work. A Windows mouse helper was added for approved
laptop tasks; no real desktop input has been exercised during migration.

Owner turns now use the [duplex owner loop](misty-owner-loop.md): verified new
messages can enter an active turn, and Misty can queue owner replies while it
continues working. Native VM tools run with the bot OS user's file and system
permissions. VM and laptop per-tool reviews are disabled. Misty is instructed
to ask before deleting unspecified data or running commands likely to cause
material damage or serious harm. Self-update crash rollback is not a
correctness proof.

## Verification

- 35 staged Node checks, including exact prompt/destination controls, forged
  approvals, idempotency, archive allowlists, prior history and notification context.
- Seven Python checks covering persistent session command construction, restricted
  social runs, structured queries, inbox recovery and Linux DOCX reading.
- Upstream `selfupdate.py check` passed; Python/Node syntax and Git whitespace checks
  passed. The original Prominence repository is unchanged.
- An isolated real Codex probe read a fixture through the shell, resumed the same
  session and recalled its content, and exercised the cheap social backend. All
  three checks passed in 28.99 seconds; no Discord owner input, approvals or jobs
  were fabricated.
- Deployed source hashes match the tested candidate. Archive/server/profile/event
  tools were checked inside the service mount namespace as the bot OS user.
- Both bot services and the archive service were active with zero restarts at
  verification. The laptop relay was online. Initial idle fork memory was about
  32 MiB; this is not a measurement of peak agent workload memory.
- A deployment confirmation was delivered to the owner DM, message ID
  `100000000000000077`. The first real owner conversation remains the final
  interactive behavior check; no visual Discord inspection is claimed.

The 28 October owner-loop deployment passed 98 staged unit tests, 74 tests in
the deployed source tree, `selfupdate.py check`, and an isolated real Codex run
against the production tree. That run executed a harmless shell command after
the VM hook approved it and queued an owner-only reply in an isolated outbox.
The supervised bot restarted and was active afterward. This does not establish
that a live Discord owner turn has completed through the new loop yet.

Later that day, the owner disabled VM, laptop, and direct-dispatch review
models. An isolated real Codex run used a harmless command and queued an
owner-only reply with zero enabled hooks and no review record. The laptop
broker reported review off, the paired Windows worker online on `C:\`, `G:\`,
and `H:\`, and no pending operations.

## Recovery

Pre-migration backup: `/var/lib/misty-bot/prominence-before-20261023T065015Z`.
It includes the prior responder source and a consistent copy of its database.
The current database must be preserved when rolling back, so new replies and
already submitted Codex work are not lost or repeated.

To return to the previous responder: stop the fork and bridge, preserve the new
fork state, remove only the `prominence-bridge.conf` drop-in, restore the old
`scripts/misty-discord-bot.mjs`, and reload/start `misty-bot.service`. Reconcile
fork inbox states first: imported/completed turns are not new work, and ambiguous
execution/delivery must not be replayed. Do not restore an old database over new
job receipts. The archive service and website do not need a restart.


## Own check-ins

The owner enabled [Misty initiative](misty-initiative.md): one persistent typed
workflow with source-backed follow-up plans, saved talking preferences and pause
controls. Timing and frequency are model-decided with no fixed check-in quotas. Its tool-free decisions use the unchanged main model; owner replies and
approved tasks retain their existing capabilities. Apollo remains separate.
