"""Use the joined DM's main puppet to invite additional sender ghosts."""
from pathlib import Path
p=Path('portal.go')
s=p.read_text()
needle='''func (portal *Portal) sendMatrixMessage(intent *appservice.IntentAPI, eventType event.Type, content *event.MessageEventContent, extraContent map[string]interface{}, timestamp int64) (*mautrix.RespSendEvent, error) {
	wrappedContent := event.Content{Parsed: content, Raw: extraContent}'''
assert s.count(needle)==1
replacement=needle.replace('\n\twrappedContent', '''
	// Archival: the bridge bot need not be in a private DM; its main puppet is.
	if portal.Key.Receiver != "" {
		if err := intent.EnsureJoined(portal.MXID, appservice.EnsureJoinedParams{BotOverride: portal.MainIntent().Client}); err != nil {
			return nil, err
		}
	}
	wrappedContent''')
p.write_text(s.replace(needle,replacement))
print('Applied private-DM sender invitation fix')
