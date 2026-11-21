using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace Misty.Overlay;

public partial class MainWindow
{
    private bool vmTrace;
    private bool traceLoading;

    private void VmOverview_Click(object sender, RoutedEventArgs e) => ShowVmTrace(false);

    private async void VmTrace_Click(object sender, RoutedEventArgs e)
    {
        ShowVmTrace(true);
        await RefreshTrace();
    }

    private void ShowVmTrace(bool show)
    {
        vmTrace = show;
        VmOverviewScroll.Visibility = show ? Visibility.Collapsed : Visibility.Visible;
        VmTraceScroll.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        VmOverviewTab.Foreground = Brush(show ? "#ADB5BD" : "#F8F9FA");
        VmTraceTab.Foreground = Brush(show ? "#F8F9FA" : "#ADB5BD");
    }

    private async Task RefreshTrace()
    {
        if (traceLoading) return;
        traceLoading = true;
        try
        {
            var result = await bridge.RequestAsync(new { op = "diagnostics" }, stopping.Token);
            RenderTrace(result);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception)
        {
            VmTraceList.Children.Clear();
            TraceText("Trace is unavailable while the VM connection is down.", 14, "#ADB5BD", 14);
        }
        finally { traceLoading = false; }
    }

    private void RenderTrace(JsonElement result)
    {
        var offset = VmTraceScroll.VerticalOffset;
        VmTraceList.Children.Clear();
        RenderAgentTasks(result);
        if (!result.TryGetProperty("run", out var run) || run.ValueKind != JsonValueKind.Object)
        {
            TraceText("Latest Misty turn", 19, "#F8F9FA", 4);
            TraceText("No owner turn has been recorded since trace logging was enabled.", 13, "#ADB5BD", 10);
            return;
        }

        var trigger = Number(run, "trigger_at");
        var handler = Number(run, "handler_at");
        var now = Number(result, "now");
        var state = Value(run, "state", "unknown");
        var events = result.GetProperty("events").EnumerateArray().ToArray();
        var end = state == "running" ? now : events.Length > 0 ?
            events.Max(item => Math.Max(Number(item, "at"), Number(item, "updated"))) : handler;
        var ready = EventAt(events, "agent_ready");
        var started = EventAt(events, "turn_started");
        var firstMessage = EventAt(events, "published");
        var role = Value(run, "role", "misty");
        var taskId = Value(run, "task_id");

        TraceText("Latest " + role + " turn", 19, "#F8F9FA", 2);
        if (!string.IsNullOrWhiteSpace(taskId))
            TraceText("Task " + taskId[..Math.Min(taskId.Length, 8)], 11, "#ADB5BD", 4);
        TraceText(ClockTime(trigger) + "  ·  " + state + "  ·  " +
                  Value(run, "model") + " / " + Value(run, "effort"), 12, "#ADB5BD", 14);
        TraceText(string.IsNullOrWhiteSpace(taskId) ? "Owner message" : "Task objective", 11, "#ADB5BD", 5);
        TraceSurface(Value(run, "input_text"), "#282B2E", 13);
        TraceText("Timing", 15, "#F8F9FA", 15);
        if (role == "misty")
        {
            TraceMetric("Trigger to handler", Duration(trigger, handler));
            TraceMetric("Handler to Codex ready", Duration(handler, ready));
            TraceMetric("Codex ready to turn start", Duration(ready, started));
            TraceMetric("Turn start to first reply", Duration(started, firstMessage));
        }
        else
        {
            TraceMetric("Queued to worker", Duration(trigger, handler));
            TraceMetric("Worker to turn start", Duration(handler, started));
            TraceMetric("Turn start to first output", Duration(started, EventAt(events, "visible_text")));
        }
        TraceMetric("Total so far", Duration(trigger, end));
        TraceText("Timeline", 15, "#F8F9FA", 18);
        TraceText(Value(result, "coverage"), 11, "#ADB5BD", 10);

        foreach (var item in events)
        {
            var at = Number(item, "at");
            var row = new StackPanel { Margin = new Thickness(0, 0, 0, 5) };
            var heading = new DockPanel();
            var stamp = new TextBlock { Text = "+" + Duration(trigger, at), Width = 80,
                Foreground = Brush("#ADB5BD"), FontSize = 11, VerticalAlignment = VerticalAlignment.Top };
            heading.Children.Add(stamp);
            heading.Children.Add(new TextBlock { Text = Value(item, "label"), Foreground = Brush("#F8F9FA"),
                FontSize = 12, TextWrapping = TextWrapping.Wrap, FontWeight = FontWeights.Medium });
            row.Children.Add(heading);
            var detail = Value(item, "detail");
            if (!string.IsNullOrWhiteSpace(detail))
                row.Children.Add(new TextBlock { Text = detail, TextWrapping = TextWrapping.Wrap,
                    Foreground = Brush("#CED4DA"), FontSize = 12, FontWeight = FontWeights.Normal,
                    Margin = new Thickness(80, 3, 0, 0) });
            VmTraceList.Children.Add(new Border { Background = Brush("#282B2E"), CornerRadius = new CornerRadius(8),
                Padding = new Thickness(11, 9, 11, 8), Margin = new Thickness(0, 0, 0, 3), Child = row });
        }
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () => VmTraceScroll.ScrollToVerticalOffset(offset));
    }

    private void RenderAgentTasks(JsonElement result)
    {
        if (!result.TryGetProperty("agentTasks", out var tasks) || tasks.ValueKind != JsonValueKind.Array)
            return;
        var paused = result.TryGetProperty("supervisorPaused", out var status) && status.ValueKind == JsonValueKind.True;
        var enabled = result.TryGetProperty("supervisorEnabled", out var available) && available.ValueKind == JsonValueKind.True;
        var controls = new Grid { Margin = new Thickness(0, 0, 0, 12) };
        controls.ColumnDefinitions.Add(new ColumnDefinition());
        controls.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        controls.Children.Add(new TextBlock { Text = "Agents", FontSize = 15,
            Foreground = Brush("#F8F9FA"), VerticalAlignment = VerticalAlignment.Center });
        if (enabled)
        {
            var toggle = TraceButton(paused ? "Resume supervisor" : "Pause supervisor");
            Grid.SetColumn(toggle, 1);
            toggle.Click += async (_, _) =>
            {
                toggle.IsEnabled = false;
                try { await bridge.RequestAsync(new { op = "supervisor_control", action = paused ? "resume" : "pause" }, stopping.Token); await RefreshTrace(); }
                catch (Exception) { toggle.IsEnabled = true; }
            };
            controls.Children.Add(toggle);
        }
        VmTraceList.Children.Add(controls);
        foreach (var task in tasks.EnumerateArray())
        {
            var id = Value(task, "id");
            var state = Value(task, "state");
            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 4) };
            var body = new StackPanel();
            body.Children.Add(new TextBlock { Text = Value(task, "role") + "  ·  " + state + "  ·  " + id[..Math.Min(id.Length, 8)],
                FontSize = 11, Foreground = Brush("#ADB5BD") });
            body.Children.Add(new TextBlock { Text = Value(task, "objective"), FontSize = 12,
                Foreground = Brush("#E9ECEF"), TextWrapping = TextWrapping.Wrap });
            var resultText = Value(task, "result");
            if (!string.IsNullOrWhiteSpace(resultText))
                body.Children.Add(new TextBlock { Text = resultText.Length > 220 ? resultText[..220] + "…" : resultText,
                    FontSize = 11, Foreground = Brush("#CED4DA"), TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 4, 0, 0) });
            if (task.TryGetProperty("events", out var events) && events.ValueKind == JsonValueKind.Array)
                foreach (var item in events.EnumerateArray().Where(item =>
                    Value(item, "kind") is "decision" or "checkpoint" or "branch_prepared" or "branch_pushed" or
                    "release_receipt" or "rollback_receipt" or "rollback_failed" or "handed_to_misty").TakeLast(3))
                    body.Children.Add(new TextBlock { Text = Value(item, "kind").Replace('_', ' ') + ": " + Value(item, "detail")[..Math.Min(Value(item, "detail").Length, 160)],
                        FontSize = 10, Foreground = Brush("#ADB5BD"), TextWrapping = TextWrapping.Wrap,
                        Margin = new Thickness(0, 2, 0, 0) });
            if (events.ValueKind == JsonValueKind.Array && events.GetArrayLength() == 0 &&
                task.TryGetProperty("summaries", out var summaries) && summaries.ValueKind == JsonValueKind.Array)
                foreach (var item in summaries.EnumerateArray().Where(item =>
                    Value(item, "kind") is "decision" or "branch_pushed" or "release_receipt" or "rollback_receipt" or "rollback_failed").TakeLast(3))
                    body.Children.Add(new TextBlock { Text = Value(item, "kind").Replace('_', ' ') + ": " + Value(item, "detail")[..Math.Min(Value(item, "detail").Length, 160)],
                        FontSize = 10, Foreground = Brush("#ADB5BD"), TextWrapping = TextWrapping.Wrap,
                        Margin = new Thickness(0, 2, 0, 0) });
            if (state is "queued" or "running" or "waiting")
            {
                var stop = TraceButton("Stop");
                DockPanel.SetDock(stop, Dock.Right);
                stop.Click += async (_, _) =>
                {
                    stop.IsEnabled = false;
                    try { await bridge.RequestAsync(new { op = "task_stop", taskId = id }, stopping.Token); await RefreshTrace(); }
                    catch (Exception) { stop.IsEnabled = true; }
                };
                row.Children.Add(stop);
            }
            row.Children.Add(body);
            VmTraceList.Children.Add(new Border { Background = Brush("#282B2E"), CornerRadius = new CornerRadius(8),
                Padding = new Thickness(11, 9, 11, 9), Margin = new Thickness(0, 0, 0, 4), Child = row });
        }
    }

    private static System.Windows.Controls.Button TraceButton(string label) => new()
    {
        Content = label, Background = Brush("#343A40"), Foreground = Brush("#F8F9FA"),
        BorderThickness = new Thickness(0), Padding = new Thickness(10, 5, 10, 5),
        Margin = new Thickness(8, 0, 0, 0), FontSize = 11,
        VerticalAlignment = VerticalAlignment.Top
    };

    private void TraceText(string value, double size, string color, double bottom)
    {
        VmTraceList.Children.Add(new TextBlock { Text = value, FontSize = size, Foreground = Brush(color),
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, bottom),
            FontWeight = FontWeights.Normal });
    }

    private void TraceSurface(string value, string color, double size)
    {
        VmTraceList.Children.Add(new Border { Background = Brush(color), CornerRadius = new CornerRadius(8),
            Padding = new Thickness(11, 9, 11, 9), Child = new TextBlock { Text = value, FontSize = size,
                TextWrapping = TextWrapping.Wrap, Foreground = Brush("#E9ECEF") } });
    }

    private void TraceMetric(string name, string value)
    {
        var row = new Grid { Margin = new Thickness(0, 0, 0, 8) };
        row.ColumnDefinitions.Add(new ColumnDefinition());
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(new TextBlock { Text = name, Foreground = Brush("#ADB5BD"), FontSize = 12 });
        var duration = new TextBlock { Text = value, Foreground = Brush("#F8F9FA"), FontSize = 12 };
        Grid.SetColumn(duration, 1);
        row.Children.Add(duration);
        VmTraceList.Children.Add(row);
    }

    private static long EventAt(JsonElement[] events, string kind) =>
        events.Where(item => Value(item, "kind") == kind).Select(item => Number(item, "at"))
              .FirstOrDefault();

    private static string Duration(long start, long end) => start <= 0 || end <= 0 || end < start
        ? "Waiting" : ((end - start) / 1000.0).ToString("0.000") + " s";

    private static string ClockTime(long at) => at <= 0 ? "Unknown time" :
        DateTimeOffset.FromUnixTimeMilliseconds(at).ToLocalTime().ToString("dd MMM h:mm:ss.fff tt");
}
