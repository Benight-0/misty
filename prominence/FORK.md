# Misty: Prominence fork

Upstream provenance and original file hashes are in UPSTREAM.json. The original
MIT license is retained. The source repository in Downloads/prominence-chan is
unchanged. This fork keeps upstream conversation, imitation, memory, workflows,
Discord tools, capability-gap scheduling, snapshot/check/restart and crash rollback.

## Adaptations

- `agent.py` translates the upstream agent invocations to Codex CLI. Persistent
  aliases map to real Codex thread receipts. Main effort is high; a cheaper model
  handles lightweight social/gate operations. Claude can still be selected.
- `misty.py` accesses the existing VM archive and laptop relay through an
  authenticated localhost bridge. It cannot approve remote task cards.
- `fork_state.py` retains pending owner messages across restart and quarantines
  ambiguous execution/delivery rather than repeating actions.
- `conversation.py` and `owner_loop.py` keep verified owner input, active-turn
  steering, checkpoints and queued replies durable. The main Codex owner turn
  uses the app-server; new messages can arrive while it is working.
- Owner and workflow prompts require permission before deleting targets the
  owner did not explicitly name or running commands likely to cause material
  damage or serious harm. VM and laptop per-tool reviews are disabled.
- Pillow handles images on Linux. Document indexing reads DOCX/RTF without macOS
  textutil. The mouse helper retains Quartz and adds Win32 for approved laptop
  tasks; desktop input has not been live tested. A headless VM has no laptop UI.
- Production is initially owner-DM-only. Server/group-chat, guest access,
  moderation, imitation nickname/avatar changes and automatic public activities
  remain in source and require an explicit server setup and Discord permissions.
  Private owner-DM material never supplies an automatic public status.

## Deployment

The Prominence supervisor/agent runs in `misty-prominence.service` on the VM.
The existing `misty-bot.service` runs in bridge-only mode: owner event recording,
task-card interactions, archive notifications and the proven Windows Codex relay.
There is one conversational responder. The archive service and website are separate.
The main agent uses the same API-key authentication as the current Codex profile;
it does not consume a ChatGPT subscription login that is absent on this laptop.
The agent's Codex home is isolated from laptop chats. Existing-chat work goes
through the relay and waits for the laptop if it is asleep.

Misty's writable code and data are separate from the archive database. A service
restart does not recreate or discard existing archive summaries. Self-updates
use upstream snapshot/check/log/restart and supervisor rollback; passing the crash
trial only checks process survival, not semantic correctness. Meaningful feature
tests remain required.

The previous hook and laptop reviewer code remain in the tree for recovery but
are inactive in production. See `docs/misty-owner-loop.md` for current behavior and
recovery.
