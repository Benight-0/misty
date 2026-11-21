# Misty on Discord - 1/10: Start here

> Updated workflow: [interactive task cards](misty-interactive-discord.md) now provide chat selection, Edit prompt, Find chat, Send to Codex and Cancel. The typed commands in this earlier guide remain available as a fallback.

Open our private DM: https://discord.com/channels/@me/100000000000000046

Type a normal message and press Enter. You do not need to mention Misty or use slash commands. Controls such as `!status` are ordinary messages starting with an exclamation mark.

There are two ways to use me:

**Conversation:** Ask questions, discuss ideas, recall our earlier discussion, or ask which command to use. I answer in Discord.

**Codex task:** Ask me to prepare work for your laptop's Codex. I clarify/rewrite the prompt, recommend a saved chat or new workspace chat, and show a preview. You review it, then approve with the exact `!send CODE` shown.

Your message -> discussion or task preview -> your approval -> laptop Codex -> answer returned here.

I currently respond only to your account in this private DM. Text instructions work best; describe an attachment in text because I do not directly inspect arbitrary attachments here.

For a quick start, send `!ping`, then ask: "What can you help me do today?"

<!-- discord-part -->

# 2/10: Talk naturally

You can talk casually. You do not need to write a polished prompt or remember commands. Examples:

- "Let's discuss the next stage of Misty. Don't prepare a task yet."
- "What did we decide earlier about how this should work?"
- "Explain the last Codex answer more simply."
- "Which existing chat would you recommend for improving the message archive, and why?"
- "What command changes the destination of my pending draft?"
- "Before creating a task, help me compare these two approaches..."

I use high reasoning and our saved Misty conversation, including delivered task previews and returned Codex answers. When a conversation grows beyond the input budget, older discussion is summarized into saved memory; recent discussion remains verbatim. Original saved records are retained.

If I misunderstand, say exactly what to change: "I only want advice right now," "That is a different project," or "Keep the earlier requirement about preserving summaries."

Ordinary "yes" or "send it" does not submit a task. Actual submission requires the current `!send CODE`.

<!-- discord-part -->

# 3/10: Turn a rough request into a task

Tell me the goal, project, relevant constraints and what result you want. Rough wording is fine. For example:

"Prepare a task for the misty project. Investigate why opening chats is slow. Preserve all saved messages and completed summaries. First inspect the implementation and give me a concrete plan; do not edit files yet. Use the existing project conversation."

Or:

"Prepare the next Misty UI improvement. Make the chat list easier to scan and keep Discord/WhatsApp markers visible. Use our existing Misty project chat and preserve unrelated edits."

Useful details to include:

- What should change, and what success looks like.
- Which project or earlier conversation this belongs to.
- Whether you want explanation, a plan, investigation or implementation.
- What must be preserved.
- Any limits on sending messages, deploying, running expensive work or modifying files.

I will propose the exact prompt and destination before submission. If you want clarification first, say "Ask me about anything unclear before preparing the draft."

<!-- discord-part -->

# 4/10: Review and approve the preview

Read all parts of a task preview. Check:

1. Existing chat or new chat.
2. Chat title and workspace path.
3. The exact rewritten prompt and its constraints.
4. The reason for recommending that destination.

Then copy the `!send ...` command from the latest preview into a new Discord message.

Example only: `!send a1b2c3d4e5`

Here, `a1b2c3d4e5` is a made-up code. Replace it with your actual latest preview code. This applies to every code example in this guide.

The code approves BOTH the shown prompt AND the shown destination. The preview must have been fully delivered before submission is accepted.

Every edit, destination change or reissued preview creates a new code and invalidates the previous one. Pending drafts expire after 24 hours.

After approval, the VM queues the task for the laptop relay. Keep the request specific: Codex can perform real work in the selected workspace using its available tools. A draft is only a proposal until you approve it.

<!-- discord-part -->

# 5/10: Change the prompt before sending

The easiest option is natural language:

- "Revise the pending draft to make it planning only."
- "Keep the goal, but include the WhatsApp group DMs too."
- "Add the requirement to preserve completed analyses."
- "Change the result to a written explanation with file references."

I can propose an updated draft with a fresh code. Read the replacement preview before approving it.

For exact control, use:

`!edit CODE YOUR COMPLETE REPLACEMENT PROMPT`

For example:

`!edit a1b2c3d4e5 Inspect misty chat loading and explain the main delays. Produce a plan only. Preserve all data and do not edit files.`

**!edit replaces the entire prompt.** Include everything you still want in it. For a small change while retaining the rest, ask naturally and check the resulting preview.

Other draft controls:

- `!show CODE` reissues a pending preview with a NEW code.
- `!cancel CODE` cancels that pending draft.
- `!reset` cancels all pending drafts. It keeps saved conversations, memory and approved jobs.

Neither cancel command stops an already approved/running task. There is currently no Discord control for stopping those jobs.

<!-- discord-part -->

# 6/10: Choose the right existing chat

