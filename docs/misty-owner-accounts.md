# Misty verified owner accounts

Primary owner: `100000000000000023`. Verified alternate: `100000000000000034`.
Both accounts represent the same owner and use the existing owner session, memory,
tools and permission rules. Direct replies, interim questions, command cards and
task results follow the authenticated request's DM. Scheduled reminders retain
the primary destination. Apollo, website sign-in and connected personal accounts
have separate settings and are unchanged.

The official bot verifies each account's DM recipient. Admission requires the
configured user ID, that exact private channel and a non-bot author. A username,
quoted instruction or archived message cannot add an account. Alias messages
predating activation are not newly authorized. Concurrent owner turns serialize
around the shared existing agent session.

Personal-account messages still require the complete exact preview and a fresh
actual owner yes in the same DM. New approval digests bind the DM as well as
target/body. Existing pending drafts keep the previous digest format and their
original primary destination. Disconnected personal-account collectors stay
disconnected; adding an owner login does not reconnect them.

Configuration: `/etc/misty-prominence/config.json` adds `owner_alias_ids`, retaining
`owner_id`. `/etc/misty-bot/owner-accounts.json` contains primary and alternate
IDs. The Go official-bot gateway receives a verified `owner_channels` mapping.
The bridge reads its allowlist through systemd `LoadCredential` inside its
existing sandbox; it does not require direct access to `/etc/misty-bot`.
Apollo keeps its existing canonical-only configuration.

Deployment evidence and source baseline are in
`data/deployment/misty-owner-alias-20261025`. Production source/config and
consistent SQLite backups are recorded by `deploy-misty-owner-alias.py`.
Rollback restores source, binary and account config only, through the supported
restart path. Keep live journals, approvals, cursors, focus and reminders; the
SQLite backups are recovery evidence, not a routine rollback overwrite.
