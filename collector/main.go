package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bwmarrin/discordgo"
	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/encoding/protojson"
)

type channelPlan struct {
	GuildID   string `json:"guild_id"`
	Treatment string `json:"treatment"`
	FromTS    int64  `json:"from_ts"`
	ID        string `json:"id"`
	After     string `json:"after"`
	Before    string `json:"before"`
	Complete  bool   `json:"complete"`
}
type discordServerPlan struct {
	ID        string `json:"id"`
	Treatment string `json:"treatment"`
	FromTS    int64  `json:"from_ts"`
}
type config struct {
	DiscordServers     []discordServerPlan `json:"discord_servers"`
	DiscordTokenFile   string              `json:"discord_token_file"`
	WhatsAppDB         string              `json:"whatsapp_db"`
	PairWhatsApp       bool                `json:"pair_whatsapp"`
	Channels           []channelPlan       `json:"channels"`
	WhatsAppGroups     []whatsappGroupPlan `json:"whatsapp_groups"`
	LiveWhatsAppGroups []string            `json:"live_whatsapp_groups"`
}

var input = bufio.NewScanner(os.Stdin)
var output = json.NewEncoder(os.Stdout)
var outputMu sync.Mutex

// Upstream acknowledgements wait for the parent to commit the normalized event.
func emit(event any) {
	outputMu.Lock()
	defer outputMu.Unlock()
	if output.Encode(event) != nil || !input.Scan() || input.Text() != "ok" {
		os.Exit(2)
	}
}
func status(platform, state string) {
	emit(map[string]any{"kind": "status", "platform": platform, "state": state, "at": time.Now().UnixMilli()})
}
func whatsappGroupInventory(ctx context.Context, client *whatsmeow.Client) {
	for attempt := 0; attempt < 3 && ctx.Err() == nil; attempt++ {
		requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		groups, err := client.GetJoinedGroups(requestCtx)
		cancel()
		if err == nil {
			inventory := make([]map[string]any, 0, len(groups))
			for _, group := range groups {
				if group.JID.Server != types.GroupServer {
					continue
				}
				if group.Name == "" {
					detailCtx, detailCancel := context.WithTimeout(ctx, 10*time.Second)
					detail, detailErr := client.GetGroupInfo(detailCtx, group.JID)
					detailCancel()
					if detailErr == nil && detail != nil {
						group = detail
					}
				}
				parent := ""
				if !group.LinkedParentJID.IsEmpty() {
					parent = group.LinkedParentJID.String()
				}
				inventory = append(inventory, map[string]any{"id": group.JID.String(), "name": group.Name, "community": group.IsParent, "announcement": group.IsAnnounce, "parent": parent})
			}
			sort.Slice(inventory, func(i, j int) bool { return inventory[i]["id"].(string) < inventory[j]["id"].(string) })
			emit(map[string]any{"kind": "whatsapp_group_inventory", "at": time.Now().UnixMilli(), "groups": inventory})
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
	if ctx.Err() == nil {
		emit(map[string]any{"kind": "whatsapp_group_inventory_error", "at": time.Now().UnixMilli()})
	}
}
func privateJID(j types.JID) bool {
	return j.Server == types.DefaultUserServer || j.Server == types.HiddenUserServer
}
func whatsappMessage(client *whatsmeow.Client, e *events.Message, liveGroups map[string]bool) {
	if !privateJID(e.Info.Chat) && !(e.Info.Chat.Server == types.GroupServer && liveGroups[e.Info.Chat.ToNonAD().String()]) {
		return
	}
	whatsappMessageKind(client, e, "whatsapp_message")
}
func whatsappMessageKind(client *whatsmeow.Client, e *events.Message, kind string) {
	chat := e.Info.Chat.ToNonAD()
	aliases := []string{chat.String()}
	if chat.Server == types.DefaultUserServer {
		if lid, err := client.Store.LIDs.GetLIDForPN(context.Background(), chat); err == nil && !lid.IsEmpty() {
			aliases = append(aliases, lid.String())
		}
	}
	if chat.Server == types.HiddenUserServer {
		if pn, err := client.Store.LIDs.GetPNForLID(context.Background(), chat); err == nil && !pn.IsEmpty() {
			aliases = append(aliases, pn.String())
		}
	}
	m := e.Message
	if m == nil {
		return
	}
	if p := m.GetProtocolMessage(); p != nil && p.GetType().String() == "REVOKE" {
		deleteKind := "whatsapp_delete"
		if kind == "whatsapp_group_history_message" {
			deleteKind = "whatsapp_group_history_delete"
		}
		emit(map[string]any{"kind": deleteKind, "chat": chat.String(), "aliases": aliases, "id": p.GetKey().GetID(), "at": e.Info.Timestamp.UnixMilli()})
		return
	}
	text := m.GetConversation()
	if text == "" {
		text = m.GetExtendedTextMessage().GetText()
	}
	msgtype := "m.text"
	if m.GetImageMessage() != nil {
		text = m.GetImageMessage().GetCaption()
		msgtype = "m.image"
	}
	if m.GetVideoMessage() != nil {
		text = m.GetVideoMessage().GetCaption()
		msgtype = "m.video"
	}
	if m.GetAudioMessage() != nil {
		msgtype = "m.audio"
	}
	if m.GetStickerMessage() != nil {
		msgtype = "m.sticker"
	}
	if m.GetDocumentMessage() != nil {
		text = m.GetDocumentMessage().GetCaption()
		if text == "" {
			text = m.GetDocumentMessage().GetFileName()
		}
		msgtype = "m.file"
	}
	if m.GetReactionMessage() != nil {
		text = m.GetReactionMessage().GetText()
		msgtype = "m.reaction"
	}
	if text == "" && msgtype == "m.text" {
		return
	}
	if text == "" {
		text = "[" + strings.TrimPrefix(msgtype, "m.") + "]"
	}
	raw, err := protojson.Marshal(m)
	if err != nil {
		return
	}
	emit(map[string]any{"kind": kind, "chat": chat.String(), "aliases": aliases, "id": e.Info.ID, "sender": e.Info.Sender.ToNonAD().String(), "is_me": e.Info.IsFromMe, "name": e.Info.PushName, "at": e.Info.Timestamp.UnixMilli(), "body": text, "type": msgtype, "edited": e.IsEdit, "raw": json.RawMessage(raw)})
}

func runWhatsApp(ctx context.Context, path string, pair bool, groupPlans []whatsappGroupPlan, liveIDs []string) {
	liveGroups := map[string]bool{}
	for _, id := range liveIDs {
		liveGroups[id] = true
	}
	container, err := sqlstore.New(ctx, "sqlite3", "file:"+path+"?_foreign_keys=on&_journal_mode=WAL&_busy_timeout=5000", nil)
	if err != nil {
		status("whatsapp", "session_database_error")
		return
	}
	defer container.Close()
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		status("whatsapp", "session_load_error")
		return
	}
	if device.ID == nil && !pair {
		status("whatsapp", "pairing_required")
		return
	}
	if device.ID != nil {
		emit(map[string]any{"kind": "whatsapp_identity", "id": device.ID.String()})
	}
	client := whatsmeow.NewClient(device, nil)
	stopSender := startWhatsAppSender(ctx, client)
	defer stopSender()
	var inventoryOnce sync.Once
	history := newWhatsAppGroupHistory(groupPlans)
	client.SynchronousAck = true
	client.AddEventHandler(func(event any) {
		switch e := event.(type) {
		case *events.Connected:
			if client.Store.ID != nil {
				emit(map[string]any{"kind": "whatsapp_identity", "id": client.Store.ID.String()})
			}
			status("whatsapp", "connected")
			inventoryOnce.Do(func() { go whatsappGroupInventory(ctx, client); go history.run(ctx, client) })
		case *events.Disconnected:
			status("whatsapp", "reconnecting")
		case *events.LoggedOut:
			status("whatsapp", "logged_out")
		case *events.ClientOutdated:
			status("whatsapp", "client_outdated")
		case *events.UndecryptableMessage:
			if privateJID(e.Info.Chat) {
				status("whatsapp", "waiting_for_message_retry")
			}
		case *events.Message:
			whatsappMessage(client, e, liveGroups)
		case *events.HistorySync:
			history.receive(ctx, client, e)
			for _, conversation := range e.Data.GetConversations() {
				chat, parseErr := types.ParseJID(conversation.GetID())
				if parseErr != nil || (!privateJID(chat) && !liveGroups[chat.ToNonAD().String()]) {
					continue
				}
				for _, historyMessage := range conversation.GetMessages() {
					parsed, parseErr := client.ParseWebMessage(chat, historyMessage.GetMessage())
					if parseErr == nil {
						whatsappMessage(client, parsed, liveGroups)
					}
				}
			}
			status("whatsapp", "history_received")
		}
	})
	if device.ID == nil && pair {
		qr, qrErr := client.GetQRChannel(ctx)
		if qrErr != nil {
			status("whatsapp", "pairing_failed")
			return
		}
		if err = client.Connect(); err != nil {
			status("whatsapp", "pairing_failed")
			return
		}
		select {
		case first := <-qr:
			if first.Event != "code" {
				status("whatsapp", "pairing_failed")
				return
			}
			code, pairErr := client.PairPhone(ctx, "910000000001", true, whatsmeow.PairClientChrome, "Chrome (Linux)")
			if pairErr != nil {
				status("whatsapp", "pairing_failed")
				return
			}
			emit(map[string]any{"kind": "whatsapp_pair_code", "code": code, "expires": time.Now().Add(150 * time.Second).UnixMilli()})
		case <-ctx.Done():
			return
		}
		<-ctx.Done()
		client.Disconnect()
		return
	}
	for ctx.Err() == nil {
		if err = client.Connect(); err == nil {
			break
		}
		status("whatsapp", "connection_retry")
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
	<-ctx.Done()
	client.Disconnect()
}

type discordCollector struct {
	session         *discordgo.Session
	mu              sync.Mutex
	channels        map[string]channelPlan
	wake            chan struct{}
	serverWake      chan struct{}
	servers         map[string]discordServerPlan
	discover        chan string
	ctx             context.Context
	requestSlots    chan struct{}
	subscriptionSeq uint64
}

func (d *discordCollector) addChannel(channel *discordgo.Channel) {
	if channel == nil || (channel.Type != discordgo.ChannelTypeDM && channel.Type != discordgo.ChannelTypeGroupDM) {
		return
	}
	d.mu.Lock()
	if _, ok := d.channels[channel.ID]; !ok {
		d.channels[channel.ID] = channelPlan{ID: channel.ID}
	}
	d.mu.Unlock()
	emit(map[string]any{"kind": "discord_channel", "channel": channel})
	select {
	case d.wake <- struct{}{}:
	default:
	}
}
func (d *discordCollector) known(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.channels[id]
	return ok
}
func (d *discordCollector) message(message *discordgo.Message) {
	if !d.allowMessage(message) {
		return
	}
	emit(map[string]any{"kind": "discord_message", "message": message})
}
func snowflakeLess(a, b string) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}
func (d *discordCollector) catchUp(ctx context.Context, plan channelPlan) bool {
	before, newest := "", plan.After
	for ctx.Err() == nil {
		messages, err := d.fetchMessages(ctx, plan.ID, 100, before)
		if err != nil {
			status("discord", "history_retry")
			return false
		}
		if len(messages) == 0 {
			if plan.After == "" {
				emit(map[string]any{"kind": "discord_history", "channel": plan.ID, "before": plan.Before, "complete": true, "count": 0})
				d.mu.Lock()
				current := d.channels[plan.ID]
				current.Complete = true
				d.channels[plan.ID] = current
				d.mu.Unlock()
			}
			break
		}
		sort.Slice(messages, func(i, j int) bool { return snowflakeLess(messages[i].ID, messages[j].ID) })
		reached := false
		for _, m := range messages {
			if !snowflakeLess(plan.After, m.ID) {
				reached = true
				continue
			}
			d.message(m)
			if snowflakeLess(newest, m.ID) {
				newest = m.ID
			}
		}
		before = messages[0].ID
		// Newly discovered chats show the latest page first; older history is fair,
		// one page per chat per sweep, instead of blocking every other chat.
		if plan.After == "" {
			emit(map[string]any{"kind": "discord_history", "channel": plan.ID, "before": before, "complete": len(messages) < 100, "count": len(messages)})
			d.mu.Lock()
			current := d.channels[plan.ID]
			current.Before = before
			current.Complete = len(messages) < 100
			d.channels[plan.ID] = current
			d.mu.Unlock()
			break
		}
		if reached || len(messages) < 100 {
			break
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(500 * time.Millisecond):
		}
	}
	if ctx.Err() != nil {
		return false
	}
	emit(map[string]any{"kind": "discord_cursor", "channel": plan.ID, "after": newest})
	d.mu.Lock()
	current := d.channels[plan.ID]
	current.After = newest
	d.channels[plan.ID] = current
	d.mu.Unlock()
	return true
}
func (d *discordCollector) backfill(ctx context.Context, plan channelPlan) {
	if plan.Complete {
		return
	}
	messages, err := d.fetchMessages(ctx, plan.ID, 100, plan.Before)
	if err != nil {
		return
	}
	sort.Slice(messages, func(i, j int) bool { return snowflakeLess(messages[i].ID, messages[j].ID) })
	for _, m := range messages {
		d.message(m)
	}
	if len(messages) > 0 {
		plan.Before = messages[0].ID
	}
	plan.Complete = len(messages) < 100
	emit(map[string]any{"kind": "discord_history", "channel": plan.ID, "before": plan.Before, "complete": plan.Complete, "count": len(messages)})
	d.mu.Lock()
	current := d.channels[plan.ID]
	current.Before = plan.Before
	current.Complete = plan.Complete
	d.channels[plan.ID] = current
	d.mu.Unlock()
}
func runDiscord(ctx context.Context, cfg config) {
	token, err := os.ReadFile(cfg.DiscordTokenFile)
	if err != nil {
		status("discord", "credential_missing")
		return
	}
	session, err := discordgo.New(strings.TrimSpace(string(token)))
	if err != nil {
		status("discord", "session_error")
		return
	}
	// Do not retain guild/member/message caches for the 83 unrelated servers.
	session.StateEnabled = false
	session.LogLevel = discordgo.LogError
	d := &discordCollector{session: session, channels: map[string]channelPlan{}, wake: make(chan struct{}, 1), serverWake: make(chan struct{}, 1), servers: map[string]discordServerPlan{}, discover: make(chan string, 128), ctx: ctx, requestSlots: make(chan struct{}, 2)}
	for _, p := range cfg.DiscordServers {
		if serverTreatment(p.Treatment) {
			d.servers[p.ID] = p
		}
	}
	for _, p := range cfg.Channels {
		if p.GuildID == "" || d.servers[p.GuildID].ID != "" {
			d.channels[p.ID] = p
		}
	}
	// Beeper's fork dispatches only EventHandler; its legacy AddHandler is inert.
	session.EventHandler = func(event any) {
		switch e := event.(type) {
		case *discordgo.Ready:
			emit(map[string]any{"kind": "discord_identity", "id": e.User.ID})
			for _, channel := range e.PrivateChannels {
				d.addChannel(channel)
			}
			go d.subscribeServers()
			status("discord", "connected")
		case *discordgo.Connect:
			status("discord", "gateway_connected")
		case *discordgo.Resumed:
			go d.subscribeServers()
			status("discord", "connected")
		case *discordgo.Disconnect:
			status("discord", "reconnecting")
		case *discordgo.InvalidAuth:
			status("discord", "credential_invalid")
		case *discordgo.ChannelCreate:
			if e.GuildID == "" {
				d.addChannel(e.Channel)
			} else {
				d.queueDiscovery(e.ID, e.GuildID)
			}
		case *discordgo.ThreadCreate:
			d.queueDiscovery(e.ID, e.GuildID)
		case *discordgo.ThreadListSync:
			for _, c := range e.Threads {
				d.queueDiscovery(c.ID, e.GuildID)
			}
		case *discordgo.MessageCreate:
			if !d.known(e.ChannelID) {
				d.queueDiscovery(e.ChannelID, e.GuildID)
			}
			d.message(e.Message)
		case *discordgo.MessageUpdate:
			if !d.known(e.ChannelID) {
				return
			}
			go func() {
				requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
				defer cancel()
				full, fetchErr := session.ChannelMessage(e.ChannelID, e.ID, discordgo.WithContext(requestCtx))
				if fetchErr == nil {
					d.message(full)
				}
			}()
		case *discordgo.MessageDelete:
			if d.known(e.ChannelID) {
				emit(map[string]any{"kind": "discord_delete", "channel": e.ChannelID, "ids": []string{e.ID}})
			}
		case *discordgo.MessageDeleteBulk:
			if d.known(e.ChannelID) {
				emit(map[string]any{"kind": "discord_delete", "channel": e.ChannelID, "ids": e.Messages})
			}
		}
	}
	for ctx.Err() == nil {
		if err = session.Open(); err == nil {
			break
		}
		status("discord", "connection_retry")
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
	defer session.Close()
	var background sync.WaitGroup
	background.Add(2)
	go func() { defer background.Done(); d.serverLoop(ctx) }()
	go func() { defer background.Done(); d.discoveryLoop(ctx) }()
	defer background.Wait()
	for ctx.Err() == nil {
		d.mu.Lock()
		plans := make([]channelPlan, 0, len(d.channels))
		for _, p := range d.channels {
			if p.GuildID == "" {
				plans = append(plans, p)
			}
		}
		d.mu.Unlock()
		sort.Slice(plans, func(i, j int) bool { return plans[i].ID < plans[j].ID })
		for _, p := range plans {
			if ctx.Err() != nil {
				return
			}
			d.catchUp(ctx, p)
			d.mu.Lock()
			updated := d.channels[p.ID]
			d.mu.Unlock()
			d.backfill(ctx, updated)
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
		// New chats wake the sweep; every private chat also gets periodic gap recovery.
		select {
		case <-ctx.Done():
			return
		case <-d.wake:
		case <-time.After(3 * time.Minute):
		}
	}
}
func main() {
	input.Buffer(make([]byte, 4096), 1024*1024)
	if !input.Scan() {
		return
	}
	var cfg config
	if json.Unmarshal(input.Bytes(), &cfg) != nil {
		fmt.Fprintln(os.Stderr, "Invalid collector configuration")
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); runDiscord(ctx, cfg) }()
	go func() {
		defer workers.Done()
		runWhatsApp(ctx, cfg.WhatsAppDB, cfg.PairWhatsApp, cfg.WhatsAppGroups, cfg.LiveWhatsAppGroups)
	}()
	workers.Wait()
}
