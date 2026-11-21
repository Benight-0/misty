package main

import (
	"encoding/json"
	"testing"

	"github.com/bwmarrin/discordgo"
)

func TestVerifiedOwnerAccountAndChannelAreBound(t *testing.T) {
	cfg := config{Owner: "100000000000000023", Channel: "100000000000000052", OwnerChannels: map[string]string{"100000000000000034": "100000000000000053"}}
	if !cfg.owns(cfg.Owner, cfg.Channel) || !cfg.owns("100000000000000034", "100000000000000053") {
		t.Fatal("verified owner rejected")
	}
	for _, pair := range [][2]string{{"100000000000000034", cfg.Channel}, {cfg.Owner, "100000000000000053"}, {"100000000000000056", cfg.Channel}, {"", ""}} {
		if cfg.owns(pair[0], pair[1]) {
			t.Fatal("unverified identity/channel admitted")
		}
	}
	legacy := config{Owner: cfg.Owner, Channel: cfg.Channel}
	if legacy.owns("100000000000000034", "100000000000000053") {
		t.Fatal("alias leaked to legacy/Apollo gateway")
	}
}

func TestInteractivePayloadsSurviveGatewayDecode(t *testing.T) {
	for _, data := range []string{
		`{"type":3,"data":{"custom_id":"misty:chat:1234567890","component_type":3,"values":["1"]}}`,
		`{"type":5,"data":{"custom_id":"misty:editform:100000000000000005901234","components":[{"type":1,"components":[{"type":4,"custom_id":"prompt0","value":"first line\nsecond line"}]}]}}`,
		`{"type":5,"data":{"custom_id":"misty:editform:100000000000000005901234","components":[{"type":1,"components":[{"type":4,"custom_id":"prompt0","value":""}]}]}}`,
	} {
		var raw map[string]any
		if err := json.Unmarshal([]byte(data), &raw); err != nil {
			t.Fatal(err)
		}
		raw["id"] = "100000000000000052"
		raw["application_id"] = "100000000000000053"
		raw["channel_id"] = "100000000000000054"
		raw["token"] = "test-only"
		raw["user"] = map[string]any{"id": "100000000000000055"}
		encoded, _ := json.Marshal(raw)
		var interaction discordgo.Interaction
		if err := json.Unmarshal(encoded, &interaction); err != nil {
			t.Fatal(err)
		}
		forwarded, err := json.Marshal(forwardInteraction(&interaction))
		if err != nil {
			t.Fatal(err)
		}
		var actual map[string]any
		if err = json.Unmarshal(forwarded, &actual); err != nil {
			t.Fatal(err)
		}
		if actual["application_id"] != raw["application_id"] || actual["channel_id"] != raw["channel_id"] {
			t.Fatal("Gateway lost interaction binding")
		}
		originalData, _ := json.Marshal(raw["data"])
		actualData, _ := json.Marshal(actual["data"])
		// DiscordGo may add optional zero fields; inspect the important values.
		var got map[string]any
		_ = json.Unmarshal(actualData, &got)
		if got["custom_id"] != raw["data"].(map[string]any)["custom_id"] {
			t.Fatalf("Lost custom ID: %s -> %s", originalData, actualData)
		}
		if interaction.Type == discordgo.InteractionModalSubmit {
			original := raw["data"].(map[string]any)["components"].([]any)[0].(map[string]any)["components"].([]any)[0].(map[string]any)
			rows, ok := got["components"].([]any)
			if !ok || len(rows) != 1 {
				t.Fatal("Gateway dropped modal fields during forwarding")
			}
			field := rows[0].(map[string]any)["components"].([]any)[0].(map[string]any)
			if field["type"] != float64(4) || field["custom_id"] != "prompt0" || field["value"] != original["value"] {
				t.Fatal("Gateway changed exact forwarded modal text")
			}
		}
	}
}

func TestPresenceValidationAndWireData(t *testing.T) {
	for _, activity := range []string{"custom", "playing", "listening", "watching", "competing", "none"} {
		data, err := presenceData(presenceCommand{Status: "idle", Activity: activity, Text: "around, if you need me"})
		if err != nil || data.Status != "idle" || data.Activities == nil {
			t.Fatal("valid presence rejected")
		}
		if activity == "none" {
			if len(data.Activities) != 0 {
				t.Fatal("activity not cleared")
			}
			continue
		}
		if len(data.Activities) != 1 {
			t.Fatal("activity missing")
		}
		if activity == "custom" && (data.Activities[0].Type != discordgo.ActivityTypeCustom || data.Activities[0].State != "around, if you need me") {
			t.Fatal("custom status missing")
		}
		b, _ := json.Marshal(data)
		var wire map[string]any
		_ = json.Unmarshal(b, &wire)
		if wire["activities"] == nil || wire["status"] != "idle" {
			t.Fatal("invalid gateway payload")
		}
	}
	for _, p := range []presenceCommand{{Status: "offline", Activity: "custom", Text: "hi"}, {Status: "online", Activity: "streaming", Text: "hi"}, {Status: "online", Activity: "custom", Text: ""}, {Status: "online", Activity: "custom", Text: "private\ntext"}} {
		if _, err := presenceData(p); err == nil {
			t.Fatal("invalid presence accepted")
		}
	}
}
