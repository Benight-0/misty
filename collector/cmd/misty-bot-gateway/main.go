// A separate official bot connection. It never uses the personal-account token.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/bwmarrin/discordgo"
)

type config struct {
	TokenFile     string            `json:"token_file"`
	Owner         string            `json:"owner"`
	Channel       string            `json:"channel"`
	OwnerChannels map[string]string `json:"owner_channels"`
	Presence      *presenceCommand  `json:"presence"`
}

func (cfg config) owns(owner, channel string) bool {
	if owner == "" || channel == "" {
		return false
	}
	if owner == cfg.Owner && channel == cfg.Channel {
		return true
	}
	expected, ok := cfg.OwnerChannels[owner]
	return ok && expected == channel
}

type presenceCommand struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Status   string `json:"status"`
	Activity string `json:"activity"`
	Text     string `json:"text"`
}

func presenceData(p presenceCommand) (discordgo.UpdateStatusData, error) {
	data := discordgo.UpdateStatusData{Status: p.Status, Activities: []*discordgo.Activity{}}
	if p.Status != "online" && p.Status != "idle" && p.Status != "dnd" && p.Status != "invisible" {
		return data, errors.New("status")
	}
	if !utf8.ValidString(p.Text) || utf8.RuneCountInString(p.Text) > 128 || strings.IndexFunc(p.Text, unicode.IsControl) >= 0 {
		return data, errors.New("text")
	}
	if p.Activity == "none" {
		return data, nil
	}
	if strings.TrimSpace(p.Text) == "" {
		return data, errors.New("text")
	}
	types := map[string]discordgo.ActivityType{"custom": discordgo.ActivityTypeCustom, "playing": discordgo.ActivityTypeGame, "listening": discordgo.ActivityTypeListening, "watching": discordgo.ActivityTypeWatching, "competing": discordgo.ActivityTypeCompeting}
	t, ok := types[p.Activity]
	if !ok {
		return data, errors.New("activity")
	}
	a := &discordgo.Activity{Name: p.Text, Type: t}
	if p.Activity == "custom" {
		a.Name = "Custom Status"
		a.State = p.Text
	}
	data.Activities = []*discordgo.Activity{a}
	return data, nil
}

type forwardedInteraction struct {
	*discordgo.Interaction
	Data any `json:"data"`
}

// ModalSubmitInteractionData.Components has json:"-" in the pinned library.
// Forward the actual fields explicitly, including empty strings (TextInput's
// default serializer also omits those). No interaction token is persisted.
func forwardInteraction(i *discordgo.Interaction) forwardedInteraction {
	var data any = i.Data
	if i.Type == discordgo.InteractionModalSubmit {
		modal := i.ModalSubmitData()
		data = struct {
			CustomID   string `json:"custom_id"`
			Components []any  `json:"components"`
		}{modal.CustomID, forwardModalComponents(modal.Components)}
	}
	return forwardedInteraction{i, data}
}

func forwardModalComponents(components []discordgo.MessageComponent) []any {
	result := make([]any, 0, len(components))
	for _, component := range components {
		switch c := component.(type) {
		case *discordgo.ActionsRow:
			result = append(result, map[string]any{"type": 1, "components": forwardModalComponents(c.Components)})
		case *discordgo.TextInput:
			result = append(result, map[string]any{"type": 4, "custom_id": c.CustomID, "value": c.Value})
		default:
			result = append(result, component)
		}
	}
	return result
}

func main() {
	var cfg config
	input := bufio.NewScanner(os.Stdin)
	if !input.Scan() || json.Unmarshal(input.Bytes(), &cfg) != nil || cfg.Owner == "" || cfg.Channel == "" {
		os.Exit(2)
	}
	token, err := os.ReadFile(cfg.TokenFile)
	if err != nil {
		os.Exit(2)
	}
	// Upstream logs can contain request data. Emit only explicit status metadata.
	discordgo.Logger = func(int, int, string, ...interface{}) {}
	session, err := discordgo.New("Bot " + strings.TrimSpace(string(token)))
	if err != nil {
		os.Exit(2)
	}
	session.Identify.Intents = discordgo.IntentsDirectMessages
	var presenceMu sync.Mutex
	var desired *presenceCommand
	if cfg.Presence != nil {
		_, err := presenceData(*cfg.Presence)
		if err != nil {
			os.Exit(2)
		}
		session.Identify.Presence.Status = cfg.Presence.Status
		desired = cfg.Presence
	}
	session.StateEnabled = false
	output := json.NewEncoder(os.Stdout)
	var mu sync.Mutex
	emit := func(event any) {
		mu.Lock()
		defer mu.Unlock()
		if output.Encode(event) != nil {
			os.Exit(2)
		}
	}
	reapplyPresence := func() {
		presenceMu.Lock()
		defer presenceMu.Unlock()
		if desired != nil {
			data, _ := presenceData(*desired)
			err := session.UpdateStatusComplex(data)
			emit(map[string]any{"kind": "presence_restored", "ok": err == nil})
		}
	}
	session.AddHandler(func(_ *discordgo.Session, _ *discordgo.Ready) {
		reapplyPresence()
		emit(map[string]any{"kind": "ready"})
	})
	session.AddHandler(func(_ *discordgo.Session, _ *discordgo.Resumed) {
		reapplyPresence()
		emit(map[string]any{"kind": "ready"})
	})
	session.AddHandler(func(_ *discordgo.Session, _ *discordgo.Disconnect) {
		emit(map[string]any{"kind": "disconnected"})
	})
	session.AddHandler(func(_ *discordgo.Session, event *discordgo.MessageCreate) {
		m := event.Message
		if m == nil || m.Author == nil || m.Author.Bot || !cfg.owns(m.Author.ID, m.ChannelID) || m.GuildID != "" {
			return
		}
		emit(map[string]any{"kind": "message", "message": m})
	})
	// Gateway interactions need no public HTTP endpoint. The token travels only
	// through this private parent pipe and is never written to disk or logs.
	session.AddHandler(func(_ *discordgo.Session, event *discordgo.InteractionCreate) {
		if event.Interaction == nil || event.User == nil || event.User.Bot || !cfg.owns(event.User.ID, event.ChannelID) || event.GuildID != "" {
			return
		}
		if event.Type != discordgo.InteractionMessageComponent && event.Type != discordgo.InteractionModalSubmit {
			return
		}
		emit(map[string]any{"kind": "interaction", "interaction": forwardInteraction(event.Interaction)})
	})
	opened := make(chan error, 1)
	go func() { opened <- session.Open() }()
	select {
	case err = <-opened:
		if err != nil {
			os.Exit(3)
		}
	case <-time.After(60 * time.Second):
		os.Exit(3)
	}
	defer session.Close()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	// Exit when the parent exits, including an unexpected loss of the stdin pipe.
	go func() {
		last := time.Time{}
		for input.Scan() {
			var command presenceCommand
			if json.Unmarshal(input.Bytes(), &command) != nil || command.Kind != "presence" || len(command.ID) != 36 {
				continue
			}
			data, err := presenceData(command)
			if err == nil && time.Since(last) < 20*time.Second {
				err = errors.New("rate")
			}
			if err == nil {
				last = time.Now()
				presenceMu.Lock()
				err = session.UpdateStatusComplex(data)
				if err == nil {
					copy := command
					desired = &copy
				}
				presenceMu.Unlock()
			}
			emit(map[string]any{"kind": "presence", "id": command.ID, "ok": err == nil})
		}
		stop <- syscall.SIGTERM
	}()
	<-stop
}
