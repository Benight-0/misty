using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Forms = System.Windows.Forms;
using WpfFontFamily = System.Windows.Media.FontFamily;
using WpfRichTextBox = System.Windows.Controls.RichTextBox;

namespace Misty.Overlay;

public partial class MainWindow : Window
{
    private const string ArchiveUrl = "https://archival.example.com";
    private const int CompactWidth = 82;
    private const int ExpandedWidth = 622;
    private const int GmailWidth = 1040;
    private const int ApprovalWidth = 770;
    private const int CompactHeight = 590;
    private const int ExpandedHeight = 700;
    private const int HotkeyId = 0x4D57;
    private const int WmHotkey = 0x0312;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModShift = 0x0004;
    private readonly SshBridge bridge;
    private readonly CancellationTokenSource stopping = new();
    private readonly HashSet<string> messageIds = new();
    private readonly List<ChatEntry> chatEntries = new();
    private readonly string stateFile;
    private readonly Forms.NotifyIcon tray;
    private readonly System.Drawing.Icon trayIcon;
    private readonly MemoryStream? pingStream;
    private readonly System.Media.SoundPlayer? pingSound;
    private string chatCursor = "";
    private long codexCursor;
    private string oldestMessage = "";
    private string selected = "";
    private string? pendingId;
    private string? replyTargetId;
    private bool initialized;
    private bool exitRequested;
    private bool notifications = true;
    private bool unreadChat;
    private bool unreadCodex;
    private bool sending;
    private bool loadingOlder;
    private bool hasOlder = true;
    private bool loadingCodexOlder;
    private bool hasCodexOlder;
    private bool codexSending;
    private string? codexThread;
    private string? codexPendingId;
    private readonly Dictionary<string, string> pendingCodexJobs = new();
    private int? codexBefore;
    private int codexSearchVersion;
    private DateTime activityRefreshed = DateTime.MinValue;
    private readonly List<CodexChat> codexChats = new();
    private readonly List<CodexLine> codexLines = new();
    private readonly Dictionary<string, string> codexDrafts = new();
    private bool hotkeyRegistered;
    private int hotkeyError;
    private string shortcut = "Ctrl+Shift+Space";
    private HwndSource? windowSource;
    private int statusTicks;
    private ChatTypography savedTypography = ChatTypography.Default;

    private sealed record ChatTypography(string Font, double Size, double LineHeight)
    {
        public static ChatTypography Default => new("whitney", 16, 22);
    }

    private sealed record ChatFont(string Key, WpfFontFamily Family);
    private static readonly ChatFont[] ChatFonts =
    [
        new("whitney", new WpfFontFamily("Whitney Book, Segoe UI")),
        new("inter", BundledFont("Inter", "Inter")),
        new("roboto", BundledFont("Roboto", "Roboto")),
        new("ibm-plex-sans", BundledFont("IBMPlexSans", "IBM Plex Sans")),
        new("source-sans-3", BundledFont("SourceSans3", "Source Sans 3")),
        new("mona-sans", BundledFont("MonaSans", "Mona Sans"))
    ];

    private static WpfFontFamily BundledFont(string directory, string family) =>
        new(new Uri("pack://application:,,,/"), $"./Assets/Fonts/{directory}/#{family}");

