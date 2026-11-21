# Misty in your Discord DMs

Misty runs as a separate official Discord bot on the VM and responds only to the owner's Discord account (`100000000000000023`) in its own one-to-one DM. It uses the existing Luna API model. Text conversation and API usage are saved in `/var/lib/misty-bot/chat.sqlite`. The bot has its own service and cannot access the personal Discord session or message archive. Archive search and sending to other people can be designed later.

The current chatbot uses **high reasoning**, saved conversation history and versioned knowledge of its capabilities, purpose and Codex relay. It can discuss ideas and recommend commands naturally. See [Misty and Codex controls](misty-codex-relay.md) for the current workflow and memory behavior.

Task approval now uses [interactive Discord cards](misty-interactive-discord.md): a chat dropdown and Send to Codex, Edit prompt, Find chat and Cancel controls. The bot's voice uses a bounded profile of the owner's own messages; the running service still has no direct archive database access.

## Create the bot

1. Open [Discord Developer Portal](https://discord.com/developers/applications), select **New Application**, and name it **Misty**.
2. Open **Bot**. If the page offers **Add Bot**, select it. Set the bot name to **Misty**.
3. Under **Token**, select **Reset Token** and copy the new bot token. Save only the token in this local file: `C:\Users\Public\Downloads\misty\data\deployment\discord-bot-token.txt`. This is a separate bot credential; do not use your personal account token.
4. Leave **Presence Intent**, **Server Members Intent** and **Message Content Intent** off. Receiving text in the bot's own DMs does not require Message Content Intent. Leave **Requires OAuth2 Code Grant** off.
5. Create an empty private Discord server if you do not already have one you own. In the Developer Portal, open **OAuth2 → URL Generator**, select the **bot** scope and leave bot permissions unchecked. Open the generated URL and add Misty to that server. If the page asks for an integration type, choose **Guild Install**. No Administrator permission is needed.
6. Once invited, open your server's member list, right-click **Misty**, and select **Message**. Send `!ping` after the VM service is connected. Then send an ordinary text message to test the AI reply.

If you disable **Public Bot**, the Installation page may require **Install Link → None** before saving. The owner can still use the manually generated OAuth2 bot invitation. If Discord blocks DMs, allow direct messages for the private server and open the conversation yourself.

Discord's [bot setup guide](https://docs.discord.com/developers/quick-start/getting-started) describes applications, bot tokens and installation. The [Gateway documentation](https://docs.discord.com/developers/events/gateway#message-content-intent) documents the DM exception to Message Content Intent.

## Conversation commands

- `!ping`: checks the bot connection without making an AI API call.
- `!help`: explains supported behavior.
- `!context`: reports reasoning/model, saved conversation coverage and catalog information.
- `!reset`: cancels pending task drafts, preserving approved jobs, saved chats and conversation memory.
- Ordinary text: talks naturally using the saved DM conversation, product context, real Codex catalog and current task state. Clear work requests get a rewritten prompt and proposed chat for explicit approval; discussion alone creates no task. Attachments without text currently receive a request for a text description.

## VM operations

The enabled `misty-bot.service` starts after a bot token has been installed, starts at boot and restarts after failures. It uses its own `misty-bot` OS user, systemd-provided credentials, a 170 MiB memory limit and a 35% CPU quota. It opens an outbound Discord Gateway connection; no new website, DNS route or inbound firewall port is needed.

```bash
sudo systemctl status misty-bot
sudo cat /var/lib/misty-bot/status.json
sudo systemctl restart misty-bot
```

Bot replies have persistent submission IDs and Discord nonces. Interrupted drafts can resume. If delivery has an uncertain outcome, the bot records it as unknown instead of automatically sending another copy. On reconnection, it checks messages since its durable cursor, limited to the period since the bot was first started. Existing archive and WhatsApp/Discord collectors are independent of this bot service.

The bot's conversation database and bot token are separate from the current Archival backup set.

## Connection verified on 2026-10-22

The owner supplied the bot token and invited Misty. The service authenticated bot `100000000000000045` and verified its one-to-one channel with the owner: [Open Misty's DM](https://discord.com/channels/@me/100000000000000046).

The first live connection stalled with the archive bridge's library fork. The bot now has its own pinned upstream `github.com/bwmarrin/discordgo v0.29.0` module and dependency checksums under `collector/cmd/misty-bot-gateway`, plus a 60-second startup timeout. The separate module leaves collector dependencies unchanged. After installing that binary, Discord Gateway READY and channel-history catch-up completed; status became `online`.

The owner confirmed the bot works. The VM received real owner message `100000000000000048`, generated a completed Luna response and recorded reply `100000000000000049` as sent with no error. A separate one-time AI welcome notice was sent and independently read back from Discord as message `100000000000000050`. Final service memory was about 26.5 MiB, both bot and archive services were enabled/active with zero automatic restarts, both archive collectors were connected and the analysis-worker error was empty. This confirms the actual receive, AI reply, send and persistence path.
