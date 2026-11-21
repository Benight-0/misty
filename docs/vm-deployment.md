# Archival VM deployment

## Current deployment

OCI Ubuntu 24.04, x86_64, 954 MiB RAM, 45 GB root disk. Two GiB swap supports temporary memory spikes; it does not replace RAM. The VM runs a Node 22 application, SQLite archive and a Go collector. It does not run Matrix, Synapse, Docker or a local AI model.

The collector uses the same DiscordGo fork as mautrix-discord and WhatsMeow for WhatsApp. **The fork requires `Session.EventHandler`; its legacy `AddHandler` registrations are inactive.** Discord DMs/group DMs and WhatsApp direct chats retain their existing collection. Live guild-channel and WhatsApp-group messages are rejected. Explicitly selected WhatsApp G groups can import historical sync payloads before a fixed cutoff.

On the first WhatsApp connection in each collector process, a metadata-only `GetJoinedGroups` request refreshes `settings.whatsapp_group_inventory` with current group IDs, names, community flags and parent IDs. Empty names get an individual metadata lookup. The query retries up to three times; failures retain the last successful snapshot and mark an error. This does not create conversations, change selection flags, import group messages or enqueue group analysis. Community containers are distinct from their chat groups. `scripts/export-whatsapp-group-list.mjs SNAPSHOT.json` produces a numbered review list with unassigned treatment choices; it does not change the live archive.

### Reviewed WhatsApp group choices

The owner's numbered Markdown uses `G` (group DM), `S` (server) and `I` (ignore). `scripts/parse-whatsapp-group-choices.mjs` checks every numbered choice against stable IDs in the original review JSON. Blank entries remain unassigned; a community container does not implicitly classify its member groups.

`whatsapp_group_policies` stores these choices. Only G groups are connected for viewing and historical analysis. Their `tracked` flag remains zero, `continuous` is constrained to zero, and the collector accepts their messages only from history sync events with source timestamps at or before the saved cutoff. Normal live group events and S/I/unassigned history are discarded. New empty G rooms do not publish a zero-message summary while awaiting history. Existing DM collection is preserved.

