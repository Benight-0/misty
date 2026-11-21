Current delegation rules: [direct sending, activity and Apollo Codex updates](misty-direct-codex.md). Clear owner-authorized tasks can now run without a card; the older mandatory-card descriptions below describe the original workflow.

Current behavior: see [Misty peer workflow](misty-peer.md) for compact proposals, on-request exact replies, code search and full visible transcript sync.

# Misty to local Codex

Misty's owner DM: https://discord.com/channels/@me/100000000000000046

## Use it

**Associate update:** Misty now has bounded read-only archive tools and an optional **Work on this** button for new dedicated tasks. That button permits follow-through on the displayed task; unrelated work still requires approval. See [the associate guide](misty-associate.md) for scope, notification behavior, examples and stop controls. The one-turn Send to Codex flow below still applies.

**Interactive controls:** task previews now use Discord cards with a chat dropdown, **Edit prompt**, **Find chat**, **Send to Codex** and **Cancel**. Use these directly; command codes remain a fallback. See [the interactive guide](misty-interactive-discord.md). The card's Send to Codex button and `!send CODE` use the same exact prompt/destination approval check.

Talk to Misty naturally. It can answer questions, discuss plans, recommend commands, explain its capabilities and help choose a chat without creating a task. The chatbot stays on **gpt-5.6-luna**, with **high reasoning** and a 16,000-token reasoning/output allowance. This setting applies to the conversational bot; the archive analysis default remains unchanged.

When you clearly request a Codex task, Misty rewrites it and recommends a destination using the laptop's real chat titles, workspaces, previews and recency, together with your saved Misty conversation and current draft/job state. This is a recommendation from metadata, not a search of every Codex chat's full transcript. Read the proposed destination, workspace, exact prompt and reason in the preview. You can also describe a change naturally, such as “make that draft planning only”; Misty can revise the pending prompt and issue a new preview.

**Nothing is submitted to Codex until you click Send to Codex on the current card, or use `!send CODE`.** Either approves both its exact prompt and destination. A preview must have been fully delivered. Pending drafts expire after 24 hours.

| Command | Effect |
| --- | --- |
| `!send CODE` | Approve and queue exactly the shown prompt and chat. |
| `!edit CODE replacement text` | Replace the prompt exactly, then receive a fresh preview/code. |
| `!chat CODE NUMBER` | Select a numbered alternative from that preview; requires fresh approval. |
| `!chat CODE CHAT_ID` | Select another existing chat by its full ID; requires fresh approval. |
| `!chats search words` | Find chats by title, workspace or saved preview; narrow the search if more than eight match. |
| `!chat CODE new` | Propose a new chat in the currently selected workspace. |
| `!new CODE WORKSPACE_PATH` | Propose a new chat in a workspace shown by the catalog. |
| `!show CODE` | Reissue a preview with a new code, useful after uncertain Discord delivery. |
| `!cancel CODE` | Cancel a pending draft. |
| `!status` | Laptop connection and eight most recent jobs. |
| `!context` | Model/reasoning, saved conversation coverage, capabilities version and catalog size. |
| `!ping` / `!help` | Connectivity / command reference. |
| `!reset` | Cancel pending drafts; preserve approved jobs and all saved Codex chats. |

Edits and target changes invalidate the previous code and disable old card controls. Ordinary replies such as “yes” are conversational replies; Misty points to Send to Codex on the current card when asked to send naturally. Existing chats are never silently replaced with a new chat if they cannot be opened. A chat with an active persisted turn waits until that turn finishes.

## Conversation context

`app/misty-persona.mjs` supplies versioned, predetermined knowledge of Misty's purpose, architecture, archive website, available chatbot controls, user aliases, chat-selection rules and approval requirements. It distinguishes the separate archive's features from the chatbot's actual access. It contains no keys or credentials.

Each AI reply receives the saved owner DM conversation, including earlier replies, delivered previews and returned Codex answers, plus the current complete catalog metadata, pending drafts and job states. There is no last-15-turn cutoff and no per-message clipping of that conversation. Unconfirmed deliveries are not presented as observed messages. Conversation continues from the last catalog even while the laptop is offline.

When the saved conversation becomes too large for the input budget, older events are processed in chronological batches into detailed saved memory checkpoints, with all recent events kept verbatim. Every older event is included in checkpoint coverage; original SQLite records are preserved. Memory is a summary rather than a verbatim copy of those older messages. Checkpoints record a source-prefix hash and coverage count, resume after interruption, and are invalidated if the historical prefix changes. The default conversation budget is 600,000 bytes with allowance reserved for runtime/project context; the available model input is finite.

