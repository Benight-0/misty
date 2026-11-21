package main

import (
	"github.com/bwmarrin/discordgo"
	"testing"
	"time"
)

func TestDiscordSelectedServerBoundary(t *testing.T) {
	now := time.Now().UnixMilli()
	d := &discordCollector{channels: map[string]channelPlan{"dm": {ID: "dm"}, "s": {ID: "s", GuildID: "selected", Treatment: "SP", FromTS: now}, "g": {ID: "g", GuildID: "selected", Treatment: "GP", FromTS: now}}, servers: map[string]discordServerPlan{"selected": {ID: "selected"}}}
	cases := []struct {
		channel, guild string
		ts             int64
		want           bool
	}{{"dm", "", now, true}, {"dm", "other", now, false}, {"unknown", "selected", now, false}, {"s", "other", now, false}, {"s", "selected", now - 1, false}, {"s", "", now, true}, {"g", "selected", now - 86400000, true}}
	for _, c := range cases {
		m := &discordgo.Message{ChannelID: c.channel, GuildID: c.guild, Timestamp: time.UnixMilli(c.ts)}
		if got := d.allowMessage(m); got != c.want {
			t.Errorf("channel=%s guild=%s ts=%d got=%v want=%v", c.channel, c.guild, c.ts, got, c.want)
		}
		if c.want && c.channel == "s" && m.GuildID != "selected" {
			t.Error("REST guild context was not restored")
		}
	}
	if fullHistory("SP") || !fullHistory("GP") || serverTreatment("I") {
		t.Error("treatment boundary violated")
	}
}