The finite downloader uses [WhatsMeow's history-request builder](https://github.com/tulir/whatsmeow/blob/main/send.go) and `SendPeerMessage` to request pages of 50 from the owner's primary phone. It does not send chat messages to group members. Completed pages commit original messages and persistent cursors; unfinished requests resume after restart. It first attempts recent history up to the cutoff, then moves backward. If the phone cannot bootstrap a recent page, a real cursor from the old bridge archive can request older history, with the missing recent span explicitly marked. No-response/failure/exhaustion states remain visible in room metadata; exhaustion means no more history was returned, not proof of a complete lifetime archive. A phone-dependent history gap may require a chat export later.

Imported messages reuse bridge/native message IDs, preventing duplicate Matrix archive entries. G groups use the existing full archived-history analysis, source checks, author profiles, events, resumable checkpoints and Luna model. S groups currently store only their intended future policy: new messages only, 24-hour raw retention and a running summary. That collection, summarization and deletion policy is inactive. I groups are excluded without deleting previously archived data. No continuous group tracking or summarization was added.

The application binds to **127.0.0.1:8787**. Open **https://archival.example.com** and sign in as **user-17@example.com** using Cloudflare's email code. The owner confirmed the dashboard loads after correcting the local service route to HTTP. The origin verifies the Access signature, issuer, audience and owner email. Missing/invalid assertions and wrong emails are rejected before static files or bootstrap data are returned. No app port needs to be opened in OCI. A custom Archival password login is not implemented; current authentication uses Cloudflare Access.

## Storage and migration

- `/var/lib/archival/data/archive.sqlite`: complete archive, preferences, identities, evidence references, saved summaries and analysis checkpoints.
- `/var/lib/archival/whatsapp.sqlite`: private WhatsMeow linked-device database.
- `/etc/archival/discord-token` and `/etc/archival/openai-key`: root-owned, group-readable credential files, mode 0640. Credentials are never returned to the website.
- `/etc/archival/runtime.env`: runtime options, not an API key.
- `/opt/archival/app`: application modules and UI.
- `/opt/archival/bin/archival-collector`: native Go collector.

Initial migration verified **196 private chats and 160,645 private messages**. The rest of the original archive was preserved with collection/profile inclusion paused. Original conversation flags are saved in the `pre_vm_conversation_preferences` setting. WhatsApp remote IDs were linked to 2,216 existing canonical message IDs to preserve evidence and prevent duplicates. The original laptop archive was not replaced. A consistent migration snapshot remains available locally and on the VM.

Discord READY discovered additional private chats; their older history imports incrementally. A chat with incomplete upstream history must not be described as a complete lifetime archive. Collection cannot recover messages deleted before collection or inaccessible to the account. Media captions, metadata and links are retained; media binaries are not downloaded by this collector.

## Recovery

Every normalized event is acknowledged to the collector after its SQLite transaction commits. WhatsApp uses synchronous acknowledgements. Discord maintains a persistent gap-recovery watermark separately from gateway arrivals: a newer live message cannot skip an unfinished older gap after restart. Newly discovered chats fetch their latest page first, then older history one page per chat per sweep. Discord live gateway traffic continues during history requests.

The owner relinked WhatsApp through the private SSH website. The VM verified one saved linked device and received direct-chat history. The archive grew from 2,216 to 4,663 direct messages across 85 chats, including 2,244 own messages; the import audit found no duplicate remote message IDs. These are deployment snapshots, not a guarantee that WhatsApp provided every historical message.

If WhatsApp is later logged out, use **Sync & storage → Link WhatsApp**. On the phone: **WhatsApp → Linked devices → Link a device → Link with phone number instead**. The app displays a short-lived pairing code for the configured owner number. This action links a device; it does not send a chat message. A new linked device can only retrieve history WhatsApp makes available to it.

## Analysis

Private-chat text is sent to OpenAI's Responses API using **GPT-5.6 Luna**, structured JSON, reasoning effort `none`, no tools and `store:false`. This does not make processing local or guarantee zero retention by OpenAI. Full archived text is processed chronologically in resumable batches; original messages remain stored. Saved model output must pass source, author and date checks before a checkpoint is committed. Refused, truncated or invalid output stays retryable. Existing profile findings, previous completed analyses and history chapters are retained.

`ARCHIVAL_MODEL=gpt-5.6-luna` in `/etc/archival/runtime.env` selects the VM model. On a model change, `scripts/migrate-analysis-model.mjs DATABASE SOURCE_MODEL TARGET_MODEL` can explicitly reuse validated, unchanged checkpoints under the target model's content hashes. It preserves source records, actual generating-model provenance, and published summaries. Changed message batches are not reused; new analysis uses the configured target model. Stop the service while running this migration. Completed analyses are not automatically refreshed just to change their model.

The Luna switch on October 21 passed a real synthetic API/schema check and subsequently saved a production analysis checkpoint. Its preservation check confirmed all 196 existing summary records, 1,495 original checkpoints and 231,501 archived messages were unchanged. It added 1,012 checkpoint aliases for reuse across 16 chats. These aliases are existing work, not additional API-generated analyses. Discord/WhatsApp reconnected, the authentication checks passed, and the tunnel remained healthy.

Up to three independent API requests run at a time (`ARCHIVAL_ANALYSIS_CONCURRENCY=3`). Analysis runs in a supervised worker thread, separate from the collector/HTTP event loop, with a 192 MiB worker heap limit and one active conversation plan. Completed chat briefings update at most once per five minutes during activity. Initial history analysis is asynchronous. Hourly server summaries and server-text deletion are deferred until the user configures a guild allowlist.

The API combining policy groups up to six chronological notes using a 90,000-byte budget for the actual request input. Original reading batches, detailed chapter findings, source/author/date checks and published summaries are preserved. Completed legacy combining subtrees are reused, including a finished legacy root; new combining hashes use a separate policy tag for deterministic restart recovery. Prepared nodes, grouping, dates and evidence indexes are cached. Cached combining nodes do not reconstruct request snapshots, and each request clones only its relevant evidence instead of the lifetime source index. HTTP 429/503 backoff is shared across lanes. A worker interruption restarts automatically from durable checkpoints.

This follows the [OpenAI latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization) to reduce request count, parallelize independent work and avoid repeated application work. Reading batch sizes and output detail were retained rather than reduced for speed. Failed validation discards its prepared request baseline so partial findings cannot contaminate a successful retry.

Archive write transactions use `BEGIN IMMEDIATE`: ingestion reserves the SQLite writer before reading, so a concurrent analysis commit cannot invalidate its read snapshot during an upgrade to a write. A failed collector event remains unacknowledged. Its process gets a bounded shutdown (SIGTERM, then SIGKILL after two seconds if blocked waiting for the withheld acknowledgement) before restarting from persistent recovery cursors.

Read-only benchmark against 140 real saved batch outputs: initial plan load 5,986 ms, first cached-tree traversal 593 ms, repeat traversal 25 ms. First-level API groups fell from 70 pairs to 24 groups (23 groups of six plus one pair); its first request input was 53,107 bytes. These are planner measurements, not guaranteed end-to-end completion times. A separate real Luna request on six invented notes passed checks for changed preferences, cancelled meetings, distinct author profiles and original evidence attribution (2,221 input / 593 output tokens, approximately 6.1 seconds).

First production throughput observation: 30 new reading checkpoints spanned 117.1 seconds, equivalent to 14.9 completed batches/minute over that window, with median API duration 11.44 seconds. The earlier single-lane median completion gap was 12.26 seconds (about 4.9/minute during uninterrupted reading); its overall window included interruptions and is not a clean comparison. The service settled to 353 MiB after a roughly 500 MiB startup peak, with no current worker error or automatic main-process restart. Throughput varies with chat size, output length and upstream limits.

The first large production chat completed 145 reading batches covering 15,377 eligible texts, then published its final synthesis after 33 combining calls in approximately 4.9 minutes (including a deployment restart). Its 64 saved claims cover 12 people and cite 185 original messages. A separate read-only audit found zero missing source messages or wrong-author profile citations. This checks coverage and attribution; it does not certify every model interpretation. Processing then advanced automatically to the next chat.

First real API validation succeeded: 2,339 input tokens, 887 output tokens, valid grounded chat analysis. Subsequent production calls and checkpoints advanced. Unit and regression suite: **105 passed**. Collection and API processing were verified without sending messages to contacts. Browser visual inspection remains unavailable in this environment.

## Service management

```bash
sudo systemctl status archival
sudo systemctl restart archival
sudo journalctl -u archival -n 30 --no-pager
sudo systemctl show archival -p MemoryCurrent -p NRestarts
```

The enabled systemd service starts at boot and restarts after process exits. It runs as `archival`, with a read-only application filesystem, private temporary directory, 256 MiB Node heap limit, 160 MiB Go memory target, 500 MiB memory pressure threshold and 650 MiB hard service limit. Measured service memory while collecting and analyzing was roughly 160–400 MiB, with a roughly 500 MiB startup peak; long-running behavior still needs observation. A controlled main-process termination triggered an automatic systemd restart (`NRestarts=1`) with stored checkpoints retained.

The deployment collects and summarizes. Discord DM and group DM sending is enabled on the VM; see the sending section below. Read-only Gmail archiving is deployed, and the historical Gmail threads are available in Misty's archive search. Connecting the mailbox through Google OAuth is still required for new mail to sync; see [Gmail in Misty's VM archive](misty-gmail.md). WhatsApp and Gmail sending are not enabled on the VM.

