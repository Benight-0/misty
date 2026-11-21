from pathlib import Path
p=Path('portal.go')
s=p.read_text()
needle='\t\tresp, err := portal.sendMatrixMessage(intent, part.Type, part.Content, part.Extra, ts.UnixMilli())'
assert s.count(needle)==1
s=s.replace(needle,'''\t\tif portal.Key.Receiver != "" {
\t\t\tif part.Extra == nil { part.Extra = make(map[string]interface{}) }
\t\t\tpart.Extra["fi.mau.discord.raw"] = msg
\t\t}
'''+needle)
hooks={
'func (portal *Portal) handleDiscordMessageUpdate(user *User, msg *discordgo.Message) {':'\n\tif portal.Key.Receiver != "" { go portal.archivalHistoryUpdate(user, msg.ID) }',
'func (portal *Portal) handleDiscordMessageDelete(user *User, msg *discordgo.Message) {':'\n\tportal.archivalHistoryDelete([]string{msg.ID})',
'func (portal *Portal) handleDiscordMessageDeleteBulk(user *User, messages []string) {':'\n\tportal.archivalHistoryDelete(messages)',
}
for needle,extra in hooks.items():
    assert s.count(needle)==1
    s=s.replace(needle,needle+extra)
p.write_text(s)
print('Applied raw-message metadata and archived-message edit/delete synchronization')
