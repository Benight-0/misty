# Talking and working with Misty

## Normal conversation

Talk normally. Misty reads your request, uses its archive/code/Codex search tools as needed, and replies in ordinary language. You can discuss an idea without creating a task. It can explain its features, look up how the code works, propose changes, and use Codex to implement approved work.

Examples:

- “How does your search work? Check the actual code.”
- “What did we decide in the Misty Codex chat about sending messages?”
- “What is happening in my server-style WhatsApp groups?”
- “Pause notifications for now.”
- “Show the exact reply Codex gave for that task.”
- “Show me the official command card.”

The actual conversation uses **gpt-6.1-sol**, high reasoning, on the Responses API. Frequent summaries and notification decisions remain on **gpt-5.6-luna**. The model was checked against the [official GPT-6.1 Sol documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and an actual authenticated API request.

### Source context and a conversational voice

The main model prepares a detailed, evidence-grounded source brief. Misty's separate **gpt-5.6-luna** voice uses that brief and the ongoing conversation to write a fresh natural answer in your language. It does not have to paraphrase every sentence or reproduce a report. Short, long and technical answers all use your phrasing and rhythm. The real source facts, uncertainty and action receipts remain binding. Your own messages supply the style examples; Misty keeps its own character and does not borrow your life experiences.

The voice chooses an ordered list of separate chat messages. Usually one is enough; several can make sense for distinct thoughts or a longer explanation. The exact boundaries are saved and used for delivery and replay. A detailed source brief can yield a short answer when that is what your current question needs.

Misty can speak while working. Before a noticeable archive/code search it can use `misty_say` to send a brief update immediately, then run the actual tools and continue with the result. Usually one progress update is enough; the runtime caps these at three per request. Updates share the durable bot outbox and ambiguous deliveries are not blindly repeated. New confirmed Codex running events can generate a short update, followed later by the existing result delivery. A queued task is not described as running. New work still requires the normal approval.

Source requests are interpreted by the model from context, without a required command phrase or fixed reply text. It may retrieve and link the original, or use `misty_quote` to send the actual message text word for word. Long source messages are read in pages with matching revision hashes before any quotation is queued. Original text goes through a separate unchanged delivery path; surrounding conversation stays in your language. Deleted/disconnected/changed sources are reported rather than reconstructed. Discord links open the original message; WhatsApp links open your private archive.

The detailed source brief and the conversational messages stay saved separately. Ask naturally for the detailed original or exact Codex answer; `!answer` and `!result` remain manual alternatives. Exact quotations, code, task prompts and command cards retain their literal content. Normal conversation does not switch to formal assistant prose just because the source is technical. A specifically requested unedited original bypasses conversational composition.

The conversational voice receives the source brief, recent conversation, essential facts, verified sources and confirmed self-action receipts. Literal checks reject invented numbers/links and loss of essential numeric facts; the model contract preserves meaning and uncertainty, rather than a full automated semantic proof. A failed composition retains the detailed original as a fallback. Existing saved summaries and earlier delivered answers are not regenerated.

Deployment controls: `MISTY_REPHRASER_MODEL` selects the conversational model; `MISTY_REPHRASER_ENABLED=off` bypasses it. The main model and its full conversation context remain separate.

## Misty's own messages, status and persona

Misty can manage its own messages in your one-to-one bot DM. Say “delete your last reply”, “remove those duplicate replies”, or “clear all your messages”. It lists real message IDs and verifies each message's actual author before deleting. Your messages, saved archive, detailed answer originals and approved Codex jobs stay stored. Deleting a pending review card invalidates that draft; it cannot later authorize work from a deleted preview. Deletion errors are reported as unconfirmed, not success. `!clear` directly clears Misty's earlier replies without an AI interpretation step. It sends one new cleanup acknowledgement afterward.

Say “set your status to around, if you need me” or “go idle”. Availability supports online, idle, do not disturb and invisible. Activities support custom text, playing, listening, watching, competing or no activity. `!presence` reads the stored state; `!presence online custom around, if you need me` sets it directly. Changes are limited to once per 20 seconds, saved after a Gateway write receipt and reapplied on reconnect/restart. A receipt confirms sending through Discord's Gateway; it is not a separate visual readback. Status text can be visible to shared-server members, so Misty must keep private names, conversation content and task details out of it unless explicitly authorized.

Misty plays a lively AI character: it can joke, express character preferences and take conversational initiative. It remains honest about being AI, distinguishes fictional roleplay from literal identity/experiences, and does not invent an offline human life or assert actual consciousness. The separate rephraser preserves this persona while adapting phrasing to your writing style. New work and messages to other people retain their existing approval controls.

Confirmed self-action receipts also reach the rephraser. It can describe actions already completed by Misty's tools even though the editor itself has no tools. A guard rejects common capability-denial wording after a confirmed action and falls back to the detailed original; semantic fidelity still depends on the presentation contract.

Implementation uses Discord's official [single-message deletion endpoint](https://docs.discord.com/developers/resources/message#delete-message) and [Gateway presence updates](https://docs.discord.com/developers/events/gateway-events#update-presence). DM cleanup deletes messages individually because Discord's bulk-delete endpoint is restricted to guild channels.

## Tasks and approval

New work starts as a small proposal with **Review & run**. Opening it shows the exact prompt and destination. **Send to Codex** approves one turn. **Work on this**, offered for a new dedicated chat, permits the existing six-follow-up/24-hour grant in that pinned chat and workspace. Editing or changing the target requires a fresh review. A natural “yes” does not bypass this approval.

Misty handles approved continuations in that Codex chat. Your DM receives concise progress/outcome notes, not every internal prompt or raw answer. Existing exact results remain stored. Ask for the exact answer, command card, work status or task details whenever needed. `!result CODE` is also available for verbatim retrieval; omit CODE for the latest result. `!show CODE` opens an exact pending review card. No tool can silently approve new work.

## Code and Codex history

The laptop relay uploads searchable snapshots over its existing authenticated SSH connection. Compressed Codex rollouts are read through every page of the installed backend history API; uncompressed rollouts are streamed directly. Neither path resumes a conversation or submits a turn. Misty source includes app, collector, scripts, docs and public assets, plus the project overview. Vendor/generated/data directories, symlinks, credential/config files and oversized code files are excluded. Recognizable credentials in text are redacted.

For each available saved Codex chat in the published catalog, the relay reads **all visible user and assistant text in the saved rollout**, in order. This includes commentary and final replies. It excludes hidden reasoning, system/developer prompts, tool logs and attachment binaries. This is separate from the short catalog preview. Large conversations are stored completely as text chunks, then retrieved in pages or searched with SQLite FTS5. Misty must follow the pages needed for its answer and report incomplete coverage when applicable. It does not load every transcript into every API call.

Uploads replace a snapshot only after count, order, character length and SHA-256 checks pass. An interrupted upload leaves the previous complete snapshot readable. Changed snapshots are detected on a roughly three-minute scan while the laptop relay is idle. Jobs take priority between upload pages. The first sync can take longer; unavailable transcripts are retained as explicit local sync errors and retried, rather than described as complete. Laptop-off snapshots remain searchable on the VM, with their sync timestamps.

## WhatsApp groups labeled S

Only the owner's existing **S** classifications are enabled as server-style collection. Discord servers remain disabled. **G** groups retain their full-history treatment; **I** groups remain excluded.

S groups collect from their first activation timestamp. Old archived messages are preserved but excluded from this new context and its retention process. There is no historical S backfill. A WhatsApp community is treated as a server, with selected child groups as channels. A standalone S group is its own server/channel.

Each channel maintains a rolling summary, developments and follow-ups. Its server/community maintains a combined rolling summary. Batches contain up to 50 new/corrected messages; a quiet channel flushes after an hour. These summaries run independently of notification decisions, including while notifications are paused. The existing notification worker still evaluates complete 50-message chunks.

Sources and revisions are rechecked before committing a summary. API failures or changed evidence retain raw text and retry. New server text older than 24 hours is removed only after its exact stored version has successful summary coverage; raw payloads and associated message-index entries are removed too. Batch provenance, immutable summary snapshots and current rolling summaries remain stored. `archive_server_history` pages through older saved summary snapshots after raw text expires. Edits/deletions queue corrections. Unchanged replayed expired messages are not restored. Pre-activation data and private DM/G history are not deleted by this retention worker.

Use natural requests for summaries; Misty has `archive_servers` and `archive_server_summary` tools showing enabled groups, pending counts, activation dates and saved outputs. A quiet newly enabled group may have no summary until messages arrive and a batch is due. Summary interpretations can still be imperfect; they are not original transcripts.
