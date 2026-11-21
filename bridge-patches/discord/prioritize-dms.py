"""Reorder only startup catch-up; fail closed if upstream structure changes."""
from pathlib import Path

path = Path("user.go")
source = path.read_text()
guilds = "\tfor _, guild := range r.Guilds {\n\t\tuser.handleGuild(guild, updateTS, portalsInSpace[guild.ID])\n\t}\n"
start = source.index(guilds, source.index("func (user *User) readyHandler("))
end = source.index("\tuser.PrunePortalList(updateTS)", start)
original = source[start:end]
private = original[len(guilds):]
assert original.count(guilds) == 1
assert "sort.Sort(ChannelSlice(r.PrivateChannels))" in private
assert "user.handlePrivateChannel(" in private
assert private.count("for ") == 1
source = source[:start] + "\t// Archival: catch up personal DMs before the potentially lengthy guild scan.\n" + private + guilds + source[end:]
path.write_text(source)
print("Applied DM-first startup to pinned mautrix-discord v0.7.7")
