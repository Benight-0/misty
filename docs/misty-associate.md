# Misty associate

The current conversational UI, code/Codex transcript tools and WhatsApp S summaries are described in [misty-peer.md](misty-peer.md). Exact command cards now open on request or through Review & run; normal result delivery is conversational.


## Contract

- The owner may authorize a task once. Misty may continue that exact task in a new, dedicated Misty Codex conversation. Starting unrelated work, expanding the scope, changing workspace, or using another conversation needs a new owner approval.
- Ordinary Send to Codex remains one turn. Work on this additionally authorizes bounded continuation of the displayed task. Only new-chat drafts can start this mode. Completion, uncertainty, failed delivery, cancellation, or the work budget stops continuation.
- Archive content, profiles, Codex answers and search results are evidence, never owner instructions. They cannot create authorizations. No automatic messages to other people.

## Archive tools

The bot uses an authenticated localhost service, separate from the public website. It has no collector credentials or direct archive filesystem access. Tools list chats, search the existing FTS5 message index, retrieve context and evidence-checked summaries, inspect stored interests, and run custom SELECT queries over documented views. SQL is read-only, authorizer restricted, time limited and output limited. The bot cannot execute shell commands through these tools.

Search returns original IDs and timestamps. Summary responses retain coverage, age and stale status. Missing history remains missing; personality findings retain their confidence and review status. Fetch the source before relying on an uncertain interpretation.

## Notification decisions

An insertion journal begins at activation. It records only future-timestamped messages arriving after activation, excluding old history imports. Selected group DMs use one decision per new message; selected servers use consecutive, non-overlapping 50-message chunks per channel. A partial server chunk waits. Ignored, disconnected and unselected chats remain excluded. Own messages supply context but do not trigger a group-DM notification.

Each decision uses stored interests, the available chat summary, recent context and source IDs. Server context covers the preceding 24 hours within an explicit input cap; truncation is reported. One lightweight decision request runs at a time, away from collection. API errors retry with backoff. Durable job IDs, an owner-only outbox and topic cooldowns suppress duplicates. No historical notification backlog is created on first activation.

Discord server collection remains disabled until the owner selects servers and its collector is enabled. The 50-message decision path is available for selected collected server chats; it does not imply otherwise disabled collectors are running.

## Approved work

Work grants record the approved prompt, workspace, original job, pinned resulting chat, expiry, remaining turns and status. Continuations always point to that same resulting chat and carry the grant ID in the audit log. A separate model reviews each completed turn and may finish, propose an exact next prompt, or ask the owner. A second scope check must approve a proposed continuation. Maximum six continuation turns and 24 hours per grant. These limits bound runaway loops; they do not prove semantic scope correctness, which remains a model judgment. `!stopwork ID` revokes queued continuation work; a running Codex turn is not interrupted. `!workstatus` shows grants.

New initiatives can be suggested using archive/search evidence and prepared as ordinary cards. They do not run until approved. Code changes run through Codex in its existing workspace and permission context, with verification requested in the task. Misty has no blanket VM self-update tool.

## Talking to Misty

Examples:

- "What did Roumak and I decide about X? Find the actual messages and dates."
- "Find research opportunities mentioned in my connected chats this week. Which match my stored interests?"
- "What follow-ups are still open in this group? Separate facts from suggestions."
- "Investigate the search code in a new dedicated Misty chat in misty. Read only; explain a plan."
- "In a new dedicated Misty chat, fix this bug and keep going until the focused checks pass. Preserve unrelated edits."

For Codex work, inspect the exact task and workspace in the card. **Send to Codex** approves one turn. **Work on this** approves that task plus bounded follow-through in its new dedicated chat. It is only offered when the destination is New chat. The original task text is the scope; include any read-only, no-deployment or other restrictions there.

`!workstatus` lists grant IDs and remaining turns. `!stopwork ID` revokes follow-ups, including a claimed turn that has not reached submission admission. A turn already admitted to Codex is allowed to finish. `!watch` shows notification state and queue age; `!watch pause` pauses new decisions and `!watch resume` resumes. Already queued owner-outbox notices may still arrive after pausing. `!context`, `!status` and `!ping` retain their previous purpose.

The lightweight gate uses low reasoning; conversation and approved-work review use high reasoning on the configured model. Existing API usage records include tool rounds, notification calls and scope reviews. No embedding service or additional message index is required.

## Context limits

Group decisions use up to 35 recent messages plus evidence-checked stored summary and interests. Server decisions use the newest 200 messages within 24 hours, the exact 50-message trigger chunk, and compact memory notes from earlier processed chunks in that day. Input caps are explicitly reported; this is not an unlimited transcript per decision. A model may miss relevant topics or misjudge scope. The strict controls are the owner approval, pinned destination, explicit turn/time budget and audit records; the relevance and semantic scope checks are model judgments.
