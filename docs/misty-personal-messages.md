# Send personal messages through Misty

Tell Misty who to message, which platform and what you want to say. For example:

> Tell Roumak on Discord that I'll be there in 10 minutes.

Misty finds the existing connected chat and shows a preview with the platform,
recipient, chat ID and exact text. **Reply `yes` after the full preview** to send
that one message, or `no` to cancel. Changes require a fresh preview and another
yes. A preview expires after 10 minutes. If the conversation moves on, use
`yes DRAFTCODE` or request a fresh preview to avoid approving the wrong thing.

This supports connected Discord DMs/group DMs, existing selected Discord server
text/announcement channels and accessible active threads, and WhatsApp DMs/groups
classified as group DMs (`G`). Ignored/unselected Discord servers and server-style
WhatsApp groups remain excluded. Sending does not enroll or join a destination.
Text only. Discord has a 2,000 character limit; WhatsApp has a 20,000 character
limit in this composer. Existing website sending stays available.

The Node bridge stores the immutable target/body digest, every preview delivery
receipt, the real owner confirmation and the submission ID. It verifies that the
complete preview arrived before the owner's yes. Codex task grants, model output,
scheduled workflows and archive text cannot approve a personal message. Apollo's
read-only bridge rejects the personal-message operations.

The sender reuses the existing personal sessions. Discord verifies the owner and
private channel, or the exact guild/channel/thread, membership and effective posting
permissions. Archived/locked threads and unsupported destinations fail closed.
For replies, it reads and verifies the exact existing message in that destination,
including its author, text fingerprint and source link. This is checked again before
submission. The preview binds the destination, reply reference and exact outgoing text;
any change requires a new preview and yes. Mentions and reply pings are suppressed.
The reply uses `message_reference` with `fail_if_not_exists: true` so a missing original
cannot silently turn into a top-level post. The acknowledged journal records guild,
channel, reply and outgoing message IDs plus the verified Discord post URL.
WhatsApp verifies the linked owner and connection. WhatsApp uses
the installed [whatsmeow SendMessage interface](https://pkg.go.dev/go.mau.fi/whatsmeow#Client.SendMessage)
with a stable submission-derived message ID. Both transports use the durable
`chat_outgoing` journal. Uncertain results are reconciled by reading receipts;
they are never automatically resubmitted. “Sent” means acknowledged by the
platform, not read by the recipient.

Internal CLI:

```text
misty.py message-draft ROOM_ID "exact text"
misty.py message-inspect ROOM_ID --reply-to MESSAGE_ID_OR_SOURCE_OR_LINK
misty.py message-draft ROOM_ID "exact reply" --reply-to MESSAGE_ID_OR_SOURCE_OR_LINK
misty.py message-confirm DRAFTCODE
misty.py message-status DRAFTCODE
```

The CLI receives the current owner message ID from the owner-turn environment.
Passing a confirmation code alone is not approval. The actual recorded owner
message must be a fresh yes following that exact delivered preview.

`--reply-to` is optional and currently applies only to Discord server replies. It
accepts a message snowflake, `discord:CHANNEL_ID:MESSAGE_ID`, or a canonical
`https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID` link. Embedded channel
and guild IDs must match. `message-inspect` is read-only: no draft, approval or post.
Missing/expired originals are reported as unavailable, never reconstructed from a
summary. Existing private-chat drafts keep their original format and approval digest.

Server posting has been verified through mocked transports and read-only live
inspection; deployment tests do not send or delete real messages. The owner must
still request the full official preview and then provide a fresh yes for each post.

Loopback ports 8795 (archive sender) and 8796 (linked WhatsApp sender) use a
separate sender credential loaded only into the required services. No public
Cloudflare route is added for either endpoint.
