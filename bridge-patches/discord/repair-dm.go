// Local extension to mautrix-discord (AGPL-3.0-or-later).
package main

import (
    "strconv"
    "sort"
    "github.com/bwmarrin/discordgo"
    "maunium.net/go/mautrix/bridge/commands"
)

var cmdRepairDM = &commands.FullHandler{
    Func: wrapCommand(fnRepairDM),
    Name: "repair-dm",
    Help: commands.HelpMeta{Section: HelpSectionPortalManagement, Description: "Recheck an existing DM after a message ID, including gaps before the latest bridged message", Args: "<channel ID> <after message ID>"},
    RequiresLogin: true,
}

func fnRepairDM(ce *WrappedCommandEvent) {
    if len(ce.Args) != 2 { ce.Reply("Usage: repair-dm <channel ID> <after message ID>"); return }
    for _, value := range ce.Args { if _, err := strconv.ParseUint(value, 10, 64); err != nil { ce.Reply("Invalid Discord ID"); return } }
    meta, err := ce.User.Session.Channel(ce.Args[0])
    if err != nil || meta == nil { ce.Reply("Could not read DM metadata"); return }
    if meta.Type != discordgo.ChannelTypeDM && meta.Type != discordgo.ChannelTypeGroupDM { ce.Reply("This command only repairs personal DMs"); return }
    portal := ce.User.GetPortalByMeta(meta)
    if portal.MXID == "" { ce.Reply("DM is not already connected"); return }
    if ce.Bridge.GetPuppetByID(ce.User.DiscordID).CustomIntent() == nil { ce.Reply("Enable Matrix double puppeting first"); return }
    portal.forwardBackfillLock.Lock()
    defer portal.forwardBackfillLock.Unlock()
    log := portal.log.With().Str("action", "DM gap reconciliation").Logger()
    after := ce.Args[1]
    for {
        messages, err := ce.User.Session.ChannelMessages(meta.ID, messageFetchChunkSize, "", after, "", portal.RefererOptIfUser(ce.User.Session, meta.ID)...)
        if err != nil { ce.Reply("DM reconciliation failed for %s: Discord history request failed; retry later", meta.ID); return }
        sort.Sort(MessageSlice(messages))
        portal.sendBackfillBatch(log, ce.User, messages, nil)
        for _, msg := range messages {
            if (msg.Type == discordgo.MessageTypeDefault || msg.Type == discordgo.MessageTypeReply) && portal.bridge.DB.Message.GetByDiscordID(portal.Key, msg.ID) == nil {
                ce.Reply("DM reconciliation failed for %s: message delivery failed; check bridge logs", meta.ID); return
            }
        }
        if len(messages) < messageFetchChunkSize { break }
        after = messages[len(messages)-1].ID
    }
    ce.Reply("DM reconciliation finished for %s; delivery verified", ce.Args[0])
}
