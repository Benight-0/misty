# Misty's current work and reminders

Misty keeps a persistent work list alongside its general memory. It receives a
bounded copy on every owner conversation and scheduled run, including resumed
Codex sessions. The list records projects, tasks, notes, priorities, next actions,
blockers, sources and deadlines. Existing long-term notes and chat summaries stay
in their current stores.

Talk in ordinary language:

- "I'm focusing on the application this week. The deadline is November 3."
- "Remind me on November 2 at 6 pm to finish it."
- "That's done. Move my focus to the next task."
- "What should I work on next, and why?"
- "Look at the current Misty code and prepare a fix in my existing Codex chat."

Misty is instructed to save meaningful commitments and changes during the
conversation, update the same item when plans change, and close finished work.
Explicit owner commitments are distinct from inferred interests and suggestions.
It should explain its prioritization rather than presenting a recommendation as
your decision. Entries untouched for 14 days are flagged for review.

## Timing

The owner timezone is Asia/Kolkata. A date-only deadline stays a date; it does not
invent a cutoff time or automatically schedule a reminder. A saved `remind_at`
creates one persistent scheduled workflow. Misty confirms the actual saved time.
Material ambiguity about a requested time needs clarification.

Closing or pausing the item, or clearing its reminder, cancels the linked
schedule. Rescheduling replaces it. Schedules survive restarts; a missed reminder
runs once after recovery. The worker checks every 20 seconds, then the agent
prepares the message; this is not an exact-second alarm service. Model failures
before delivery retry with backoff. An uncertain Discord delivery is recorded
without automatic replay, to avoid duplicate messages.

## Laptop coding

Misty explicitly knows it can inspect the synced code, query the real VS Code
Codex chat catalog, select an existing conversation, prepare an exact prompt and
destination card, and retrieve the actual answer. It checks laptop availability
and records waiting/blocker status instead of claiming offline work is finished.

New work uses the existing owner approval card. Approved scoped continuation
grants remain limited to six follow-ups over 24 hours in the approved workspace
and conversation. The Ubuntu agent and the Windows Codex extension are separate
runtimes. The laptop must be online for laptop execution.

Apollo continues to save relevant conversations quietly for on-demand recaps. Misty's work notes
and personal task reminders do not start another archive-monitoring loop.

## Maintenance

`prominence/focus.py` provides JSON commands: `list [--all]`, `show KEY`,
`put KEY JSON`, `done KEY`, and `brief`. Run it without arguments for the fields.
Use stable keys. `show` includes recent saved revisions. Storage on the VM is
`/var/lib/misty-prominence/focus.sqlite`; linked schedules are in the existing
`workflows.json`. General reusable knowledge still uses `context.py`.

No additional model request is needed to save or load notes, reconcile schedules,
or wait with an empty work list. The usual agent runs when you talk to Misty or a
reminder becomes due. Notes are context, not authority to launch unrelated work.


## Misty-initiated follow-ups

Misty may also choose its own conversational check-ins under the owner's standing
authorization. These use the separate [initiative controls](misty-initiative.md),
not duplicate focus reminders. Pausing check-ins leaves requested reminders intact.
