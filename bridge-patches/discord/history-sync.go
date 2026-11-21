// Local extension to mautrix-discord (AGPL-3.0-or-later).
package main

import (
    "time"
    "maunium.net/go/mautrix/event"
)

var archivalHistoryType = event.Type{Type: "fi.mau.discord.history", Class: event.MessageEventType}

func (portal *Portal) archivalHistoryUpdate(user *User, messageID string) {
    if user == nil || user.Session == nil || portal.MXID == "" { return }
    session := user.Session
    for attempt := 0; attempt < 3; attempt++ {
        message, err := session.ChannelMessage(portal.Key.ChannelID, messageID, portal.RefererOptIfUser(session, portal.Key.ChannelID)...)
        if err == nil {
            _, err = portal.MainIntent().SendMessageEvent(portal.MXID, archivalHistoryType, map[string]interface{}{"op":"upsert", "message":message})
            if err == nil { return }
        }
        time.Sleep(time.Duration(attempt+1)*time.Second)
    }
    portal.log.Error().Str("message_id",messageID).Msg("Archival history edit delta failed after retries")
}

func (portal *Portal) archivalHistoryDelete(ids []string) {
    if portal.Key.Receiver == "" || portal.MXID == "" { return }
    _, err := portal.MainIntent().SendMessageEvent(portal.MXID, archivalHistoryType, map[string]interface{}{"op":"delete", "ids":ids})
    if err != nil { portal.log.Error().Err(err).Msg("Archival history delete delta failed") }
}