    private sealed record ChatEntry(string Id, string Role, string Body, long At,
        string DisplayName, string AvatarUrl, bool Interactive, string DiscordUrl,
        string ReplyToId = "", string ReplyToName = "", string ReplyPreview = "");
    private sealed record CodexChat(string Id, string Title, string Workspace, string Status, long UpdatedAt, long SyncedAt, int Parts);
    private sealed record CodexLine(int Ordinal, string Role, string Text, string At);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr window, int id);

    public MainWindow()
    {
        InitializeComponent();
        InitializeWorkingClock();
        bridge = new SshBridge(SshBridge.FindRoot());
        var local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Misty", "Overlay");
        Directory.CreateDirectory(local);
        stateFile = Path.Combine(local, "state.json");
        LoadState();
        UpdateUnreadDots();
        InitializeMailAndApprovals();
        ApplyChatTypography();
        trayIcon = MakeIcon();
        try
        {
            using var resource = System.Windows.Application.GetResourceStream(
                new Uri("pack://application:,,,/Assets/notification-ping.wav"))?.Stream;
            if (resource != null)
            {
                pingStream = new MemoryStream();
                resource.CopyTo(pingStream);
                pingStream.Position = 0;
                pingSound = new System.Media.SoundPlayer(pingStream);
                pingSound.Load();
            }
        }
        catch (Exception) { pingSound?.Dispose(); pingStream?.Dispose(); }
        tray = new Forms.NotifyIcon { Icon = trayIcon, Text = "Misty", Visible = true };
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open Misty", null, (_, _) => Dispatcher.Invoke(ShowFromTray));
        var topmost = new Forms.ToolStripMenuItem("Always on top") { Checked = Topmost, CheckOnClick = true };
        topmost.CheckedChanged += (_, _) => Dispatcher.Invoke(() => Topmost = topmost.Checked);
        menu.Items.Add(topmost);
        var alerts = new Forms.ToolStripMenuItem("Notifications") { Checked = notifications, CheckOnClick = true };
        alerts.CheckedChanged += (_, _) => Dispatcher.Invoke(() => { notifications = alerts.Checked; SaveState(); });
        menu.Items.Add(alerts);
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => Dispatcher.Invoke(Exit));
        tray.ContextMenuStrip = menu;
        InitializeVoiceMenu(menu);
        tray.DoubleClick += (_, _) => Dispatcher.Invoke(ShowFromTray);
    }

    private static System.Drawing.Icon MakeIcon()
    {
        var path = Environment.ProcessPath;
        return !string.IsNullOrEmpty(path) && System.Drawing.Icon.ExtractAssociatedIcon(path) is { } icon
            ? icon : (System.Drawing.Icon)System.Drawing.SystemIcons.Application.Clone();
    }

    private void LoadState()
    {
        try
        {
            using var state = JsonDocument.Parse(File.ReadAllText(stateFile));
            chatCursor = Value(state.RootElement, "chatCursor");
            codexCursor = Number(state.RootElement, "codexCursor");
            if (state.RootElement.TryGetProperty("pendingCodexJobs", out var jobs) &&
                jobs.ValueKind == JsonValueKind.Object)
                foreach (var item in jobs.EnumerateObject())
                    if (Guid.TryParse(item.Name, out _) && item.Value.ValueKind == JsonValueKind.String &&
                        Guid.TryParse(item.Value.GetString(), out _))
                        pendingCodexJobs[item.Name] = item.Value.GetString()!;
            if (state.RootElement.TryGetProperty("notifications", out var value)) notifications = value.GetBoolean();
            unreadChat = state.RootElement.TryGetProperty("unreadChat", out var chatUnread) &&
                chatUnread.ValueKind == JsonValueKind.True;
            unreadCodex = state.RootElement.TryGetProperty("unreadCodex", out var codexUnread) &&
                codexUnread.ValueKind == JsonValueKind.True;
            if (state.RootElement.TryGetProperty("chatTypography", out var typography) &&
                typography.ValueKind == JsonValueKind.Object)
            {
                var font = Value(typography, "font", "whitney");
                if (!ChatFonts.Any(choice => choice.Key == font)) font = "whitney";
                var size = Decimal(typography, "size", 16, 12, 22);
                var lineHeight = Decimal(typography, "lineHeight", 22, Math.Max(16, size + 2), 36);
                savedTypography = new(font, size, lineHeight);
            }
        }
        catch (IOException) { }
        catch (JsonException) { }
    }

    private void SaveState()
    {
        var temp = stateFile + ".tmp";
        try
        {
            File.WriteAllText(temp, JsonSerializer.Serialize(new { chatCursor, codexCursor, notifications,
                unreadChat, unreadCodex,
                pendingCodexJobs,
                chatTypography = new { font = savedTypography.Font, size = savedTypography.Size,
                    lineHeight = savedTypography.LineHeight } }));
            File.Move(temp, stateFile, true);
        }
        catch (IOException) { }
    }

    private static string Value(JsonElement item, string name, string fallback = "") =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;
    private static long Number(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.TryGetInt64(out var number) ? number : 0;
    private static double Decimal(JsonElement item, string name, double fallback, double min, double max) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number &&
        value.TryGetDouble(out var number) && double.IsFinite(number)
            ? Math.Clamp(number, min, max) : Math.Clamp(fallback, min, max);
    private static bool Flag(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
    private static string Time(long milliseconds) => milliseconds > 0 ?
        DateTimeOffset.FromUnixTimeMilliseconds(milliseconds).ToLocalTime().ToString("dd MMM, h:mm tt") : "";
    private static System.Windows.Media.Brush Brush(string hex) =>
        (System.Windows.Media.Brush)new BrushConverter().ConvertFromString(hex)!;
    private const string OnlineColor = "#43C982";
    private const string IdleColor = "#F0B85A";
    private const string OfflineColor = "#F07178";

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        var work = SystemParameters.WorkArea;
        Width = CompactWidth;
        Height = Math.Min(CompactHeight, work.Height - 30);
        Left = work.Right - Width - 16;
        Top = work.Top + Math.Max(15, (work.Height - Math.Min(ExpandedHeight, work.Height - 30)) / 2);
        RestoreWorkspace();
        StartLocalVoice();
        await InitializeAsync();
        voiceReady = true;
        StartDesktopPresence();
    }

    private void DockSurface_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        DockSurface.Clip = new RectangleGeometry(
            new Rect(0, 0, e.NewSize.Width, e.NewSize.Height), 34, 34);
    }

    private void Window_SourceInitialized(object sender, EventArgs e)
    {
        windowSource = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
        windowSource.AddHook(HotkeyHook);
        RegisterVoiceHotkeys();
        hotkeyRegistered = RegisterHotKey(windowSource.Handle, HotkeyId, ModControl | ModShift,
            (uint)KeyInterop.VirtualKeyFromKey(Key.Space));
        if (!hotkeyRegistered)
        {
            hotkeyError = Marshal.GetLastWin32Error();
            shortcut = "Ctrl+Alt+Shift+M";
            hotkeyRegistered = RegisterHotKey(windowSource.Handle, HotkeyId, ModControl | ModAlt | ModShift,
                (uint)KeyInterop.VirtualKeyFromKey(Key.M));
            if (!hotkeyRegistered) hotkeyError = Marshal.GetLastWin32Error();
        }
        tray.Text = hotkeyRegistered ? "Misty · " + shortcut : "Misty · shortcut unavailable";
        HideButton.ToolTip = hotkeyRegistered ? "Hide overlay · " + shortcut : "Hide overlay";
    }

    private IntPtr HotkeyHook(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == WmHotkey && HandleVoiceHotkey(wParam.ToInt32())) { handled = true; return IntPtr.Zero; }
        if (message == WmHotkey && wParam.ToInt32() == HotkeyId)
        {
            handled = true;
            if (IsVisible) Hide();
            else ShowFromTray();
        }
        return IntPtr.Zero;
    }

    private async Task InitializeAsync()
    {
        try
        {
            var previousChat = chatCursor;
            var previousCodex = codexCursor;
            var history = await bridge.RequestAsync(new { op = "messages" }, stopping.Token);
            AddMessages(history, true);
            var events = await bridge.RequestAsync(new { op = "codex" }, stopping.Token);
            AddEvents(events, false);
            if (!string.IsNullOrEmpty(previousChat) && previousChat != chatCursor)
            {
                var missed = await bridge.RequestAsync(new { op = "messages", after = previousChat }, stopping.Token);
                AlertMessages(missed, previousChat);
            }
            if (previousCodex > 0 && previousCodex != codexCursor)
            {
                var missed = await bridge.RequestAsync(new { op = "codex", after = previousCodex }, stopping.Token);
                AlertEvents(missed, previousCodex);
            }
            await RefreshStatus();
            await RefreshApprovals(true);
            initialized = true;
            SaveState();
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            SetConnection(false, "Reconnecting to the VM");
            SetComposerStatus("Misty is offline. Your draft stays here.");
        }
        _ = PollAsync();
        _ = PollWorkingAsync();
    }

    private async Task PollWorkingAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), stopping.Token);
                if (selected == "chat" && initialized && IsVisible) await RefreshWorkingAsync();
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { break; }
        }
    }

    private async Task RefreshWorkingAsync()
    {
        try
        {
            var working = await bridge.RequestAsync(new { op = "working" }, stopping.Token);
            SetWorking(working);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception) { WorkingStrip.Visibility = Visibility.Collapsed; }
    }

    private async Task PollAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(6), stopping.Token);
                if (!initialized)
                {
                    var history = await bridge.RequestAsync(new { op = "messages" }, stopping.Token);
                    AddMessages(history, true);
                    var recent = await bridge.RequestAsync(new { op = "codex" }, stopping.Token);
                    AddEvents(recent, true);
                    await RefreshStatus();
                    await RefreshApprovals(true);
                    initialized = true;
                    SaveState();
                    continue;
                }
                var messages = await bridge.RequestAsync(new { op = "messages", after = chatCursor }, stopping.Token);
                AlertMessages(messages);
                AddMessages(messages, true);
                var events = await bridge.RequestAsync(new { op = "codex", after = codexCursor }, stopping.Token);
                AlertEvents(events);
                AddEvents(events, true);
                await RefreshApprovals(false);
                if (++statusTicks % 3 == 0 || !initialized) await RefreshStatus();
                if (selected == "codex")
                {
                    await RefreshCodexJob();
                    if (statusTicks % 3 == 0)
                    {
                        await RefreshCodexChats();
                        if (codexThread != null) await LoadCodexHistory(false);
                    }
                }
                if (selected == "activity" && DateTime.UtcNow - activityRefreshed > TimeSpan.FromMinutes(1))
                    await RefreshActivityReport();
                if (selected == "vm" && vmTrace) await RefreshTrace();
                SetConnection(true, "Private VM bridge connected");
                initialized = true;
                SaveState();
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { break; }
            catch (Exception)
            {
                SetConnection(false, "Reconnecting to the VM");
                await Task.Delay(TimeSpan.FromSeconds(6), stopping.Token).ContinueWith(_ => { });
            }
        }
    }

    private void SetConnection(bool online, string detail)
    {
        ConnectionDot.Fill = Brush(online ? OnlineColor : OfflineColor);
        ConnectionText.Text = online ? "Connected" : "VM unavailable";
        ConnectionDetail.Text = detail;
        ConnectionDot.ToolTip = ConnectionText.Text + " · " + detail;
        if (!online)
        {
            ActivityState.Text = "Unavailable";
            ActivityAge.Text = "Waiting for the private bridge.";
            if (messageIds.Count == 0) ChatEmpty.Text = "Misty is offline. Your conversation will appear when the VM reconnects.";
        }
    }

    private async Task RefreshStatus()
    {
        var result = await bridge.RequestAsync(new { op = "status" }, stopping.Token);
        SetConnection(true, "Private VM bridge connected");
        var activity = result.GetProperty("laptopActivity");
        ActivityState.Text = Value(activity, "state", "unavailable") switch
        {
            "fresh" => "Sampling is current",
            "paused" => "Paused",
            "stale" => "Sample is stale",
            _ => "Unavailable"
        };
        var age = Number(activity, "captureAgeSeconds");
        ActivityAge.Text = activity.TryGetProperty("captureAgeSeconds", out var ageValue) && ageValue.ValueKind != JsonValueKind.Null
            ? $"Last sample {age} seconds ago" : "No stored sample is available.";
        VmList.Children.Clear();
        RenderStatusPage(result.GetProperty("statusPage"));
        AddStatusRow(VmList, "Owner conversation", "Connected");
        AddStatusRow(VmList, "Overlay shortcut", hotkeyRegistered ? shortcut : $"Unavailable ({hotkeyError})");
        AddStatusRow(VmList, "Laptop Codex relay", Flag(result, "codexRelayOnline") ? "Online" : "Offline");
        AddStatusRow(VmList, "Laptop activity", ActivityState.Text);
        foreach (var item in result.GetProperty("services").EnumerateObject())
            AddStatusRow(VmList, item.Name switch {
                "misty-prominence" => "Misty agent",
                "misty-bot" => "Misty bridge",
                "misty-activity" => "Activity ingestion",
                "misty-metrics" => "Status dashboard",
                "archival" => "Archive",
                _ => item.Name
            }, item.Value.GetString() ?? "Unknown");
        var checkedAt = Number(result, "at");
        VmList.Children.Add(new TextBlock { Text = "Checked " + Time(checkedAt), Margin = new Thickness(0, 20, 0, 0),
            Foreground = Brush("#ADB5BD"), FontSize = 11 });
    }

    private static void AddStatusRow(System.Windows.Controls.Panel panel, string label, string value)
    {
        var row = new Grid { Height = 53 };
        row.ColumnDefinitions.Add(new ColumnDefinition());
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var name = new TextBlock { Text = label, Foreground = Brush("#F8F9FA"), VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(13, 0, 12, 0) };
        var state = new TextBlock { Text = value, Foreground = Brush(value is "active" or "Online" or "Connected" or "Sampling is current" || value.StartsWith("Ctrl+") ? "#E9ECEF" : "#ADB5BD"),
            FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 13, 0) };
        var stateGroup = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center };
        var statusColor = StatusDotColor(value);
        if (statusColor != null)
            stateGroup.Children.Add(new System.Windows.Shapes.Ellipse { Width = 7, Height = 7,
                Fill = Brush(statusColor), Margin = new Thickness(0, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center });
        stateGroup.Children.Add(state);
        Grid.SetColumn(stateGroup, 1);
        row.Children.Add(name); row.Children.Add(stateGroup);
        panel.Children.Add(new Border { Background = Brush("#2A2E32"),
            CornerRadius = new CornerRadius(10), Margin = new Thickness(0, 0, 0, 5),
            Child = row });
    }

    private static string? StatusDotColor(string value) => value.ToLowerInvariant() switch
    {
        "active" or "online" or "connected" or "sampling is current" => OnlineColor,
        "idle" or "paused" or "sample is stale" or "stale" => IdleColor,
        "offline" or "unavailable" or "inactive" or "failed" => OfflineColor,
        _ when value.StartsWith("Unavailable (", StringComparison.OrdinalIgnoreCase) => OfflineColor,
        _ => null
    };

    private void AddMessages(JsonElement response, bool follow)
    {
        UpdateWorking(response);
        var changed = false;
        foreach (var row in response.GetProperty("messages").EnumerateArray())
        {
            var id = Value(row, "id");
            if (string.IsNullOrEmpty(id) || !messageIds.Add(id)) continue;
            if (string.IsNullOrEmpty(oldestMessage) || ulong.Parse(id) < ulong.Parse(oldestMessage)) oldestMessage = id;
            if (string.IsNullOrEmpty(chatCursor) || ulong.Parse(id) > ulong.Parse(chatCursor)) chatCursor = id;
            var role = Value(row, "role");
            var reply = row.TryGetProperty("replyTo", out var reference) &&
                reference.ValueKind == JsonValueKind.Object ? reference : default;
            chatEntries.Add(new ChatEntry(id, role, Value(row, "body"), Number(row, "at"),
                Value(row, "displayName", role == "owner" ? "You" : "Misty"),
                Value(row, "avatarUrl"), Flag(row, "interactive"), Value(row, "discordUrl"),
                reply.ValueKind == JsonValueKind.Object ? Value(reply, "id") : "",
                reply.ValueKind == JsonValueKind.Object ? Value(reply, "name") : "",
                reply.ValueKind == JsonValueKind.Object ? Value(reply, "body") : ""));
            changed = true;
        }
        if (changed)
        {
            chatEntries.Sort((a, b) => ulong.Parse(a.Id).CompareTo(ulong.Parse(b.Id)));
            RenderConversation();
            if (follow) Dispatcher.BeginInvoke(() => ChatScroll.ScrollToEnd(), DispatcherPriority.Loaded);
        }
        else if (chatEntries.Count == 0) ChatEmpty.Text = "No messages in this conversation yet.";
        if (string.IsNullOrEmpty(oldestMessage)) hasOlder = false;
    }

    private void UpdateWorking(JsonElement response)
    {
        if (response.TryGetProperty("working", out var working)) SetWorking(working);
    }

    private void SetWorking(JsonElement working)
    {
        workingSnapshot = working.Clone();
        RenderWorkingClock();
    }

    private void RenderConversation()
    {
        MessageList.Children.Clear();
        if (chatEntries.Count == 0)
        {
            MessageList.Children.Add(ChatEmpty);
            return;
        }
        ChatEntry? previous = null;
        foreach (var entry in chatEntries)
        {
            var newGroup = previous == null || previous.Role != entry.Role ||
                entry.At - previous.At > TimeSpan.FromMinutes(5).TotalMilliseconds ||
                DateTimeOffset.FromUnixTimeMilliseconds(entry.At).ToLocalTime().Date !=
                DateTimeOffset.FromUnixTimeMilliseconds(previous.At).ToLocalTime().Date;
            MessageList.Children.Add(MessageRow(entry, newGroup, true));
            previous = entry;
        }
    }

    private ChatFont SelectedChatFont() =>
        ChatFonts.FirstOrDefault(font => font.Key == savedTypography.Font) ?? ChatFonts[0];

    private void ApplyChatTypography()
    {
        var font = SelectedChatFont().Family;
        System.Windows.Documents.TextElement.SetFontFamily(ChatPanel, font);
        Composer.FontFamily = font;
        Composer.FontSize = savedTypography.Size;
        CodexComposer.FontFamily = font;
        CodexComposer.FontSize = savedTypography.Size;
    }

    private FrameworkElement MessageRow(ChatEntry entry, bool newGroup, bool canReply = false)
    {
        var item = new Grid { Margin = new Thickness(0, newGroup ? 17 : 2, 0, 0),
            Tag = canReply && replyTargetId == entry.Id ? "reply" : null,
            Style = (Style)FindResource("MessageHover") };
        item.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(49) });
        item.ColumnDefinitions.Add(new ColumnDefinition());
        if (canReply) item.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(28) });
        if (newGroup)
        {
            item.Children.Add(Avatar(entry));
        }
        else
        {
            var stamp = new TextBlock { Text = DateTimeOffset.FromUnixTimeMilliseconds(entry.At)
                    .ToLocalTime().ToString("h:mm"), FontSize = 10, Foreground = Brush("#6C757D"),
                VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 3, 0, 0) };
            item.Children.Add(stamp);
        }
        var content = new StackPanel();
        if (newGroup)
        {
            var heading = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 4) };
            heading.Children.Add(new TextBlock { Text = entry.DisplayName, FontSize = 14,
                FontWeight = FontWeights.SemiBold, Foreground = Brush("#F8F9FA") });
            heading.Children.Add(new TextBlock { Text = Time(entry.At), FontSize = 10,
                Foreground = Brush("#ADB5BD"), VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(9, 2, 0, 0) });
            content.Children.Add(heading);
        }
        if (!string.IsNullOrEmpty(entry.ReplyToId))
            content.Children.Add(new TextBlock {
                Text = "↪ " + entry.ReplyToName + (string.IsNullOrEmpty(entry.ReplyPreview) ? "" : " · " + entry.ReplyPreview),
                Foreground = Brush("#ADB5BD"), FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis,
                Margin = new Thickness(0, 0, 0, 3) });
        var body = FormattedText.View(entry.Body, SelectedChatFont().Family, savedTypography.Size,
            savedTypography.LineHeight, Brush("#E9ECEF"), OpenUrl);
        body.ToolTip = Time(entry.At);
        content.Children.Add(body);
        if (entry.Interactive && !string.IsNullOrEmpty(entry.DiscordUrl))
        {
            var link = new System.Windows.Controls.Button { Content = "Open controls in Discord",
                Style = (Style)System.Windows.Application.Current.MainWindow.FindResource("QuietButton"),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                Margin = new Thickness(-6, 5, 0, 0) };
            var url = entry.DiscordUrl;
            link.Click += (_, _) => OpenUrl(url);
            content.Children.Add(link);
        }
        Grid.SetColumn(content, 1);
        item.Children.Add(content);
        if (canReply)
        {
            var replyButton = new System.Windows.Controls.Button {
                Tag = entry.Id, Style = (Style)FindResource("MessageReplyButton"),
                VerticalAlignment = VerticalAlignment.Top };
            System.Windows.Automation.AutomationProperties.SetName(replyButton, "Reply to " + entry.DisplayName);
            replyButton.Click += Reply_Click;
            Grid.SetColumn(replyButton, 2);
            item.Children.Add(replyButton);
        }
        return item;
    }

    private void Reply_Click(object sender, RoutedEventArgs e)
    {
        if (sending || sender is not System.Windows.Controls.Button button ||
            button.Tag is not string id) return;
        var target = chatEntries.FirstOrDefault(entry => entry.Id == id);
        if (target == null) return;
        replyTargetId = id;
        pendingId = null;
        ReplyLabel.Text = target.Role == "misty" ? "Replying to Misty" : "Replying to you";
        ReplyStrip.ToolTip = target.Body.Length > 160 ? target.Body[..160] + "…" : target.Body;
        ReplyStrip.Visibility = Visibility.Visible;
        RerenderChatAtCurrentPosition();
        Composer.Focus();
    }

    private void CancelReply_Click(object sender, RoutedEventArgs e)
    {
        if (sending) return;
        ClearReply();
        Composer.Focus();
    }

    private void ClearReply()
    {
        if (replyTargetId == null) return;
        replyTargetId = null;
        pendingId = null;
        ReplyStrip.Visibility = Visibility.Collapsed;
        ReplyStrip.ToolTip = null;
        RerenderChatAtCurrentPosition();
    }

    private void RerenderChatAtCurrentPosition()
    {
        var offset = ChatScroll.VerticalOffset;
        RenderConversation();
        _ = Dispatcher.BeginInvoke(() => ChatScroll.ScrollToVerticalOffset(offset),
            DispatcherPriority.Loaded);
    }

    private static FrameworkElement Avatar(ChatEntry entry)
    {
        var frame = new Grid { Width = 38, Height = 38, VerticalAlignment = VerticalAlignment.Top,
            Clip = new EllipseGeometry(new System.Windows.Point(19, 19), 19, 19) };
        frame.Children.Add(new Border { Background = Brush(entry.Role == "owner" ? "#495057" : "#343A40") });
        frame.Children.Add(new TextBlock { Text = entry.DisplayName.Length > 0 ? entry.DisplayName[..1].ToUpperInvariant() : "?",
            Foreground = Brush("#F8F9FA"), FontWeight = FontWeights.SemiBold, FontSize = 18,
            HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center });
        var url = entry.Role == "misty" ? "pack://application:,,,/Assets/misty-avatar.png" : entry.AvatarUrl;
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
            (entry.Role == "misty" || uri.Scheme == "https" && uri.Host == "cdn.discordapp.com"))
        {
            try
            {
                var image = new System.Windows.Controls.Image { Source = new BitmapImage(uri),
                    Width = 38, Height = 38, Stretch = Stretch.UniformToFill };
                image.ImageFailed += (_, _) => image.Visibility = Visibility.Collapsed;
                frame.Children.Add(image);
            }
            catch (Exception error) when (error is UriFormatException or IOException or NotSupportedException) { }
        }
        return frame;
    }

    private void AddEvents(JsonElement response, bool follow)
    {
        foreach (var row in response.GetProperty("events").EnumerateArray())
        {
            var seq = Number(row, "seq");
            codexCursor = Math.Max(codexCursor, seq);
        }
    }

    private void AlertMessages(JsonElement response, string? from = null)
    {
        var cursor = from ?? chatCursor;
        var hasNew = response.GetProperty("messages").EnumerateArray()
            .Any(row => Value(row, "role") == "misty" &&
                        (string.IsNullOrEmpty(cursor) || ulong.Parse(Value(row, "id")) > ulong.Parse(cursor)));
        if (!hasNew) return;
        Notify("chat");
    }

    private void AlertEvents(JsonElement response, long? from = null)
    {
        var cursor = from ?? codexCursor;
        var hasNew = response.GetProperty("events").EnumerateArray()
            .Any(row => Number(row, "seq") > cursor && !string.IsNullOrWhiteSpace(Value(row, "text")));
        if (!hasNew) return;
        Notify("codex");
    }

    private void Notify(string target)
    {
        if (!(IsVisible && IsActive && selected == target && DetailRoot.Visibility == Visibility.Visible))
        {
            if (target == "chat") unreadChat = true;
            else if (target == "codex") unreadCodex = true;
            UpdateUnreadDots();
            SaveState();
        }
        if (!notifications) return;
        if (!IsVisible)
        {
            CollapsePanel();
            ShowActivated = false;
            Show();
        }
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        PulseRail();
    }

    private void PulseRail()
    {
        try
        {
            if (pingSound != null) pingSound.Play();
            else System.Media.SystemSounds.Asterisk.Play();
        }
        catch (Exception)
        {
            try { System.Media.SystemSounds.Asterisk.Play(); }
            catch (Exception) { }
        }
        RailRoot.BeginAnimation(OpacityProperty, null);
        RailRoot.Opacity = 1;
        RailRoot.BeginAnimation(OpacityProperty, new DoubleAnimation(1, 0.25,
            TimeSpan.FromMilliseconds(500)) {
            AutoReverse = true,
            RepeatBehavior = new RepeatBehavior(5),
            FillBehavior = FillBehavior.Stop
        });
    }

    private void UpdateUnreadDots()
    {
        DmUnreadDot.Visibility = unreadChat ? Visibility.Visible : Visibility.Collapsed;
        CodexUnreadDot.Visibility = unreadCodex ? Visibility.Visible : Visibility.Collapsed;
        TalkButton.ToolTip = unreadChat ? "Direct Message · unread" : "Direct Message";
        CodexButton.ToolTip = unreadCodex ? "Codex · unread" : "Codex";
        System.Windows.Automation.AutomationProperties.SetName(TalkButton,
            unreadChat ? "Direct Message, unread" : "Direct Message");
        System.Windows.Automation.AutomationProperties.SetName(CodexButton,
            unreadCodex ? "Codex, unread" : "Codex");
    }

    private void ClearUnread(string panel)
    {
        if (panel == "chat" && unreadChat) unreadChat = false;
        else if (panel == "codex" && unreadCodex) unreadCodex = false;
        else return;
        UpdateUnreadDots();
        SaveState();
    }

    private static FrameworkElement Skeleton()
    {
        var stack = new StackPanel { Margin = new Thickness(0, 4, 0, 12) };
        foreach (var width in new[] { 158.0, 420.0, 330.0 })
            stack.Children.Add(new Border { Width = width, MaxWidth = 440, Height = 11, HorizontalAlignment = System.Windows.HorizontalAlignment.Left,
                Background = Brush("#343A40"), CornerRadius = new CornerRadius(6), Margin = new Thickness(0, 5, 0, 5) });
        return stack;
    }

    private async void ChatScroll_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (e.Delta <= 0 || ChatScroll.VerticalOffset > 1 || loadingOlder || !hasOlder ||
            string.IsNullOrEmpty(oldestMessage)) return;
        loadingOlder = true;
        var before = oldestMessage;
        var oldHeight = ChatScroll.ExtentHeight;
        var skeleton = Skeleton();
        MessageList.Children.Insert(0, skeleton);
        try
        {
            var response = await bridge.RequestAsync(new { op = "messages", before }, stopping.Token);
            var rows = response.GetProperty("messages").EnumerateArray().ToList();
            AddMessages(response, false);
            hasOlder = rows.Count > 0 && oldestMessage != before;
            if (MessageList.Children.Contains(skeleton)) MessageList.Children.Remove(skeleton);
            ChatScroll.UpdateLayout();
            ChatScroll.ScrollToVerticalOffset(Math.Max(0, ChatScroll.ExtentHeight - oldHeight));
        }
        catch (Exception)
        {
            if (MessageList.Children.Contains(skeleton)) MessageList.Children.Remove(skeleton);
        }
        finally { loadingOlder = false; }
    }

    private async void Composer_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers is ModifierKeys.None or ModifierKeys.Control)
        { e.Handled = true; await SendAsync(); }
    }
    private void Composer_TextChanged(object sender, TextChangedEventArgs e)
    {
        pendingId = null;
        if (!sending && ComposerStatus != null) SetComposerStatus("");
    }

    private void SetComposerStatus(string value)
    {
        ComposerStatus.Text = value;
        ComposerStatus.Visibility = string.IsNullOrEmpty(value) ? Visibility.Collapsed : Visibility.Visible;
    }

    private async Task SendAsync()
    {
        if (sending) return;
        var text = Composer.Text.Trim();
        if (text.Length == 0) return;
        pendingId ??= Guid.NewGuid().ToString("D");
        sending = true;
        Composer.IsEnabled = false;
        SetComposerStatus("Sending to Misty…");
        try
        {
            var response = await bridge.RequestAsync(new { op = "send", clientId = pendingId,
                text, replyTo = replyTargetId }, stopping.Token);
            if (!Flag(response, "accepted")) throw new IOException("Misty did not accept the message.");
            Composer.Text = "";
            pendingId = null;
            ClearReply();
            SetComposerStatus("");
            var messages = await bridge.RequestAsync(new { op = "messages", after = chatCursor }, stopping.Token);
            AddMessages(messages, true);
            SaveState();
        }
        catch (Exception)
        {
            SetComposerStatus("Delivery is unconfirmed. Check the conversation before retrying; your draft is preserved.");
        }
        finally { sending = false; Composer.IsEnabled = true; Composer.Focus(); }
    }

    private void ShowPanel(string panel, bool toggle = false)
    {
        if (toggle && selected == panel && DetailRoot.Visibility == Visibility.Visible)
        {
            CollapsePanel();
            return;
        }
        var right = Left + Width;
        var work = SystemParameters.WorkArea;
        selected = panel;
        Width = Math.Min(panel == "gmail" ? GmailWidth : panel == "approvals" ? ApprovalWidth : ExpandedWidth, work.Width - 24);
        Height = Math.Min(ExpandedHeight, work.Height - 30);
        PanelColumn.Width = new GridLength(Width - CompactWidth);
        DetailRoot.Visibility = Visibility.Visible;
        Left = Math.Max(work.Left + 8, right - Width);
        ChatPanel.Visibility = panel == "chat" ? Visibility.Visible : Visibility.Collapsed;
        CodexPanel.Visibility = panel == "codex" ? Visibility.Visible : Visibility.Collapsed;
        ActivityPanel.Visibility = panel == "activity" ? Visibility.Visible : Visibility.Collapsed;
        VmPanel.Visibility = panel == "vm" ? Visibility.Visible : Visibility.Collapsed;
        GmailPanel.Visibility = panel == "gmail" ? Visibility.Visible : Visibility.Collapsed;
        ApprovalPanel.Visibility = panel == "approvals" ? Visibility.Visible : Visibility.Collapsed;
        MarkRail(panel);
        ClearUnread(panel);
        if (panel == "codex") _ = RefreshCodexChats();
        if (panel == "chat") _ = RefreshWorkingAsync();
        if (panel == "activity") _ = RefreshActivityReport();
        if (panel == "vm") ShowVmTrace(false);
        if (panel == "gmail") _ = RefreshGmail(true);
        if (panel == "approvals") _ = RefreshApprovals(false);
    }

    private void CollapsePanel()
    {
        var right = Left + Width;
        selected = "";
        ChatPanel.Visibility = Visibility.Collapsed;
        CodexPanel.Visibility = Visibility.Collapsed;
        ActivityPanel.Visibility = Visibility.Collapsed;
        VmPanel.Visibility = Visibility.Collapsed;
        GmailPanel.Visibility = Visibility.Collapsed;
        ApprovalPanel.Visibility = Visibility.Collapsed;
        DetailRoot.Visibility = Visibility.Collapsed;
        PanelColumn.Width = new GridLength(0);
        Width = CompactWidth;
        Height = Math.Min(CompactHeight, SystemParameters.WorkArea.Height - 30);
        Left = right - Width;
        MarkRail("");
    }

    private void MarkRail(string panel)
    {
        foreach (var (button, name) in new[] { (TalkButton, "chat"), (CodexButton, "codex"),
                     (ActivityButton, "activity"), (VmButton, "vm"), (GmailButton, "gmail"), (ApprovalButton, "approvals") })
            button.Tag = panel == name ? "active" : null;
    }

    private void Talk_Click(object sender, RoutedEventArgs e) => ShowPanel("chat", true);
    private void Codex_Click(object sender, RoutedEventArgs e) => ShowPanel("codex", true);
    private void Activity_Click(object sender, RoutedEventArgs e) => ShowPanel("activity", true);
    private void Vm_Click(object sender, RoutedEventArgs e) => ShowPanel("vm", true);
    private void Gmail_Click(object sender, RoutedEventArgs e) => ShowPanel("gmail", true);
    private void Approval_Click(object sender, RoutedEventArgs e) => ShowPanel("approvals", true);
    private void Collapse_Click(object sender, RoutedEventArgs e) => CollapsePanel();
    private void Archive_Click(object sender, RoutedEventArgs e) => OpenUrl(ArchiveUrl);
    private static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception) { System.Windows.MessageBox.Show("Windows could not open the link.", "Misty", MessageBoxButton.OK, MessageBoxImage.Information); }
    }

    private void Title_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2) CollapsePanel();
        else DragMove();
    }
    private void Hide_Click(object sender, RoutedEventArgs e) => Hide();
    private void ShowFromTray()
    { Show(); Activate(); }
    private void Window_Activated(object sender, EventArgs e)
    {
        if (DetailRoot.Visibility == Visibility.Visible) ClearUnread(selected);
    }
    private void Exit()
    { exitRequested = true; Close(); }
    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (!exitRequested) { e.Cancel = true; Hide(); return; }
        stopping.Cancel();
        CloseLocalVoice();
        desktopPresenceTimer?.Stop();
        if (hotkeyRegistered && windowSource != null) UnregisterHotKey(windowSource.Handle, HotkeyId);
        windowSource?.RemoveHook(HotkeyHook);
        SaveState();
        tray.Visible = false;
        tray.Dispose();
        trayIcon.Dispose();
        pingSound?.Dispose();
        pingStream?.Dispose();
        bridge.Dispose();
    }
}