## Discord sending from Misty

The website composer sends plain text from the owner's Discord account in connected, tracked DMs and group DMs. The server verifies the account and private destination before sending. Submission IDs prevent the same request from being sent twice, and confirmed outgoing messages enter the archive as the owner's messages. Existing Cloudflare Access and request-origin checks protect the website endpoints.

An owner with SSH access can also generate a draft or explicitly send from the VM. These commands run on the VM:

```bash
# Generate a draft only.
sudo runuser -u archival -- /opt/archival/bin/node /opt/archival/scripts/misty-message.mjs \
  --channel DISCORD_CHANNEL_ID --instruction "Write the message I describe here."

# Generate and send when explicitly instructed; keep the same ID when checking this submission again.
sudo runuser -u archival -- /opt/archival/bin/node /opt/archival/scripts/misty-message.mjs \
  --channel DISCORD_CHANNEL_ID --instruction "Write the message I describe here." \
  --send --id chat-REPLACE_WITH_A_UUID
```

The AI uses the existing Luna model, recent messages and saved chat analysis as reference. Chat content is treated as untrusted reference material. The CLI defaults to drafting; `--send` submits the message. There is no scheduled or automatic reply policy. Website users currently type their messages in the composer; AI generation is available through the owner CLI and authenticated draft endpoint.

