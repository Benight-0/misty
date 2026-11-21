using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;

namespace Misty.Overlay;

public partial class MainWindow
{
    private void CodexSearch_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (CodexSearchHint != null)
            CodexSearchHint.Visibility = string.IsNullOrEmpty(CodexSearch.Text) ? Visibility.Visible : Visibility.Collapsed;
        if (bridge == null) return;
        var version = ++codexSearchVersion;
        _ = SearchCodexAfterDelay(version);
    }

    private async Task SearchCodexAfterDelay(int version)
    {
        try
        {
            await Task.Delay(220, stopping.Token);
            if (version == codexSearchVersion && selected == "codex" && codexThread == null)
                await RefreshCodexChats();
        }
        catch (OperationCanceledException) { }
    }

    private async Task RefreshCodexChats()
    {
        var query = CodexSearch.Text;
        var version = codexSearchVersion;
        try
        {
            var response = await bridge.RequestAsync(new { op = "codex_chats", query }, stopping.Token);
            if (version != codexSearchVersion) return;
            codexChats.Clear();
            foreach (var row in response.GetProperty("chats").EnumerateArray())
                codexChats.Add(new CodexChat(Value(row, "id"), Value(row, "title", "Untitled chat"),
                    Value(row, "workspace"), Value(row, "status"), Number(row, "updatedAt"),
                    Number(row, "syncedAt"), (int)Number(row, "parts")));
            RenderCodexIndex();
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            CodexEmpty.Text = "Could not load Codex chats. The private bridge will retry.";
        }
    }

    private void RenderCodexIndex()
    {
        CodexList.Children.Clear();
        if (codexChats.Count == 0)
        {
            CodexEmpty.Text = "No matching Codex chats are available yet.";
            CodexList.Children.Add(CodexEmpty);
            return;
        }
        foreach (var chat in codexChats)
        {
            var content = new StackPanel();
            content.Children.Add(new TextBlock { Text = chat.Title, FontSize = 15,
                FontWeight = FontWeights.SemiBold, Foreground = Brush("#F8F9FA"),
                TextTrimming = TextTrimming.CharacterEllipsis });
            content.Children.Add(new TextBlock { Text = chat.Workspace, FontSize = 11,
                Foreground = Brush("#ADB5BD"), TextTrimming = TextTrimming.CharacterEllipsis,
                Margin = new Thickness(0, 4, 0, 0) });
            content.Children.Add(new TextBlock { Text = chat.Parts > 0
                    ? $"Saved transcript · {chat.Parts} parts · {Time(chat.SyncedAt)}"
                    : "Transcript waiting for laptop sync",
                FontSize = 10, Foreground = Brush("#ADB5BD"), Margin = new Thickness(0, 6, 0, 0) });
            var button = new System.Windows.Controls.Button { Content = content, Tag = chat.Id,
                Style = (Style)FindResource("ChatListButton") };
            button.Click += CodexChat_Click;
            CodexList.Children.Add(button);
        }
    }

    private async void CodexChat_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not System.Windows.Controls.Button button || button.Tag is not string id) return;
        if (codexThread != null) codexDrafts[codexThread] = CodexComposer.Text;
        codexThread = id;
        codexPendingId = null;
        codexLines.Clear();
        codexBefore = null;
        hasCodexOlder = false;
        var chat = codexChats.First(c => c.Id == id);
        CodexTitle.Text = chat.Title;
        CodexBack.Visibility = Visibility.Visible;
        CodexIndex.Visibility = Visibility.Collapsed;
        CodexTranscriptScroll.Visibility = Visibility.Visible;
        CodexComposerArea.Visibility = Visibility.Visible;
        CodexComposer.Text = codexDrafts.GetValueOrDefault(id, "");
        SetCodexStatus(chat.Parts > 0 ? "" : "Waiting for the saved transcript. You can still send a prompt.");
        await LoadCodexHistory(true);
        CodexComposer.Focus();
    }

    private void CodexBack_Click(object sender, RoutedEventArgs e)
    {
        if (codexThread != null) codexDrafts[codexThread] = CodexComposer.Text;
        codexThread = null;
        CodexTitle.Text = "Codex";
        CodexBack.Visibility = Visibility.Collapsed;
        CodexIndex.Visibility = Visibility.Visible;
        CodexTranscriptScroll.Visibility = Visibility.Collapsed;
        CodexComposerArea.Visibility = Visibility.Collapsed;
    }

    private async Task LoadCodexHistory(bool reset, int? before = null)
    {
        var thread = codexThread;
        if (thread == null) return;
        try
        {
            var response = await bridge.RequestAsync(new { op = "codex_history", threadId = thread, before }, stopping.Token);
            if (codexThread != thread) return;
            if (reset) codexLines.Clear();
            if (!Flag(response, "available"))
            {
                if (reset) RenderCodexTranscript();
                return;
            }
            var existing = codexLines.Select(line => line.Ordinal).ToHashSet();
            var changed = reset;
            foreach (var row in response.GetProperty("rows").EnumerateArray())
            {
                var ordinal = (int)Number(row, "ordinal");
                if (!existing.Add(ordinal)) continue;
                codexLines.Add(new CodexLine(ordinal, Value(row, "role"),
                    Value(row, "text"), Value(row, "at")));
                changed = true;
            }
            codexLines.Sort((a, b) => a.Ordinal.CompareTo(b.Ordinal));
            if (before != null || reset)
            {
                hasCodexOlder = Flag(response, "older");
                codexBefore = response.TryGetProperty("before", out var cursor) && cursor.ValueKind == JsonValueKind.Number
                    ? cursor.GetInt32() : null;
            }
            if (changed)
            {
                var atBottom = CodexTranscriptScroll.VerticalOffset >= CodexTranscriptScroll.ScrollableHeight - 8;
                RenderCodexTranscript();
                if (reset || before == null && atBottom)
                    _ = Dispatcher.BeginInvoke(() => CodexTranscriptScroll.ScrollToEnd(),
                        System.Windows.Threading.DispatcherPriority.Loaded);
            }
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            SetCodexStatus("Transcript unavailable. The private bridge will retry.");
        }
    }

    private void RenderCodexTranscript()
    {
        CodexTranscriptList.Children.Clear();
        if (codexLines.Count == 0)
        {
            CodexTranscriptList.Children.Add(new TextBlock { Text = "No saved transcript yet. The laptop syncs visible Codex messages to Misty.",
                Foreground = Brush("#ADB5BD"), TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 16, 0, 0) });
            return;
        }
        ChatEntry? previous = null;
        foreach (var line in codexLines)
        {
            var at = DateTimeOffset.TryParse(line.At, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var parsed) ? parsed.ToUnixTimeMilliseconds() : 0;
            var role = line.Role == "user" ? "owner" : "codex";
            var entry = new ChatEntry(line.Ordinal.ToString(), role, line.Text, at,
                role == "owner" ? "You" : "Codex", "", false, "");
            var newGroup = previous == null || previous.Role != role || at - previous.At > 300000;
            CodexTranscriptList.Children.Add(MessageRow(entry, newGroup));
            previous = entry;
        }
    }

    private async void CodexTranscriptScroll_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (e.Delta <= 0 || CodexTranscriptScroll.VerticalOffset > 1 || loadingCodexOlder ||
            !hasCodexOlder || codexBefore == null) return;
        loadingCodexOlder = true;
        var before = codexBefore;
        var oldHeight = CodexTranscriptScroll.ExtentHeight;
        var skeleton = Skeleton();
        CodexTranscriptList.Children.Insert(0, skeleton);
        try
        {
            await LoadCodexHistory(false, before);
            if (CodexTranscriptList.Children.Contains(skeleton)) CodexTranscriptList.Children.Remove(skeleton);
            CodexTranscriptScroll.UpdateLayout();
            CodexTranscriptScroll.ScrollToVerticalOffset(
                Math.Max(0, CodexTranscriptScroll.ExtentHeight - oldHeight));
        }
        finally
        {
            if (CodexTranscriptList.Children.Contains(skeleton)) CodexTranscriptList.Children.Remove(skeleton);
            loadingCodexOlder = false;
        }
    }

    private async void CodexComposer_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers is ModifierKeys.None or ModifierKeys.Control)
        { e.Handled = true; await SendCodexAsync(); }
    }

    private void CodexComposer_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (codexThread != null) codexDrafts[codexThread] = CodexComposer.Text;
        if (!codexSending)
        {
            codexPendingId = null;
            SetCodexStatus("");
        }
    }

    private void SetCodexStatus(string value)
    {
        CodexComposerStatus.Text = value;
        CodexComposerStatus.Visibility = string.IsNullOrEmpty(value) ? Visibility.Collapsed : Visibility.Visible;
    }

    private async Task SendCodexAsync()
    {
        if (codexSending || codexThread == null) return;
        var prompt = CodexComposer.Text.Trim();
        if (prompt.Length == 0) return;
        var thread = codexThread;
        codexPendingId ??= Guid.NewGuid().ToString("D");
        codexSending = true;
        CodexComposer.IsEnabled = false;
        SetCodexStatus("Adding prompt to the selected Codex chat…");
        try
        {
            var response = await bridge.RequestAsync(new { op = "codex_send", clientId = codexPendingId,
                threadId = thread, prompt }, stopping.Token);
            if (!Flag(response, "queued")) throw new IOException("Codex did not accept the prompt.");
            pendingCodexJobs[codexPendingId!] = thread;
            codexPendingId = null;
            SaveState();
            CodexComposer.Text = "";
            codexDrafts[thread] = "";
            SetCodexStatus(Flag(response, "laptopOnline") ? "Queued for Codex." :
                "Queued. The laptop relay will run it when connected.");
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            SetCodexStatus("Delivery is unconfirmed. Your draft is preserved; check the chat before retrying.");
        }
        finally { codexSending = false; CodexComposer.IsEnabled = true; CodexComposer.Focus(); }
    }

    private async Task RefreshCodexJob()
    {
        foreach (var (clientId, thread) in pendingCodexJobs.ToArray())
        {
            try
            {
                var response = await bridge.RequestAsync(new { op = "codex_job", clientId }, stopping.Token);
                if (!Flag(response, "available")) continue;
                var status = Value(response, "status");
                if (status == "completed")
                {
                    pendingCodexJobs.Remove(clientId);
                    SaveState();
                    if (codexThread == thread)
                    {
                        SetCodexStatus("Codex completed. Syncing the transcript…");
                        await LoadCodexHistory(false);
                    }
                }
                else if (status is "failed" or "unknown")
                {
                    pendingCodexJobs.Remove(clientId);
                    SaveState();
                    if (codexThread == thread)
                        SetCodexStatus($"Codex {status}. Open the chat in Codex for details.");
                }
                else if (codexThread == thread) SetCodexStatus(status switch {
                    "queued" => "Queued for the laptop relay.",
                    "claimed" or "submitting" => "Opening the selected Codex chat…",
                    "running" => "Codex is working in this chat…",
                    _ => "Waiting for Codex…"
                });
            }
            catch (Exception) { }
        }
    }

    private async Task RefreshActivityReport()
    {
        try
        {
            var report = await bridge.RequestAsync(new { op = "activity_report" }, stopping.Token);
            RenderActivityReport(report);
            activityRefreshed = DateTime.UtcNow;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            ActivityReport.Children.Clear();
            ActivityReport.Children.Add(new TextBlock { Text = "Activity statistics are temporarily unavailable.",
                Foreground = Brush("#ADB5BD") });
        }
    }

    private static string Duration(double seconds)
    {
        var minutes = (int)Math.Round(seconds / 60);
        return minutes >= 60 ? $"{minutes / 60}h {minutes % 60}m" : $"{minutes}m";
    }

    private void RenderActivityReport(JsonElement report)
    {
        ActivityReport.Children.Clear();
        var observed = Number(report, "observedSeconds");
        var active = Number(report, "activeSeconds");
        var idle = Number(report, "idleSeconds");
        var categories = report.GetProperty("categories").EnumerateArray()
            .Select(item => (Name: Value(item, "name"), Seconds: Number(item, "seconds"))).ToList();
        var totals = new Grid { Margin = new Thickness(0, 1, 0, 21) };
        totals.ColumnDefinitions.Add(new ColumnDefinition());
        totals.ColumnDefinitions.Add(new ColumnDefinition());
        totals.ColumnDefinitions.Add(new ColumnDefinition());
        AddMetric(totals, 0, "ACTIVE", Duration(active));
        AddMetric(totals, 1, "IDLE", Duration(idle));
        AddMetric(totals, 2, "OBSERVED", Duration(observed));
        ActivityReport.Children.Add(totals);
        ActivityReport.Children.Add(SectionTitle("TIME BY CATEGORY"));
        var chart = new Grid { Margin = new Thickness(0, 12, 0, 14) };
        chart.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) });
        chart.ColumnDefinitions.Add(new ColumnDefinition());
        var pie = MakePie(categories, active);
        chart.Children.Add(pie);
        var legend = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(15, 0, 0, 0) };
        var colors = CategoryColors;
        for (var i = 0; i < categories.Count; i++)
        {
            var row = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 9) };
            row.Children.Add(new Border { Width = 8, Height = 8, CornerRadius = new CornerRadius(4),
                Background = Brush(colors[i % colors.Length]), Margin = new Thickness(0, 3, 8, 0) });
            row.Children.Add(new TextBlock { Text = $"{categories[i].Name}  {Duration(categories[i].Seconds)}",
                Foreground = Brush("#DEE2E6"), TextWrapping = TextWrapping.Wrap, FontSize = 12 });
            legend.Children.Add(row);
        }
        if (categories.Count == 0) legend.Children.Add(new TextBlock { Text = "No active foreground samples yet.",
            Foreground = Brush("#ADB5BD"), TextWrapping = TextWrapping.Wrap });
        Grid.SetColumn(legend, 1);
        chart.Children.Add(legend);
        ActivityReport.Children.Add(chart);
        AddRanking(ActivityReport, "MOST TIME SPENT", report.GetProperty("topTargets"), true);
        AddRanking(ActivityReport, "APPLICATIONS", report.GetProperty("topApps"), false);
        ActivityReport.Children.Add(new TextBlock { Text = Value(report, "method"), Foreground = Brush("#ADB5BD"),
            FontSize = 11, TextWrapping = TextWrapping.Wrap, LineHeight = 17, Margin = new Thickness(0, 14, 0, 0) });
    }

    private static readonly string[] CategoryColors =
        ["#78A9F7", "#58C9A6", "#B391F2", "#F1AE69", "#E987AF", "#77CAE0", "#D5C76C", "#E67E79"];

    private static FrameworkElement MakePie(List<(string Name, long Seconds)> categories, long active)
    {
        const double center = 87, radius = 82;
        var canvas = new Canvas { Width = 174, Height = 174 };
        var baseCircle = new Ellipse { Width = 164, Height = 164, Fill = Brush("#2A2E32") };
        Canvas.SetLeft(baseCircle, 5); Canvas.SetTop(baseCircle, 5);
        canvas.Children.Add(baseCircle);
        var angle = -90.0;
        for (var i = 0; i < categories.Count && active > 0; i++)
        {
            var sweep = 360.0 * categories[i].Seconds / active;
            if (sweep <= 0) continue;
            if (sweep >= 359.99)
            {
                var full = new Ellipse { Width = 164, Height = 164,
                    Fill = Brush(CategoryColors[i % CategoryColors.Length]) };
                Canvas.SetLeft(full, 5); Canvas.SetTop(full, 5);
                canvas.Children.Add(full);
                break;
            }
            var a = angle * Math.PI / 180;
            var b = (angle + sweep) * Math.PI / 180;
            var figure = new PathFigure { StartPoint = new System.Windows.Point(center, center), IsClosed = true };
            figure.Segments.Add(new LineSegment(new System.Windows.Point(center + radius * Math.Cos(a), center + radius * Math.Sin(a)), true));
            figure.Segments.Add(new ArcSegment(new System.Windows.Point(center + radius * Math.Cos(b), center + radius * Math.Sin(b)),
                new System.Windows.Size(radius, radius), 0, sweep > 180, SweepDirection.Clockwise, true));
            figure.Segments.Add(new LineSegment(new System.Windows.Point(center, center), true));
            canvas.Children.Add(new System.Windows.Shapes.Path { Data = new PathGeometry([figure]),
                Fill = Brush(CategoryColors[i % CategoryColors.Length]) });
            angle += sweep;
        }
        var hole = new Ellipse { Width = 104, Height = 104, Fill = Brush("#141618") };
        Canvas.SetLeft(hole, 35); Canvas.SetTop(hole, 35);
        canvas.Children.Add(hole);
        var label = new TextBlock { Text = Duration(active), Foreground = Brush("#F8F9FA"),
            FontSize = 19, FontWeight = FontWeights.SemiBold, Width = 104,
            TextAlignment = TextAlignment.Center };
        Canvas.SetLeft(label, 35); Canvas.SetTop(label, 72);
        canvas.Children.Add(label);
        return canvas;
    }

    private static TextBlock SectionTitle(string value) => new() { Text = value, FontSize = 10,
        FontWeight = FontWeights.SemiBold, Foreground = Brush("#ADB5BD"), Margin = new Thickness(0, 7, 0, 8) };

    private static void AddMetric(Grid grid, int column, string name, string value)
    {
        var stack = new StackPanel { Margin = new Thickness(0, 0, 10, 0) };
        stack.Children.Add(new TextBlock { Text = name, FontSize = 10, Foreground = Brush("#ADB5BD") });
        stack.Children.Add(new TextBlock { Text = value, FontSize = 17, Foreground = Brush("#F8F9FA"),
            Margin = new Thickness(0, 5, 0, 0) });
        Grid.SetColumn(stack, column);
        grid.Children.Add(stack);
    }

    private static void AddRanking(StackPanel panel, string title, JsonElement items, bool category)
    {
        panel.Children.Add(SectionTitle(title));
        var count = 0;
        foreach (var item in items.EnumerateArray())
        {
            if (++count > 8) break;
            var grid = new Grid { Margin = new Thickness(0, 0, 0, 9) };
            grid.ColumnDefinitions.Add(new ColumnDefinition());
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var name = Value(item, "name");
            var group = category ? Value(item, "category") : "";
            grid.Children.Add(new TextBlock { Text = category ? $"{name}  ·  {group}" : name,
                Foreground = Brush("#DEE2E6"), TextTrimming = TextTrimming.CharacterEllipsis });
            var time = new TextBlock { Text = Duration(Number(item, "seconds")), Foreground = Brush("#ADB5BD"),
                Margin = new Thickness(12, 0, 0, 0) };
            Grid.SetColumn(time, 1); grid.Children.Add(time);
            panel.Children.Add(grid);
        }
        if (count == 0) panel.Children.Add(new TextBlock { Text = "No samples yet.", Foreground = Brush("#ADB5BD") });
    }

    private void RenderStatusPage(JsonElement page)
    {
        VmList.Children.Add(SectionTitle("SERVICE STATUS"));
        if (!Flag(page, "available"))
        {
            VmList.Children.Add(new TextBlock { Text = "Status metrics are temporarily unavailable.",
                Foreground = Brush("#ADB5BD"), Margin = new Thickness(0, 2, 0, 12) });
        }
        else
        {
            AddStatusRow(VmList, "CPU", Percent(page, "cpuPercent"));
            AddStatusRow(VmList, "Memory", Percent(page, "memoryPercent"));
            AddStatusRow(VmList, "Disk", Percent(page, "diskPercent"));
            AddStatusRow(VmList, "7-day CPU P95", Percent(page, "cpuSevenDayP95"));
            AddStatusRow(VmList, "Estimated usage", Money(page, "estimatedUsd"));
            AddStatusRow(VmList, "Today", Money(page, "todayEstimatedUsd"));
            AddStatusRow(VmList, "Tokens", Number(page, "tokens").ToString("N0"));
            var at = Number(page, "resourcesAt");
            VmList.Children.Add(new TextBlock { Text = "Host snapshot " + Time(at),
                Foreground = Brush("#ADB5BD"), FontSize = 11, Margin = new Thickness(0, 4, 0, 10) });
        }
        var link = new System.Windows.Controls.Button { Content = "Open status site ↗", Style = (Style)FindResource("QuietButton"),
            HorizontalAlignment = System.Windows.HorizontalAlignment.Left, Margin = new Thickness(-6, 0, 0, 18) };
        link.Click += (_, _) => OpenUrl("https://status.example.com/");
        VmList.Children.Add(link);
        VmList.Children.Add(SectionTitle("SERVICES"));
    }

    private static string Percent(JsonElement row, string name) =>
        row.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetDouble().ToString("0.0", CultureInfo.InvariantCulture) + "%" : "Unavailable";
    private static string Money(JsonElement row, string name) =>
        row.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? "$" + value.GetDouble().ToString("0.00", CultureInfo.InvariantCulture) : "Unavailable";
}
