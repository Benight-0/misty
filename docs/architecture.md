# Architecture and historical deployment notes

These notes describe earlier development configurations and benchmarks. Start with [setup](setup.md) for a new installation; service availability and installed accounts described below are not included in this source snapshot.

## Archival: your custom local archive

**Open [Archival](http://127.0.0.1:8787)**. It provides conversation history and search, DM/group/channel filters, follow controls, aliases for chats and people, verified own-message identification, an editable personal profile with source-message links, and sync diagnostics.

### Start it

1. Keep Docker Desktop running, and start the existing messaging stack with `docker compose up -d`.
2. Double-click **Start Archival.cmd** in this folder, or run `npm.cmd start` here. Requires Node 22.13 or later; there are no npm packages to install.
3. Open **http://127.0.0.1:8787**. If it is already running, simply open the URL. Closing its console stops a manually launched instance.

The app starts with your stored archive immediately. It maintains a persistent local PostgreSQL reader through Docker and polls for new events approximately every 1.5 seconds after each completed query. Metadata refreshes every minute. Messages and the stream checkpoint commit together. Interrupted snapshots are retried without partially committing messages or advancing the checkpoint. First imports and full rescans can take longer; normal restarts use the saved checkpoint.

### Choose what to keep

- In **Conversations**, filter DMs or groups/channels, pick a chat, and open its gear button.
- **Connect to this app** controls whether Archival imports that room. **Archive new messages** pauses or resumes local collection. Existing archived messages remain when either is disabled. Re-enabling runs an idempotent history rescan.
- **Follow** pins the conversation. **Include in your profile** determines whether your messages there may support visible profile findings. All currently connected chats were included in the initial review.
- These are local archive controls. They do not log out of Discord/WhatsApp, leave their groups, or guarantee that an upstream bridge stops receiving that DM. Use Element/bridge controls for upstream account changes.
- **Connect a chat** can join an already bridged local Matrix room using its ID/link, or request an individual Discord channel portal. A new portal invitation may need accepting in Element. Link bridged accounts in Element; link Gmail directly in Archival's Sync & storage page. Discord portal creation uses the bridge's [documented create-portal capability](https://github.com/mautrix/discord/blob/main/CHANGELOG.md).
- In **People & identities**, edit aliases or mark an additional account as yours. Initial ownership uses your stable Discord ID and WhatsApp phone plus its verified LID, not display-name matching.

### Send Discord and WhatsApp messages

Open **Conversations**, select a connected Discord or WhatsApp chat, write in the composer below its history, and click **Send**. This uses your existing linked account. Discord DMs, group DMs and allowed server channels are supported, as are WhatsApp DMs and groups subject to their permissions. Docker, Archival and the bridge account connection must be running. Sending does not wait for the lifetime archive import to finish.

- Plain text only: up to 2,000 characters for Discord and 20,000 for WhatsApp. Enter inserts a new line; only clicking Send submits. Attachments, replies to specific messages, editing and deletion are not implemented.
- **Queued locally** means Matrix accepted the message and the bridge has not confirmed it yet. It may be forwarded when a temporarily disconnected bridge reconnects. **Sent to Discord/WhatsApp** means the bridge confirmed sending, not that the recipient read it.
- **Send history for this chat** shows the last 30 attempts from Archival. Failed attempts explain the problem. Unconfirmed submissions require checking the native app before unlocking the composer and sending another copy. Lost local HTTP responses can retry the same submission ID; they cannot create a duplicate Matrix submission. There are no automatic app send retries.
- Drafts survive switching chats within the current page session. Reloading the page clears unsent drafts. Accepted attempts persist in the local archive. Pausing archive collection does not disable manual sending, but disconnecting a chat does. Excluded Discord servers and encrypted Matrix rooms cannot be sent to here.

Both bridges have message status events enabled. Archival imports those confirmations alongside normal message events. Sending does not alter the 20-message server history caps or excluded server list. See the [Matrix transaction rules](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers) and [mautrix sending configuration](https://docs.mau.fi/configs/mautrix-whatsapp/v26.01.html).

### Private chat briefings, people and events

Open **Chat briefings** in the sidebar, or choose **Briefing** inside a private conversation. Scope is connected Discord DMs and group DMs, plus direct WhatsApp chats. Discord server channels, WhatsApp groups, Gmail, Instagram and Telegram are excluded.

Each chat has a saved overview, latest-exchange summary, possible follow-ups, participant profiles and local events. **Full-history analysis reads every eligible archived text message in chronological batches**, then combines all batch findings into a lifetime briefing. Short messages are included. Long messages are split without a text-length cutoff. Images, audio, files, Discord bots and bridge notices are not interpreted. Quoted reply fallbacks are removed to preserve authorship; copied/forwarded text is included as context but cannot support the sender's profile. Full history means the text already available in the archive, not messages missing from it. Topic mentions do not prove liking or permanent personality traits.

Automatic interpretation uses your **already installed local Ollama model `gemma4:e4b`**. Archival starts its own loopback-only Ollama service at `http://127.0.0.1:11435`, with **three parallel requests**, Flash Attention and the original f16 cache precision. Cloud inference is disabled in this service. Your usual Ollama service and its settings are unchanged. If the managed service cannot start, a visible notice explains the fallback to one request through the normal local service on port 11434. Keep Archival running; the installed model is reused without downloading another model.

The worker runs separately from message sync, starts the next batch immediately when a slot is free, and saves each completed batch and combination step in `archive.sqlite`. Requests retain the original full-message input format, and the model is asked to omit unnecessary JSON whitespace while retaining details and explicit preferences. Each individual finding cites up to four strong supporting messages, including later qualifying or cancelled statements, rather than listing every repeated mention. Distinct findings still have their own evidence. Older cached findings keep their original citations. Parallel requests claim separate batches; synthesis waits for all its children. Existing checkpoints are reused, so upgrading does not restart the whole analysis. The progress panel reports full-history chats, batches, messages and parallel requests; a chat is ready only after all batches and synthesis finish. Smaller histories finish first. Previous sampled briefings remain visible with their old coverage clearly marked until replaced. The first full pass is substantially more work than sampling; cached viewing and ordinary message sync remain independent.

The [Ollama concurrency documentation](https://github.com/ollama/ollama/blob/main/docs/faq.mdx) explains that parallel contexts require extra memory. Four slots caused partial CPU offload on this laptop during testing. Three slots fully offloaded the model and, with bounded citations, completed six matched synthetic batches in 122.835 seconds versus 155.350 seconds for the previous two-slot configuration (about 26% more throughput). This is a small benchmark, not a guaranteed archive-wide speed. Local runtime logs and settings are in `data/app/ollama-runtime.log` and `data/app/ollama-runtime.json`. The normal Archival shutdown stops its owned helper. A synthetic, local benchmark can be run with `node app/analysis-speed-benchmark.mjs` while Archival is closed and the normal Ollama service has no model loaded; it temporarily tests serial and parallel runtimes and saves timing and quality counts in `data/app/analysis-speed-benchmark.json`. Use `--capacities=2,3 --requests=6 --citation-test` for the current comparison. `node app/server.mjs --no-analysis` keeps Archival browsing and message sync running while analysis is paused for benchmarking; restart normally to resume from checkpoints.

Open **History findings** in a briefing to browse the chronological batch summaries, participant observations/preferences and historical events with source links. These detailed records remain available even when the combined overview condenses them. Reading every input message does not mean an AI summary retains every detail or always interprets it correctly. Silent members cannot be profiled.

- **Emerging topics:** comparisons of topic mentions over the last 30 days and preceding 30 days, with counts and sources. These describe growing attention within a chat, not predictions of outside events or what someone will do next.
- **People:** observations cite that author's own messages. Explicit preference claims require a first-person source. Sparse histories are marked as insufficient. Expand a person and use **Edit chat-specific name / notes** to customize their profile; those notes survive AI regeneration. Your existing personal profile is preserved separately.
- **Events:** extracted plans start as **proposed**, never automatically confirmed. Use **Review event** to correct the title, details, date, time, people and status. Create your own with **Add event**. The Events view separates upcoming, undated and all plans. Done, cancelled and dismissed plans are excluded from Upcoming.
- Dates such as "tomorrow" use the original message timestamp in India time, not the analysis date. Ambiguous dates and missing years stay unresolved. A model-supplied date must match a date cue in its sources. Times are only supplied through your review. These are local notes; there are no invitations, notifications, calendar writes or automatic outgoing messages.
- New messages, edits and deletions queue only the affected chat. Unchanged batches reuse their saved results; changed batches and dependent combinations are regenerated. New messages generally affect the last batch; backfills/deletions can move later batch boundaries. Routine updates are debounced and limited to once per five minutes per chat; **Refresh this chat** prioritizes an immediate update. **Pause analysis** preserves completed checkpoints and user notes. Disconnecting a chat removes it from briefing views. Deleted or edited source claims are hidden until regeneration, and history browsing only uses batches matching the current archive.

Chat text is treated as untrusted data, with no model tools or code execution. Outputs are schema-constrained and source-checked, but a local model can still misunderstand messages: review its interpretations and event suggestions. SQLite backups include batch checkpoints, briefings, events and profile notes. After shutdown, the worker reuses completed batches and resumes outstanding work when Archival restarts. A truncated/failed model result is not counted as completed. This feature preserves the separate reviewed personal profile.

### Gmail accounts

Connect each mailbox under **Sync & storage → Gmail accounts**. Create one Google **Desktop app** OAuth client, enable Gmail API, and upload its downloaded JSON into the local file picker. Follow the [complete setup guide](gmail-setup.md), including the seven-day Testing token limitation. Passwords are entered only on Google.

The connector requests `gmail.readonly` and `gmail.send`. It imports available received/sent/archived mail into searchable, separately named mailbox threads, with no intentional age or count cap. Drafts, Spam and Trash are excluded from new imports; previously archived emails stay stored after upstream deletion. Attachment metadata is retained, but attachment files and remote images are not downloaded. Gmail's sent-mail label identifies own messages, including aliases; incoming From headers do not prove authorship.

Use **Compose email** to choose a connected From mailbox, enter To/Cc/Bcc, subject and plain text, review, then send. Stored Gmail messages have a **Reply** button that preserves the original mailbox and thread. **Send history** lists prepared emails and outcomes. Old read-only connections need `gmail.send` added in Google's Data Access and a new consent flow through **Add / reconnect Gmail account**; reuse the existing OAuth client JSON. Sending works before the full archive scan is finished. Attachments, rich HTML, send-as aliases, automatic Reply all and undo-send are not implemented.

Prepared emails and their immutable MIME snapshots are stored locally in `gmail_outgoing`. Each prepared email is submitted at most once; uncertain outcomes are never retried automatically. If the connection drops after submission, check Gmail Sent before creating another copy. A successful Google response confirms acceptance, not recipient inbox delivery. Sent-mail archive failures cannot change a confirmed send into a failed send.

Initial imports use four concurrent body requests and resumable page checkpoints. Later polls use Gmail history approximately every 15 seconds, with cached full scans if Google has expired the history cursor. Gmail runs independently of Docker and the Matrix sync loop. Account pause/removal and per-thread tracking controls preserve existing mail. Gmail threads start excluded from personality analysis; opt in through conversation settings.

Client credentials and tokens live in **data/gmail/credentials.json**, outside the public assets and API responses. This file is sensitive and is not included by the SQLite backup command. The archive remains local, while Google receives normal API/login traffic. See the setup guide for privacy boundaries, revoking access, and troubleshooting.

### Lifetime Discord DM and group DM history

Archival automatically imports all history Discord still makes available for every connected, tracked Discord DM and group DM. Newly connected private chats get the same treatment. Open **Sync & storage** to see completed chats, fetched messages, and any failures; each private chat also shows its history status. No message-count cap is applied to this archive.

Older messages go directly into **data/app/archive.sqlite**, with the original Discord message JSON, author IDs, timestamps, text, attachments and embed metadata. Discord IDs deduplicate historical messages against live bridge events, including attachment parts. This full older history appears in Archival; it is not copied into Element/Matrix. Attachment files are not downloaded, so their remote URLs may later expire. Deleted or inaccessible history cannot be recovered.

The importer uses at most three concurrent history requests across separate chats, reuses connections, and respects Discord retry responses. Each page and its checkpoint commit together. After shutdown or interruption, it resumes from saved progress rather than starting over. Disconnecting a chat or pausing **Archive new messages** pauses its history import and keeps stored messages. The existing live bridge continues receiving new messages while the history importer runs. Private-message edits and deletions received by the bridge also update the local archive, including messages stored only by the history importer. Edits/deletions missed while everything is offline are not guaranteed to reconcile automatically.

This lifetime import applies to Discord private chats. Server channels retain their existing 20-message initial/catch-up limits, and the 13 excluded servers remain excluded. WhatsApp and other adapters retain their existing history capabilities.

### Profile and its limits

The revised review searched **51,671 own-message entries across 289 conversations**, with close reading of **1,281 selected excerpts across 279 conversations** and nearby context where needed. It contains **50 detailed findings across 10 areas**, with 240 evidence references. This was a corpus-wide scan followed by targeted excerpt review, not exhaustive line-by-line reading of all 51,671 entries. The snapshot spans January 2024 to October 2026 and includes Discord and WhatsApp.

The revision expands creative interests, learning style, practical work, social preferences, priorities, and patterns to watch. **data/app/profile-analysis.md** contains the full written report. Only verified own messages support findings. Known reference pastes, forwarded voices, incident notices, and potentially sensitive identifiers are excluded from profile analysis while remaining in the archive. Exclusions resolve historical message aliases and also apply to topic counts and conversation-fit suggestions. Jokes and fictional speakers are not treated as literal beliefs. The profile separates explicit statements, recurring observations, and dated situations; it does not infer clinical labels or permanent dislikes from isolated frustration.

Review findings under **Your profile**: open their original source messages and nearby context; confirm, edit, dismiss, or export them. Your edits persist across refreshes. Excluding a conversation removes its eligible evidence; a saved interpretation with other remaining evidence is not automatically rewritten. Conversation fit is a transparent topic-overlap and participation suggestion, not an autonomous decision to speak for you.

The initial semantic review was performed in this Codex conversation using the available chat entries. **The running application does not call an external AI service.** Private chat briefings use your local Ollama model; the reviewed personal profile is separate. Future messages automatically update local topic counts, but new detailed semantic interpretations require another review. Coverage dates and reviewed-message counts are shown in the app; newly arriving or newly backfilled messages can exceed that reviewed snapshot.

### Storage, backup, and privacy

- **data/app/archive.sqlite**: messages, full-text index, aliases, preferences, profile findings, and sync checkpoint. This is separate from bridge databases.
- **data/app/reviewed-profile.json**: detailed review and evidence IDs. The profile export button downloads the current visible findings.
- **data/app/matrix-session.json**: private local Matrix session used for room connection actions and explicitly submitted Discord/WhatsApp messages. Never share this file, `.env`, or bridge configuration credentials.
- **data/app/own-messages.json**: private snapshot prepared for the initial review; it is not a continuously refreshed export.
- Text and attachment references are archived. Discord lifetime imports also retain raw message metadata, including the reaction summary returned by Discord; there is no dedicated reaction interface or full reaction history. Attachment bytes, calls, and encrypted event decryption are not implemented. Some old attachments from other bridge sources are only placeholders.
- Run `npm.cmd run backup` for a consistent SQLite backup under **data/app/backups/**, including while the app is running. Store backups privately. Do not copy only the main SQLite file while its WAL is active.

Archival binds only to `127.0.0.1:8787`, rejects foreign hosts/origins, and requires a session token for changes. The app's browser assets use no external fonts, analytics, or CDNs. The bridges still connect to their respective messaging services. Archival adds no disk encryption or Windows-user authentication; someone with access to this Windows account or disk can read the archive. Local storage is not a guarantee that nobody can ever access it.

When the laptop is off, the files remain but synchronization stops. Restart Docker and Archival to catch up on what the bridges retrieve. Gmail catches up directly through Google when Archival runs. The existing **20-message Discord channel backfill/catch-up settings remain in force**; long offline periods may leave upstream history gaps that a Archival rescan cannot repair. The previously excluded 13 servers remain excluded. Instagram/Telegram appear after linking and joining rooms; Slack has no connector in this workspace yet.

### Verify

`npm.cmd test` checks identity matching, reply quoting, edits, redactions, search removal, persistent preferences, checkpoint failure behavior, lifetime-page replay and consolidation, profile attribution, and local HTTP protections, plus the existing Discord importer tests. `npm.cmd run benchmark` records current local HTTP timings in **data/app/verification.json** without exporting message bodies. The implementation is plain Node, SQLite FTS5, and static browser assets.

This workspace runs a local Matrix homeserver (Synapse), Element Web, and mautrix bridges for Discord personal messages, WhatsApp, and Instagram personal messages. Telegram is configured but stopped until you add your own Telegram API ID and hash. Discord and WhatsApp accounts are linked. Instagram is ready to link.

## Open the inbox

1. Keep Docker Desktop running. From this folder, run `docker compose up -d` if the stack is stopped.
2. Open **http://127.0.0.1:8080** in a browser on this computer.
3. Sign in as `owner` (Matrix ID `@owner:localhost`). The generated password is in `data/owner-password.txt`. Keep that file private.
4. Three private management rooms are ready: **Discord bridge**, **WhatsApp bridge**, and **Instagram bridge**. Each bot has joined its room. Send the command in the appropriate room to link an account.

Only localhost ports 8080 (Element) and 8008 (Synapse) are published. Public Matrix registration and federation are disabled. This is a single-computer setup, not yet a remotely accessible service. Docker Desktop must remain running for synchronization.

## Link accounts

- **Discord personal account and DMs:** In **Discord bridge**, send `login-qr`, scan with the Discord mobile app, and approve the login there. This uses your normal Discord user session, which is required for personal DMs. The [mautrix Discord authentication guide](https://docs.mau.fi/bridges/go/discord/authentication.html) notes possible account action for suspicious activity. QR login may encounter a CAPTCHA that the bridge cannot handle. Do not paste your Discord token into support chats or issue reports.
- **WhatsApp:** In **WhatsApp bridge**, send `login qr`. On your phone, go to **Linked devices** and scan the QR code. The [mautrix WhatsApp guide](https://docs.mau.fi/bridges/go/whatsapp/authentication.html) also documents `login phone` if pairing by code is preferable.
- **Instagram personal account:** In **Instagram bridge**, send `login instagram` and follow the bot's instructions. This pinned bridge version uses Instagram browser session cookies; see the [mautrix Meta authentication guide](https://docs.mau.fi/bridges/go/meta/authentication.html). Use a private browser window and its POSIX cURL copy option on Windows if prompted. The session data is sensitive. This local Matrix setup does not enable end-to-end encryption for its management or bridged rooms, so the credentials and chat databases must remain private. Instagram may challenge or block a suspicious session.
- **Telegram:** First create an application at [my.telegram.org/apps](https://my.telegram.org/apps). Put its `api_id` and `api_hash` into the `network` section of `data/telegram/config.yaml`. Then run `docker compose --profile telegram up -d telegram`. In Element, start a private chat with `@telegrambot:localhost`, and send `login qr` to pair from Telegram **Settings → Devices → Link Desktop Device**. The [mautrix Telegram guide](https://docs.mau.fi/bridges/go/telegram/authentication.html) also documents phone code login. Telegram's API keys identify the client application; account login is a separate step.

Start with one account, check that recent conversations appear, and test receiving and sending a message before linking the next account. The Discord bridge is configured to create portals for every private channel in Discord’s startup list (using a bounded limit of 150, above the 112 DMs discovered in the local bridge database), with 50 initial messages per newly created DM. Discord may omit older or closed conversations from that list, and full message history is not guaranteed. WhatsApp and Instagram initial backfill is capped at 100 messages per chat.

Discord server channels import up to 20 initial messages when a channel room is created and up to 20 missed messages when reconnecting. This controls history import, not message retention; live messages continue accumulating. To add a server, send `guilds status` in the Discord bridge management room, then `guilds bridge SERVER_ID --entire`, and accept its invitations. See the [Discord bridging guide](https://docs.mau.fi/bridges/go/discord/bridging-rooms.html).

## Add all listed Discord servers

The 83 server IDs remaining after your 13 exclusions are in `scripts/discord-server-ids.txt`. The excluded servers are unbridged. Run this from the workspace folder:

```powershell
node scripts/bridge-discord-servers.mjs
```

The script finds the Discord bridge management room and imports up to three servers at a time using `guilds bridge SERVER_ID --entire`. It skips servers already marked as fully bridged and checks `guilds status` to identify completions, because command confirmations do not identify their server. A separate loop accepts invitations with three workers and no room-count cap. Server retry responses are respected. The configured 20-message channel history import still applies when new channel rooms are created. Leave PowerShell open and let the script manage commands in the Discord bridge chat while it runs. The final summary reports verified server modes, outstanding servers, and any invitation errors. It stops new submissions on a bridge error or after 30 minutes without a server completion. Use `--concurrency 1` for sequential imports; values from 1 to 4 are accepted, with 3 as the default.

To check the server list and management room without importing anything, run `node scripts/bridge-discord-servers.mjs --dry-run`. Credentials are read from the existing local owner password file; the temporary Matrix session is logged out on normal exit or a handled error. Ctrl+C requests a stop after the current API call.

## Accept chat invitations

The owner account has a persistent [Synapse rate-limit override](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html) with `messages_per_second: 0` and `burst_count: 0`. This disables user rate limiting for `@owner:localhost`, including its room joins and messages. It remains enabled across restarts until removed. Other accounts retain the normal server limits.

All pending invitations were accepted after WhatsApp was connected. To accept future invitations in bulk, run from this folder with Node.js installed:

```powershell
node scripts/accept-invites.mjs
```

The helper accepts invitations from every sender, with no chat-count cap. It drains the current backlog, then watches for new invitations for up to 30 minutes, stopping after two minutes without new invitations. It respects any server retry responses and reports failures. To keep watching for longer, use `node scripts/accept-invites.mjs --watch-minutes 120 --quiet-seconds 7200`. It reads the local owner password, keeps its token in memory, and logs out its temporary session when finished.

To restore the owner's normal rate limits, run `node scripts/accept-invites.mjs --restore-owner-limits`.

## Operations

### Discord startup and live updates

The local Discord image `archival-discord:v0.7.7-dm-priority` uses upstream v0.7.7 commit `c62165a46109d7c824bc0b4bb067ba02ea6528f1` with patches in `bridge-patches/discord/`. Recent personal DMs catch up before the full server-channel scan. Private-room sender invitations use the room's joined main puppet, and a `repair-dm CHANNEL_ID AFTER_MESSAGE_ID` management command can reconcile gaps without resetting the room. It checks Discord history and verifies that regular messages reached the bridge database. Existing history limits still apply: unlimited missed DM messages, 50 initial DM messages, and 20 initial/missed server-channel messages. The 13 excluded servers remain excluded.

Automatic Matrix double puppeting is enabled for **@owner:localhost only**, using a separate local appservice registration at `data/synapse/appservices/doublepuppet.yaml`. The Discord bridge can therefore store your native Discord messages as your Matrix owner account. The registration and configured token are credentials; keep them private. This follows the [mautrix double-puppeting guide](https://docs.mau.fi/bridges/general/double-puppeting.html).

The recovery plan in `data/diagnostics/dm-repair-plan.json` contains the pre-recovery checkpoint for 92 existing DMs. `node scripts/repair-discord-dms.mjs CHANNEL_ID` rechecks one planned DM; omit the channel ID to process the plan sequentially with a pause between commands. This is an incident-repair utility, not the routine sync loop. It sends commands only to your private local bridge management room. It stops when a command reports a failure; check logs before retrying.

Discord's active database is now **Docker volume `misty_discord_db`, mounted at `/database/bridge.db`**. `data/discord/config.yaml` and registration remain in the Windows folder. The old `data/discord/bridge.db` is a migration snapshot, not the active database. A verified pre-migration SQLite backup and previous configuration are in ignored `data/diagnostics/`. Back up the native volume along with the PostgreSQL volume and `data/`; copying only the Windows folder no longer backs up the active Discord database. Never open a running bridge SQLite database using Windows SQLite tools.

Rebuild the local image with `docker compose build discord`, then apply it with `docker compose up -d --no-deps discord`. To roll back the executable, change only the Discord image to `dock.mau.dev/mautrix/discord:v0.7.7` and remove its `build` entry, retaining the native database mount and configured `/database/bridge.db` path. Do not restore the old Windows database over the current one.

After startup catch-up, the bridge receives live Discord Gateway events. Archival imports local events about every 1.5 seconds after each completed query. Its conversation list and open messages refresh every 5 seconds as the archive changes, preserving search, the Only me filter, and loaded history. These are polling intervals, not end-to-end latency guarantees; network retries, Discord rate limits, and local workload add time. The full server scan can still be expensive with thousands of channels.

- Status: `docker compose ps`
- Recent logs: `docker compose logs --tail 100 synapse discord whatsapp instagram`
- Stop without removing data: `docker compose down`
- Start again: `docker compose up -d`
- Telegram status and logs: `docker compose --profile telegram ps`; `docker compose --profile telegram logs telegram`

Bridge configuration is in `data/discord`, `data/whatsapp`, `data/instagram`, and `data/telegram`. WhatsApp, Instagram and Telegram SQLite databases remain in those folders; Discord's active SQLite database is in `misty_discord_db`. Synapse configuration, media, secrets, and appservice registrations are in `data/synapse`. Its PostgreSQL database is in `misty_postgres_data`. Back up `data/` and both named volumes while the stack is stopped. `.gitignore` excludes `data/` and `.env`; keep them private and do not commit them.

The bridge containers use `--no-update` because automatic config rewriting failed on this Windows bind mount. Config changes require a bridge restart. Do not regenerate appservice registrations casually: their tokens must match the bridge configs and the copies under `data/synapse/appservices`.

Gmail and Slack are not connected by this mautrix setup. They need separate adapters and authentication work for the planned unified backend.

Sources: [mautrix Docker setup](https://docs.mau.fi/bridges/general/docker-setup.html), [initial config](https://docs.mau.fi/bridges/general/initial-config.html), [appservice registration](https://docs.mau.fi/bridges/general/registering-appservices.html), and [Synapse Docker guide](https://github.com/element-hq/synapse/blob/develop/docker/README.md).