On 2026-10-22 at 11:37:49 UTC, one explicitly authorized AI-generated test notice was sent to Roumak (the owner's Rumal nickname). Discord's returned message and a separate channel-history read confirmed message `100000000000000044`, the correct destination and the owner's Discord identity. The archive records it as `is_me=1`; the outbox status is `sent`. The 28 focused sending, composer and runtime checks passed on the VM. Browser rendering was not visually inspected.

Rollback source and a consistent pre-install archive snapshot are under `/var/lib/archival/native-chat-before-20261022T113635Z`. Deployment retained all 234,035 archived messages, 241 saved chat analyses and 3,903 analysis checkpoints, with credentials and runtime settings unchanged.

## Finish Cloudflare

The `archival-vm` connector is installed, enabled at boot and connected through four Cloudflare edge connections. Its readiness endpoint returns 200; measured memory varied from about 16 to 28 MiB. It runs as an unprivileged `cloudflared` user and reads a root-owned, group-readable token file at `/etc/cloudflared/archival-token`; the token is absent from process arguments. Access issuer/audience are configured. Live checks rejected unsigned requests to the homepage, JavaScript and APIs with 401, untrusted Host headers with 403, and forged RS256/none tokens with 401. Public HTTPS redirects all checked paths to the exact configured Access issuer and application AUD.

**Origin protocol:** the route uses **HTTP** with service URL **http://127.0.0.1:8787**; cloudflared received this as configuration version 2, and the owner confirmed the dashboard loads. Selecting HTTPS for this service produces Cloudflare 502 with `tls: first record does not look like a TLS handshake`. The public browser address remains HTTPS; the HTTP hop is loopback inside the VM.

1. Access application: `archival.example.com`; Allow → Emails → `user-17@example.com`; One-time PIN enabled.
2. Tunnel name: `archival-vm`; Debian/Ubuntu 64-bit connector.
3. Save the displayed connector command in local `data/deployment/cloudflare-install.txt`. Treat it as a secret.
4. Origin service: **HTTP**, `127.0.0.1:8787` (full URL `http://127.0.0.1:8787`).
5. Configure `ARCHIVAL_PUBLIC_ORIGIN=https://archival.example.com`, `CF_ACCESS_ISSUER=https://TEAM.cloudflareaccess.com`, and `CF_ACCESS_AUD=APPLICATION_AUD` in `/etc/archival/runtime.env`, preserving `ARCHIVAL_ANALYSIS=on`.
6. Restart Archival and install/start the tunnel. Verify unauthenticated requests cannot obtain bootstrap, API or static app data. Complete an owner login before calling public access finished.

Cloudflare's current package instructions: [official repository](https://pkg.cloudflare.com/). Origin validation follows [Cloudflare Access JWT documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Backups

The VM backup timer runs daily at **03:00 India time**, with up to five minutes of random delay. It retains three completed backups in `/var/backups/archival`. Each contains consistent SQLite snapshots of the archive and WhatsApp session, credential/configuration files, source and dependency pins. Each database is verified before packaging; a file manifest and SHA-256 checksum identify the completed artifact. A pinned WAL read snapshot lets message collection continue without repeatedly restarting the backup copy. The two databases are snapshotted separately.

The backup service has a 128 MiB memory limit, 40% CPU quota and low CPU/I/O priority. The website and collector continue running during backups. Failed backups do not replace `latest.json`. Credentials are included for recovery: backups are protected by file permissions and SSH during transfer, and are **not encrypted at rest** by these scripts.

The Windows task **Archival VM backup** copies the latest completed backup at **19:00 India time** and at sign-in when the laptop is online. It verifies size and SHA-256 before accepting the copy, and retains seven copies in `data/vm-backups`, restricted to the current Windows user. A laptop shutdown does not affect VM collection; the off-VM copy waits until the laptop can run the task. Check `data/vm-backups/last-pull.log` for its latest outcome.

Manual copy and restore verification from the project directory:

```powershell
.\scripts\pull-vm-backup.ps1
python .\scripts\verify-vm-backup.py
```

The restore verifier checks every packaged file hash and opens temporary restored copies of both SQLite databases. It does not overwrite the active archive or print message text or credentials.

The first backup, `archival-20261021T164210Z.tar.gz`, passed a restore check on the VM: all 64 packaged files matched their manifest hashes; the restored archive contained 231,374 messages and 967 saved analysis checkpoints; both databases passed `quick_check`; and the restored WhatsApp session contained one linked device. The first laptop transfer is still running as of this deployment note. Its completed copy is accepted only after size and SHA-256 verification.

Update: the first laptop copy completed with matching size/SHA-256, and its restore check passed all 64 file hashes and both databases. Fixed explicit SQLite connection closure so Windows can remove temporary restored files. Future VM backups also include the Cloudflare token and the tunnel/backup systemd units when present.

## Remaining work

- Optional future work: custom Archival password login. Cloudflare Access email-code login currently works.
- Observe live traffic and continued private-chat analysis. All 144 currently connected Discord history jobs completed backfill, subject to upstream access/deletions.


## Finite WhatsApp G history recovery

The reviewed manifest is /var/lib/archival/whatsapp-group-choices.json. Only the 12 G groups import historical messages; the fixed cutoff and disabled live-group mode remain enforced. The collector requests 50 messages at a time without a total message cap, saves each cursor, retains delayed replies and makes two retries after an unanswered request. A phone timeout does not prove that the phone is offline or that its lifetime history has ended.

Each G group's paid analysis waits until its download settles, then automatically reads every eligible stored text in resumable chronological batches and combines summaries, people observations/preferences, events and follow-ups. Already saved results remain visible while recovery runs. A finished archive analysis means coverage of stored messages, not proof of lifetime WhatsApp coverage. S and I groups remain inactive.

Read-only current recovery/analysis audit (prints counts and dates, not message text or credentials):

```powershell
Get-Content -Raw -LiteralPath scripts/audit-whatsapp-group-history.py | ssh.exe -F data/deployment/ssh_config archival-vm 'sudo python3 -'
```

If the primary phone never returns some history, preserve the gap marker; do not replace it with a completed-lifetime claim. A larger initial phone sync or manually exported chat files may be needed to recover data beyond the linked-device response. Do not log out the current working session to try a fresh link without arranging that recovery step with the owner.
