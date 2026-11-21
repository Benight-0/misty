# Misty: interactive Discord tasks

Tell Misty what you want done and which project or saved Codex chat it belongs to. It can discuss the idea first, or prepare a task when you ask for work.

The task card shows the complete exact prompt, destination title, chat ID, workspace and reason for choosing it. Long prompts span several cards; controls appear on the last part.

- **Chat dropdown:** pick a suggested existing conversation or a new chat in the selected workspace.
- **Find chat:** enter a title or project name, then pick a match in the refreshed dropdown. Search covers the laptop's published saved chat catalog. Narrow the query if there are more than 23 matches.
- **Edit prompt:** opens the exact prompt prefilled in a form. Long prompts are split into labeled fields and joined in order without changing their text.
- **Send to Codex:** approve the displayed exact prompt and destination and queue the task.
- **Cancel:** discard a pending draft.

Choosing a chat, searching, editing or naturally revising a draft produces a new card. Read that version before sending. Old controls are disabled and rejected. Repeated Send clicks cannot create duplicate jobs. Drafts expire after 24 hours; edit/search forms expire after 10 minutes.

Saying "yes" or "send it" in conversation does not approve work. Use the latest card's button. The existing `!send CODE`, `!edit CODE TEXT`, `!chat CODE CHAT_ID`, `!new CODE WORKSPACE_PATH`, `!show CODE`, `!cancel CODE`, `!chats SEARCH`, `!status`, `!ping`, `!context` and `!help` controls remain available. `!reset` cancels pending drafts while retaining approved jobs and saved history. Cancellation does not stop an approved job.

The laptop must be awake, signed in, online and running Misty Codex Relay for Codex work to execute. Conversation and drafting run on the VM; approved work waits while the laptop is offline. Results return to the owner DM.

## Voice and context

Misty uses a bounded profile built from messages marked as authored by the owner, with aggregate style measurements and 32 filtered examples. The running bot receives this profile through its own settings database. It does not gain direct archive database access. Recent DM conversation still guides phrasing, and the existing full-history/checkpoint memory behavior is retained.

Casual replies should be short and direct; explanations can be detailed when requested. Exact prompts, paths, IDs and technical results retain their meaning and wording. Routine command messages use predetermined templates rather than another model request. GPT-5.6-luna/high remains the conversational model setting.

## Implementation and checks

Gateway interactions are received by the separate official bot. Node acknowledges them immediately, outside the model queue, using Discord's HTTP callback. Interaction tokens stay in memory and are not stored or logged. Buttons are bound to the owner, DM, application, sent card and current draft revision. Approval and job creation happen atomically in SQLite after acknowledgement. Unconfirmed acknowledgement performs no action.

The pinned Discord library omits modal components when reserializing its decoded data. The gateway explicitly forwards modal component IDs and exact values, including empty strings. Its regression test inspects the final forwarded JSON as well as decoding, so it catches fields lost between the gateway and Node.

`relay_notices.payload` stores embeds/components alongside message text. Conversation context includes the full delivered embed text and owner interaction events. `relay_card_updates` durably disables replaced/approved/cancelled controls. Message PATCH retries are idempotent. Explicit HTTP 429 rejections respect `retry_after`; timeouts and ambiguous POST delivery are not automatically repeated.

References: [Discord components](https://docs.discord.com/developers/components/overview), [interaction responses and deadlines](https://docs.discord.com/developers/interactions/receiving-and-responding).

Focused tests:

```powershell
node --disable-warning=ExperimentalWarning --test app/tests/discord-bot.test.mjs app/tests/misty-relay.test.mjs app/tests/misty-conversation.test.mjs app/tests/misty-interactions.test.mjs
```

The VM updater runs these tests and the pinned Go gateway decode test before replacing the bot, and keeps a rollback copy. It leaves the separate archive service running.