`relay_context_runs` records the model, effort, visible/verbatim/memory coverage, input size, request ID and reported reasoning-token count. The bot does not gain direct access to all private archived conversations or every Codex transcript from this feature. Codex itself resumes the selected task conversation after approval, using that conversation's persisted history and settings.

The Codex answer returns to the owner DM in Discord-sized parts. Full received text, exact approved prompt, destination, receipts and delivery state are retained in the separate bot database. Ambiguous submissions/deliveries are not automatically repeated.

## Runtime

```
Owner Discord DM → VM bot → Luna task card/chat recommendation → owner Send to Codex
→ durable VM queue → outbound laptop SSH connection → local Codex app-server
→ same persisted Codex chat → final answer → VM → owner Discord DM
```

The relay uses the installed extension's Codex binary, existing laptop login and saved conversation IDs. **Already-open chats now use their live editor owner**, with its current context and model settings, through a version-checked internal owner/follower adapter. Busy chats and existing native queues wait. Final completion comes from that owner's stream, with persisted receipts for recovery. You can leave VS Code open. Completed results include a `vscode://openai.chatgpt/local/CHAT_ID` link.

When no editor owns the chat, the relay uses the official [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server). The live adapter fixes the idle writer-lock conflict found in [the investigation](misty-codex-session-investigation.md). It is enabled for extension 26.51007.21434; future extension updates need compatibility verification. See [implementation, tests, recovery and limits](misty-codex-live-session.md). This internal API does not provide an atomic append operation for simultaneous queue edits from different clients.

As verified on 2026-10-22, the local Codex profile uses API-key authentication. That login and model configuration were preserved; the key is never sent to the VM. Rewriting uses the existing VM Luna credential. Execution uses the selected Codex thread's configuration, with owner-authorized full file access and no interactive tool-approval prompts for the submitted task.

**The laptop must be awake, signed in and online for Codex execution.** The VM stays online and keeps approved work queued while the laptop is off. Resuming an interrupted submission uses saved receipts/client message IDs; uncertain work is reported for inspection rather than automatically repeated. This version returns final text answers; interactive Codex approval/question requests are not exposed as Discord controls.

## Processes and storage

- VM: existing `misty-bot.service`, `/opt/misty-bot`, `/var/lib/misty-bot/chat.sqlite`.
- Private relay HTTP listener: `127.0.0.1:8790`, bearer-protected; no public route or firewall opening.
- Laptop connects with the existing SSH configuration, invoking `misty-relay-agent.mjs` as the restricted bot user. Codex itself is never exposed on a network port.
- Laptop task: **Misty Codex Relay**, starts at this Windows user's sign-in through a compiled `winexe` launcher (`scripts/misty-codex-relay-job.cs`). It launches Node with `CreateNoWindow` rather than a persistent PowerShell console, owns the relay process tree with a Windows Job Object, and reconnects after network failures. No automatic Windows sign-in or power setting changes.
- `install-misty-codex-relay.ps1 -PrepareOnly` builds the versioned launcher without changing or restarting the scheduled task. The full installer registers that launcher for future sign-ins. The old `start-misty-codex-relay.ps1` remains available for manual foreground diagnostics.
- Local private state: `data/deployment/misty-relay/config.json`, `journal.sqlite`, `status.json`, `worker.lock`.
- Journal records the approved hash, thread ID, turn ID and completed response before delivery. Each finished job releases its Codex process; the next request reloads current on-disk conversation history.
- Only the existing owner Discord account is accepted. Bot and personal archive collectors remain separate.

Install/start: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-misty-codex-relay.ps1`

Stop: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stop-misty-codex-relay.ps1`

Restart after stopping: `Start-ScheduledTask -TaskName 'Misty Codex Relay'`

Read local status: `Get-Content data/deployment/misty-relay/status.json`

Focused verification: `node --disable-warning=ExperimentalWarning --test app/tests/discord-bot.test.mjs app/tests/misty-relay.test.mjs app/tests/misty-conversation.test.mjs`

VM rollback copies are under `/var/lib/misty-bot/relay-before-TIMESTAMP`. Updates preserve the bot database and do not restart or change the archive service. See `scripts/deploy-misty-relay.py` for the staged test/install/rollback procedure.
