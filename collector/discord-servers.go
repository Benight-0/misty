package main

import (
	"context"
	"math/big"
	"sort"
	"time"

	"github.com/bwmarrin/discordgo"
)

func serverTreatment(t string) bool { return t == "S" || t == "SP" || t == "G" || t == "GP" }
func fullHistory(t string) bool     { return t == "G" || t == "GP" }
func snowflakeAt(ts int64) string   { return new(big.Int).Lsh(big.NewInt(ts-1420070400000), 22).String() }
func (d *discordCollector) allowMessage(m *discordgo.Message) bool {
	if m == nil {
		return false
	}
	d.mu.Lock()
	p, known := d.channels[m.ChannelID]
	d.mu.Unlock()
	if !known {
		return false
	}
	if p.GuildID == "" {
		return m.GuildID == ""
	}
	if d.servers[p.GuildID].ID == "" || m.GuildID != "" && m.GuildID != p.GuildID {
		return false
	}
	if !fullHistory(p.Treatment) && m.Timestamp.UnixMilli() < p.FromTS {
		return false
	}
	// ChannelMessages omits guild_id in REST responses.
	m.GuildID = p.GuildID
	return true
}
func (d *discordCollector) fetchMessages(ctx context.Context, id string, limit int, before string) ([]*discordgo.Message, error) {
	select {
	case d.requestSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-d.requestSlots }()
	requestCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	return d.session.ChannelMessages(id, limit, before, "", "", discordgo.WithContext(requestCtx))
}
func (d *discordCollector) queueDiscovery(id, guild string) {
	if id == "" || d.servers[guild].ID == "" || d.known(id) {
		return
	}
	select {
	case d.discover <- id:
	default:
	}
}
func (d *discordCollector) subscribeServers() {
	d.mu.Lock()
	d.subscriptionSeq++
	version := d.subscriptionSeq
	d.mu.Unlock()
	ids := make([]string, 0, len(d.servers))
	for id := range d.servers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if d.ctx.Err() != nil {
			return
		}
		d.mu.Lock()
		current := d.subscriptionSeq
		d.mu.Unlock()
		if current != version {
			return
		}
		// Follow mautrix's guild subscription layout. Channel ranges request
		// member lists; they are not a message-channel allowlist. Filter messages
		// with our explicit channel/guild plans instead.
		if err := d.session.SubscribeGuild(discordgo.GuildSubscribeData{GuildID: id, Typing: true, Activities: true, Threads: true}); err != nil {
			status("discord", "server_subscription_retry")
			return
		}
		select {
		case <-d.ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}
func (d *discordCollector) discoverChannel(ctx context.Context, id string) {
	if d.known(id) {
		return
	}
	requestCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	channel, err := d.session.Channel(id, discordgo.WithContext(requestCtx))
	if err != nil || channel == nil {
		return
	}
	policy, ok := d.servers[channel.GuildID]
	if !ok {
		return
	}
	if channel.Type != 0 && channel.Type != 5 && channel.Type != 10 && channel.Type != 11 && channel.Type != 12 {
		return
	}
	// The API, including private-thread membership, remains the authority. Do not
	// enable a channel until this session can actually read its message endpoint.
	if _, err = d.fetchMessages(ctx, id, 1, ""); err != nil {
		return
	}
	emit(map[string]any{"kind": "discord_server_channel", "channel": channel})
	plan := channelPlan{ID: id, GuildID: channel.GuildID, Treatment: policy.Treatment, FromTS: policy.FromTS, Complete: !fullHistory(policy.Treatment)}
	if plan.Complete {
		plan.After = snowflakeAt(policy.FromTS)
	}
	d.mu.Lock()
	d.channels[id] = plan
	d.mu.Unlock()
	select {
	case d.serverWake <- struct{}{}:
	default:
	}
}
func (d *discordCollector) discoveryLoop(ctx context.Context) {
	refresh := time.NewTicker(time.Hour)
	defer refresh.Stop()
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case id := <-d.discover:
			d.discoverChannel(ctx, id)
		case <-refresh.C:
			// Metadata only; only explicit guilds. Existing channels are never re-enabled
			// implicitly in the database if the owner later changes their selections.
			for id := range d.servers {
				requestCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
				channels, err := d.session.GuildChannels(id, discordgo.WithContext(requestCtx))
				cancel()
				if err == nil {
					for _, c := range channels {
						if c.Type == 0 || c.Type == 5 {
							d.queueDiscovery(c.ID, id)
						}
					}
				}
				requestCtx, cancel = context.WithTimeout(ctx, 25*time.Second)
				threads, err := d.session.GuildThreadsActive(id, discordgo.WithContext(requestCtx))
				cancel()
				if err == nil {
					for _, c := range threads.Threads {
						d.queueDiscovery(c.ID, id)
					}
				}
				if ctx.Err() != nil {
					return
				}
			}
		}
	}
}
func (d *discordCollector) serverLoop(ctx context.Context) {
	// One bounded recovery worker, independent of private-chat recovery and the
	// live gateway. History pages rotate fairly across the selected G/GP channels.
	for ctx.Err() == nil {
		d.mu.Lock()
		plans := make([]channelPlan, 0)
		for _, p := range d.channels {
			if p.GuildID != "" {
				plans = append(plans, p)
			}
		}
		d.mu.Unlock()
		sort.Slice(plans, func(i, j int) bool {
			if fullHistory(plans[i].Treatment) != fullHistory(plans[j].Treatment) {
				return fullHistory(plans[i].Treatment)
			}
			return plans[i].ID < plans[j].ID
		})
		groups := make([]string, 0)
		for _, p := range plans {
			if fullHistory(p.Treatment) {
				groups = append(groups, p.ID)
			}
		}
		historyIndex := 0
		for _, p := range plans {
			if ctx.Err() != nil {
				return
			}
			d.catchUp(ctx, p)
			d.mu.Lock()
			updated := d.channels[p.ID]
			d.mu.Unlock()
			if fullHistory(updated.Treatment) {
				d.backfill(ctx, updated)
			}
			// Interleave full-history pages while sweeping S/SP, so a large server
			// allowlist cannot make the two GP archives wait for an entire REST sweep.
			if !fullHistory(p.Treatment) && len(groups) > 0 {
				id := groups[historyIndex%len(groups)]
				historyIndex++
				d.mu.Lock()
				group := d.channels[id]
				d.mu.Unlock()
				if !group.Complete {
					d.backfill(ctx, group)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(150 * time.Millisecond):
			}
		}
		// Incomplete G/GP history gets another page without waiting three minutes.
		incomplete := false
		d.mu.Lock()
		for _, p := range d.channels {
			if p.GuildID != "" && !p.Complete {
				incomplete = true
				break
			}
		}
		d.mu.Unlock()
		delay := 3 * time.Minute
		if incomplete {
			delay = 5 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-d.serverWake:
		case <-time.After(delay):
		}
	}
}