Continuing an existing project conversation gives Codex that conversation's persisted history and settings. Tell me the project and which earlier discussion you mean.

To find saved chats, send:

`!chats Misty`

or:

`!chats misty`

Search matches titles, workspace paths and saved previews. Results show up to eight matches, so narrow the search if needed. The catalog contains saved conversations, not just currently open VS Code tabs.

After receiving a task preview, select a numbered alternative from that preview:

`!chat CODE 2`

Or select an exact chat ID copied from `!chats`:

`!chat CODE FULL_CHAT_ID`

Both produce a new preview/code. Approve only after checking it.

For our main Misty/message-archive project, the established conversation has the older title **Estimate Beeper backend effort**, in `C:\Users\Public\Downloads\misty`. That legacy title can still be the correct destination. Its ID is `01a11d07-06bc-7602-b904-31f486263e03`.

My recommendation uses catalog metadata and our DM context. I do not read every saved Codex transcript to choose a chat, so correct a recommendation when you know a better destination.

<!-- discord-part -->

# 7/10: Start a new chat or continue a result

For a new conversation in the draft's selected workspace:

`!chat CODE new`

For a new conversation in another known workspace:

`!new CODE WORKSPACE_PATH`

Copy the workspace path from the catalog. For example:

`!new a1b2c3d4e5 C:\Users\Public\Downloads\misty`

This revises an existing pending draft; it does not submit it. Review the new preview and approve its new code.

After Codex finishes, its final text answer is returned here, split into messages if necessary, with a reference/link to the selected Codex conversation.

Then you can say:

- "Explain that result in simpler terms." -> conversation here.
- "What would you recommend doing next?" -> discuss next steps.
- "Prepare the next implementation step in the same chat. Keep the previous constraints." -> another preview requiring approval.

Each new task needs its own approval. When several tasks or chats are involved, name the project and the result you are continuing so the destination stays clear.

<!-- discord-part -->

# 8/10: Laptop availability and task status

The VM keeps this bot online. I can continue talking and preparing drafts while your laptop is off, using the last saved chat catalog.

For Codex to execute, your laptop must be awake, signed in, connected to the internet, and running **Misty Codex Relay**. Approved tasks remain queued on the VM while it is offline. They can begin when the laptop reconnects.

Useful checks:

- `!ping` checks the bot and laptop connection.
- `!status` shows laptop availability and the eight latest jobs.
- `!context` shows the conversational model/reasoning, saved context coverage and catalog size.
- `!help` shows the controls.

A task waits if the selected chat is known to be busy. It is not silently moved into another conversation. Avoid submitting work in the same chat from VS Code and Discord simultaneously.

The relay uses your installed Codex backend and saved conversations. It does not type into the visible editor box. An already-open VS Code chat may need reopening/reloading to display work added through the relay.

Higher reasoning and Codex tasks can take time. Check status before submitting the same work again.

<!-- discord-part -->

# 9/10: What context I can actually use

In this DM, I know Misty's purpose, available commands, our saved conversation, task previews/results, draft/job state, and the laptop's published Codex chat catalog.

That does not automatically give the conversational bot the contents of your full Discord/WhatsApp archive, every Codex transcript, laptop files, or live browser pages. Ask for a Codex task if you want files inspected, code changed or stored data investigated. The selected Codex chat then uses its persisted context and available tools.

Likewise, chatting here does not automatically message other people or turn on autonomous replies in their chats. State any intended external action explicitly in the task prompt, including recipient and exact scope.

You can ask:

"Do you know this from our conversation, the chat catalog, or a completed task?"

For current facts about the running app, ask for an inspection task instead of relying on an earlier discussion. Say "Check the current state and report what you verified."

For a long project, remind me of critical constraints when preparing a task, and verify that the exact prompt includes them before approval.

<!-- discord-part -->

# 10/10: Troubleshooting and a complete example

**No reply:** Try `!ping` and `!status`. Give an in-progress reply time to finish before repeating requests.

**Wrong destination:** Search with `!chats SEARCH`, then use `!chat CODE CHAT_ID` on the pending draft.

**Code rejected:** It may be expired, replaced, cancelled or already approved. Read the latest preview. `!show CODE` can reissue a still-pending draft with a fresh code.

**Queued for a long time:** Check laptop availability and whether the selected Codex chat is busy. If needed, on the laptop run PowerShell: `Start-ScheduledTask -TaskName 'Misty Codex Relay'`.

**Submission/delivery uncertain:** Inspect the selected Codex conversation and job status before requesting the same work again. Uncertain submissions are not automatically repeated.

**End-to-end example:**

You: "Help me plan faster chat loading in Misty. First discuss possible causes."

Misty: discusses the problem.

You: "Prepare an investigation task in the existing misty conversation. Preserve messages and summaries. No edits yet."

Misty: shows destination, exact prompt and approval code.

You: review it, then send the actual `!send CODE`.

Misty: queues the task and returns Codex's answer when complete.

You: "Explain the findings, then prepare the implementation as a separate task in that same chat."
