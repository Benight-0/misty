# Misty's owner conversation loop

The production responder serves verified owner DMs through one private Codex
app-server process in the Misty VM service. It warms the existing owner thread
at service startup and keeps that process and thread loaded between owner
messages. A new installation starts the process with its first owner message.
If Codex disconnects, Misty closes the client and resumes the saved thread on
the next owner turn. There is no public listener.
`fork_state.py` records incoming messages; `conversation.py` binds a run to the
owner and channel. `owner_loop.py` starts or resumes the Codex thread, steers
new owner messages into the active turn in chronological order, and keeps
working after a reply is queued. `conversation_tools.py` lets the agent publish
owner replies, save checkpoints, record completed tasks, and wait for input.
The owner sees the agent's own message; there is no second writer model.

The owner model uses low reasoning effort. Every owner message goes through
the warm Codex thread, including greetings and thanks. There is no fixed
reply list or local canned-response path. Its instructions call for an
immediate short answer to simple conversational questions and enough detail,
practical next steps, and uncertainty for substantive requests.

The VM context index is a small FTS5 database; lookup latency is measured in
milliseconds. Searches preserve exact multiword hits ahead of broad fallback
hits, limit repeated chunks from one source, and format snippets only for
selected results. `context.py get ID [ID...]`
fetches up to eight chosen results in one command with bounded output. Misty
uses its supplied current-work context first, then the specific live source,
then long-term search for missing background. Gmail remains a separate live
source rather than part of this FTS index.

The 2026-11-02 snippet tuning changed only `context.py` without restarting
Misty. Its VM receipt recorded four representative search medians between
1.4 and 5.74 ms and confirmed the index item count stayed 204.

The warm process has stable environment markers. Every owner-scoped tool
resolves the one currently running, verified owner run from the durable inbox
at call time. Tools fail closed when no owner run is active or more than one
run appears active, so an old run ID never carries into a later message.
Changing the owner session or agent instructions closes and resumes the
process; stopping an active turn also closes it. The next turn recovers from
the saved thread and checkpoint.

Each publication has a stable key and a durable outbox. The dispatcher can
deliver it before the task finishes. A POST with an unknown result is marked
unknown rather than automatically repeated. A crash also quarantines inputs
that may have been steered or executed. A later owner message can resume the
thread with saved checkpoints and the uncertain-delivery markers in context.
If a turn completes without publishing anything, the runtime queues a short
fallback notice.

## Tool use and owner permission

The owner agent has the bot OS user's VM access and runs Codex with
`danger-full-access`. Per-tool model reviews and the managed VM hook are
disabled. The owner and workflow prompts tell Misty to avoid deleting anything
unless the verified owner explicitly commands deletion of that target or grants
permission after Misty asks. Before a command or tool action that could
materially damage the computer or data or cause serious harm, Misty must
describe it and wait for the owner's permission. Routine work can proceed
directly. These are model instructions, not a technical block on execution.

The laptop broker also has no per-operation reviewer. It still binds work to a
recent recorded owner request, checks the task's write/command flags, verifies
the paired worker, preserves operation receipts, and uses file preimage checks.
The Windows worker has access to the configured mounted drives while online.
Personal-account messages retain their separate recipient confirmation flow.

## Deployment and verification

For the warm owner worker, run scripts/deploy-misty-warm-owner.py. It checks
the live source hashes, runs the owner conversation tests in a temporary
staging directory, takes a version snapshot and a scoped source/inbox backup,
waits for an idle owner run, and restarts only misty-prominence.service. Its
receipt records the backup, deployed hashes, and warm app-server readiness.

Snapshot with `selfupdate.py snapshot` before changing production. Remove the
VM managed hook configuration, deploy the source, and set
`MISTY_LAPTOP_REVIEW=off` for both the laptop broker and bridge bot. Run the
Python and Node tests, `selfupdate.py check`, and
`scripts/verify-misty-owner-loop.py` against the deployed tree before the safe
restart. The smoke script uses an isolated temporary database and no Discord
dispatcher. It checks a harmless shell command and owner-only queued reply
without creating a review record.

The earlier review-enabled source snapshot is
`/var/lib/misty-prominence/versions/20261027-185124`. A copy of its prior
configuration is stored there as `config-before.json`. A rollback to that
version also needs its managed hook restored, because that version refuses
owner turns without the hook. Preserve the current inbox/outbox database and
reconcile uncertain sends before any replay.

The snapshot taken immediately before disabling reviews is
`/var/lib/misty-prominence/versions/20261027-193514`. The VM's previous
managed requirements, service drop-ins, and bridge source are saved at
`/var/backups/misty/reviews-off-20261027T193523Z`.
