using System.Text.Json;

namespace Misty.Overlay;

public static class WorkingDisplay
{
    public static string Render(JsonElement value, long now)
    {
        if (value.ValueKind != JsonValueKind.Object) return "";
        string Read(JsonElement row, string name, string fallback = "") =>
            row.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() ?? fallback : fallback;
        long At(JsonElement row, string name) =>
            row.TryGetProperty(name, out var field) && field.TryGetInt64(out var number) ? number : 0;
        string Line(JsonElement row)
        {
            var since = At(row, "since");
            var ended = At(row, "ended");
            var seconds = since <= 0 ? 0 : Math.Max(0, ((ended > 0 ? ended : now) - since) / 1000);
            return Read(row, "label", "thinking") + " · " + seconds + "s" +
                (Read(row, "state") == "done" ? " · done" : "");
        }
        if (value.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            return string.Join("\n", items.EnumerateArray().Where(row => row.ValueKind == JsonValueKind.Object).Select(Line));
        return value.TryGetProperty("active", out var active) && active.ValueKind == JsonValueKind.True ? Line(value) : "";
    }
}