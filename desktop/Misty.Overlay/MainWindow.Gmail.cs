using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.Win32;
using System.Text.RegularExpressions;
using Button = System.Windows.Controls.Button;
using TextBox = System.Windows.Controls.TextBox;
using KeyEventArgs = System.Windows.Input.KeyEventArgs;
using Cursors = System.Windows.Input.Cursors;
using FontFamily = System.Windows.Media.FontFamily;
using SaveFileDialog = Microsoft.Win32.SaveFileDialog;

namespace Misty.Overlay;

public partial class MainWindow
{
    private string gmailAccount = "", gmailFolder = "primary", gmailCategory = "", gmailOpenId = "";
    private long? gmailBeforeTs;
    private string gmailBeforeId = "";
    private bool gmailLoading, gmailCanManage, gmailActionBusy;
    private WrapPanel? gmailActionBar;
    private Button? gmailPendingSends;
    private int pendingSendsCount;
    private readonly List<(string Id, string Email)> gmailAccounts = new();
    private readonly HashSet<string> knownApprovals = new();
    private string approvalCode = "";
    private JsonElement? currentApproval;
    private readonly Dictionary<string, TextBox> approvalEdits = new();

    private static TextBlock Label(string text, int size = 13, string color = "#DEE2E6", bool bold = false) =>
        new() { Text = text, FontSize = size, Foreground = Brush(color), FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 5) };
    private static TextBlock ListLine(string text, int size, string color, bool bold = false) => new()
    {
        Text = text, FontSize = size, Foreground = Brush(color), FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
        TextWrapping = TextWrapping.NoWrap, TextTrimming = TextTrimming.CharacterEllipsis,
        Margin = new Thickness(0, 0, 0, 4)
    };
    private Button ActionButton(string text, Action action)
    {
        var button = new Button { Content = text, Style = (Style)FindResource("UtilityButton"), Background = Brush("#343A40"), Foreground = Brush("#F8F9FA"),
            BorderThickness = new Thickness(0), Padding = new Thickness(10, 6, 10, 6), Margin = new Thickness(0, 0, 7, 7),
            Cursor = Cursors.Hand, MinHeight = 31, FontFamily = new FontFamily("Whitney Book, Segoe UI") };
        button.Click += (_, _) => action();
        return button;
    }
    private static TextBox Input(string text = "", bool multiline = false) => new()
    {
        Text = text, Background = Brush("#343A40"), Foreground = Brush("#F8F9FA"), BorderThickness = new Thickness(0),
        Padding = new Thickness(9, 7, 9, 7), Margin = new Thickness(0, 0, 0, 10), TextWrapping = TextWrapping.Wrap,
        AcceptsReturn = multiline, MinHeight = multiline ? 110 : 32, MaxHeight = multiline ? 300 : double.PositiveInfinity,
        VerticalScrollBarVisibility = multiline ? ScrollBarVisibility.Auto : ScrollBarVisibility.Disabled
    };
    private static WrapPanel Actions(params Button[] buttons)
    {
        var panel = new WrapPanel { Margin = new Thickness(0, 4, 0, 12) };
        foreach (var button in buttons) panel.Children.Add(button);
        return panel;
    }
    private void InitializeMailAndApprovals()
    {
        GmailDetail.Children.Add(Label("Choose an email to read.", 14, "#ADB5BD"));
        ApprovalDetail.Children.Add(Label("Pending sends appear here for your review.", 14, "#ADB5BD"));
    }
    private async Task<bool> RefreshGmail(bool reloadAccounts)
    {
        try
        {
            if (reloadAccounts || string.IsNullOrEmpty(gmailAccount))
            {
                var response = await bridge.RequestAsync(new { op = "gmail_accounts" }, stopping.Token);
                var accounts = response.GetProperty("accounts").EnumerateArray().Where(a => Flag(a, "enabled") && Flag(a, "linked")).ToArray();
                gmailAccounts.Clear();
                foreach (var account in accounts)
                    gmailAccounts.Add((Value(account, "id"), Value(account, "email")));
                if (!accounts.Any(a => Value(a, "id") == gmailAccount)) gmailAccount = accounts.Length > 0 ? Value(accounts[0], "id") : "";
                GmailAccounts.Content = gmailAccounts.FirstOrDefault(a => a.Id == gmailAccount).Email ?? "No account";
            }
            if (string.IsNullOrEmpty(gmailAccount))
            {
                GmailStatus.Text = "No connected Gmail mailbox.";
                GmailFolders.Children.Clear();
                RenderGmailPendingSends();
                GmailMessages.Children.Clear(); return true;
            }
            var navigation = await bridge.RequestAsync(new { op = "gmail_navigation", account = gmailAccount }, stopping.Token);
            gmailCanManage = Flag(navigation.GetProperty("account"), "canManage");
            RenderGmailFolders(navigation);
            if (!await LoadGmailList(true)) return false;
            if (!string.IsNullOrEmpty(gmailOpenId) && !await OpenGmail(gmailOpenId, false)) return false;
            GmailStatus.Text = GmailViewStatus();
            return true;
        }
        catch (Exception error) when (error is not OperationCanceledException) { GmailStatus.Text = error.Message; return false; }
    }
    private void RenderLegacyGmailFolders(JsonElement navigation)
    {
        GmailFolders.Children.Clear();
        GmailFolders.Children.Add(Label("FOLDERS", 11, "#ADB5BD", true));
        foreach (var row in navigation.GetProperty("folders").EnumerateArray())
        {
            var id = Value(row, "id");
            var button = ActionButton($"{Value(row, "name")}  {Number(row, "count")}", () => SelectGmailFolder(id, ""));
            button.HorizontalContentAlignment = System.Windows.HorizontalAlignment.Left;
            button.Background = Brush(gmailCategory == "" && gmailFolder == id ? "#495057" : "#202326");
            GmailFolders.Children.Add(button);
        }
        RenderGmailPendingSends();
        GmailFolders.Children.Add(Label("CATEGORIES", 11, "#ADB5BD", true));
        foreach (var row in navigation.GetProperty("categories").EnumerateArray())
        {
            var id = Value(row, "id"); var name = Value(row, "name");
            var button = ActionButton($"{name}  {Number(row, "count")}", () => SelectGmailFolder("inbox", id));
            button.HorizontalContentAlignment = System.Windows.HorizontalAlignment.Left;
            button.Background = Brush(gmailCategory == id ? "#495057" : "#202326");
            var line = new Grid();
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(29) });
            button.Content = ListLine($"{name} {Number(row, "count")}", 12, "#F8F9FA");
            button.Margin = new Thickness(0, 0, 2, 6);
            var edit = ActionButton("✎", () => ShowCategoryEditor(row.Clone()));
            edit.Style = (Style)FindResource("QuietButton");
            edit.Background = Brush("#202326");
            edit.ToolTip = "Edit " + name; edit.Padding = new Thickness(0); edit.Margin = new Thickness(0, 0, 0, 6);
            Grid.SetColumn(edit, 1); line.Children.Add(button); line.Children.Add(edit);
            GmailFolders.Children.Add(line);
        }
        GmailFolders.Children.Add(ActionButton("+ Category", () => ShowCategoryEditor(null)));
    }
    private void RenderGmailPendingSends()
    {
        GmailFolders.Children.Add(Label("SEND REVIEW", 11, "#ADB5BD", true));
        gmailPendingSends = ActionButton($"Pending sends  {pendingSendsCount}", () => ShowPanel("approvals"));
        gmailPendingSends.HorizontalContentAlignment = System.Windows.HorizontalAlignment.Left;
        gmailPendingSends.Background = Brush(pendingSendsCount > 0 ? "#343A40" : "#202326");
        GmailFolders.Children.Add(gmailPendingSends);
    }
    private void SelectGmailFolder(string folder, string category)
    {
        gmailViewRevision++; gmailGroupRequest++; gmailGroup = ""; gmailFilters.Clear();
        gmailFolder = folder; gmailCategory = category; gmailOpenId = "";
        GmailDetail.Children.Clear(); GmailDetail.Children.Add(Label("Choose an email to read.", 14, "#ADB5BD"));
        _ = RefreshGmail(false);
    }
    private async Task<bool> LoadGmailList(bool reset)
    {
        if (gmailGroup != "") return await LoadGroupedGmail();
        if ((gmailLoading && !reset) || string.IsNullOrEmpty(gmailAccount)) return false;
        if (reset) gmailViewRevision++;
        var viewRevision = gmailViewRevision;
        gmailLoading = true;
        try
        {
            if (reset) { gmailBeforeTs = null; gmailBeforeId = ""; GmailMessages.Children.Clear(); }
            var page = await bridge.RequestAsync(new { op = "gmail_list", account = gmailAccount, folder = gmailFolder,
                category = gmailCategory, query = GmailSearch.Text.Trim(), beforeTs = gmailBeforeTs, beforeId = gmailBeforeId }, stopping.Token);
            if (viewRevision != gmailViewRevision || gmailGroup != "") return false;
            foreach (var row in page.GetProperty("messages").EnumerateArray())
            {
                var id = Value(row, "id");
                var stack = new StackPanel();
                stack.Children.Add(ListLine((Flag(row, "starred") ? "★  " : "") + Value(row, "from"), 13, "#F8F9FA", Flag(row, "unread")));
                stack.Children.Add(ListLine(Value(row, "subject"), 13, "#DEE2E6", Flag(row, "unread")));
                stack.Children.Add(ListLine(Regex.Replace(Value(row, "snippet"), @"\s+", " ").Trim(), 11, "#ADB5BD"));
                stack.Children.Add(ListLine(Time(Number(row, "at")) + (Number(row, "attachments") > 0 ? "  · attachment" : ""), 10, "#6C757D"));
                AddMailCategorySummary(stack, id);
                var button = ActionButton("", () => _ = OpenGmail(id, true));
                button.Content = stack; button.HorizontalContentAlignment = System.Windows.HorizontalAlignment.Stretch;
                button.Background = Brush(Flag(row, "unread") ? "#343A40" : "#282B2E");
                GmailMessages.Children.Add(button);
            }
            GmailOlder.Visibility = Flag(page, "older") ? Visibility.Visible : Visibility.Collapsed;
            if (page.TryGetProperty("before", out var before) && before.ValueKind == JsonValueKind.Object)
            { gmailBeforeTs = Number(before, "ts"); gmailBeforeId = Value(before, "id"); }
            if (GmailMessages.Children.Count == 0) GmailMessages.Children.Add(Label("No mail in this view.", 13, "#ADB5BD"));
            return true;
        }
        catch (Exception error) when (error is not OperationCanceledException) { GmailStatus.Text = error.Message; return false; }
        finally { gmailLoading = false; }
    }
    private async Task<bool> OpenGmail(string id, bool markRead)
    {
        try
        {
            gmailOpenId = id;
            var mail = await bridge.RequestAsync(new { op = "gmail_open", messageId = id }, stopping.Token);
            if (gmailOpenId != id) return false;
            RenderGmail(mail);
            if (markRead && gmailCanManage && mail.GetProperty("labels").EnumerateArray().Any(l => l.GetString() == "UNREAD"))
                await GmailAction(id, "read");
            return true;
        }
        catch (Exception error) when (error is not OperationCanceledException) { GmailStatus.Text = error.Message; return false; }
    }
    private void RenderGmail(JsonElement mail)
    {
        GmailDetail.Children.Clear();
        var id = Value(mail, "id");
        GmailDetail.Children.Add(Label(Value(mail, "subject"), 20, "#F8F9FA", true));
        GmailDetail.Children.Add(Label("From  " + Value(mail, "from"), 12));
        GmailDetail.Children.Add(Label("To  " + Value(mail, "to"), 12));
        if (!string.IsNullOrWhiteSpace(Value(mail, "cc"))) GmailDetail.Children.Add(Label("Cc  " + Value(mail, "cc"), 12));
        GmailDetail.Children.Add(Label(Time(Number(mail, "at")), 11, "#ADB5BD"));
        RenderMailCategoryDetails(GmailDetail, id);
        var labels = mail.GetProperty("labels").EnumerateArray().Select(v => v.GetString()).ToHashSet();
        var controls = Actions(ActionButton("Reply", () => ShowCompose(mail.GetProperty("reply"))),
            ActionButton("Reply all", () => ShowCompose(mail.GetProperty("replyAll"))),
            ActionButton("Forward", () => ShowCompose(null, mail)));
        if (gmailCanManage)
        {
            controls.Children.Add(ActionButton(labels.Contains("STARRED") ? "Unstar" : "Star", () => _ = GmailAction(id, labels.Contains("STARRED") ? "unstar" : "star")));
            controls.Children.Add(ActionButton(labels.Contains("UNREAD") ? "Mark read" : "Mark unread", () => _ = GmailAction(id, labels.Contains("UNREAD") ? "read" : "unread")));
            controls.Children.Add(ActionButton(labels.Contains("INBOX") ? "Archive" : "Move to inbox", () => _ = GmailAction(id, labels.Contains("INBOX") ? "archive" : "inbox")));
            controls.Children.Add(ActionButton(labels.Contains("SPAM") ? "Not spam" : "Spam", () => _ = GmailAction(id, labels.Contains("SPAM") ? "notSpam" : "spam")));
            controls.Children.Add(ActionButton(labels.Contains("TRASH") ? "Restore" : "Trash", () => _ = GmailAction(id, labels.Contains("TRASH") ? "untrash" : "trash")));
        }
        gmailActionBar = controls;
        controls.IsEnabled = !gmailActionBusy;
        GmailDetail.Children.Add(controls);
        GmailDetail.Children.Add(FormattedText.View(Value(mail, "body"), SelectedChatFont().Family,
            14, 20, Brush("#DEE2E6"), OpenUrl));
        if (mail.GetProperty("attachments").GetArrayLength() > 0) GmailDetail.Children.Add(Label("ATTACHMENTS", 11, "#ADB5BD", true));
        foreach (var attachment in mail.GetProperty("attachments").EnumerateArray())
        {
            var key = Value(attachment, "key"); var name = Value(attachment, "name");
            var button = ActionButton($"↓  {name} · {Number(attachment, "size")} bytes", () => _ = SaveAttachment(id, key, name));
            button.IsEnabled = Flag(attachment, "stored"); GmailDetail.Children.Add(button);
        }
    }
    private async Task GmailAction(string id, string action)
    {
        if (gmailActionBusy) return;
        gmailActionBusy = true;
        if (gmailActionBar != null) gmailActionBar.IsEnabled = false;
        var description = action switch
        {
            "star" => "Star", "unstar" => "Unstar", "read" => "Mark read", "unread" => "Mark unread",
            "archive" => "Archive", "inbox" => "Move to inbox", "spam" => "Mark spam",
            "notSpam" => "Mark not spam", "trash" => "Move to trash", "untrash" => "Restore",
            _ => "Gmail change"
        };
        GmailStatus.Text = $"Applying {description}…";
        try
        {
            await bridge.RequestAsync(new { op = "gmail_action", messageId = id, action }, stopping.Token);
            GmailStatus.Text = $"{description} confirmed by Gmail. Refreshing the inbox…";
            var refreshed = await RefreshGmail(false);
            if (!refreshed)
                GmailStatus.Text = $"{description} applied in Gmail; inbox refresh failed ({GmailStatus.Text}). Use Refresh.";
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            GmailStatus.Text = $"{description} was not confirmed ({error.Message}). Refresh before trying again.";
        }
        finally
        {
            gmailActionBusy = false;
            if (gmailActionBar != null) gmailActionBar.IsEnabled = true;
        }
    }
    private async Task SaveAttachment(string id, string key, string filename)
    {
        var dialog = new SaveFileDialog { FileName = Path.GetFileName(filename), Title = "Save Gmail attachment" };
        if (dialog.ShowDialog(this) != true) return;
        var target = dialog.FileName; var temp = target + ".misty-partial";
        try
        {
            await using var output = new System.IO.FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None);
            int offset = 0;
            while (true)
            {
                var chunk = await bridge.RequestAsync(new { op = "gmail_attachment_chunk", messageId = id, key, offset }, stopping.Token);
                if (Number(chunk, "offset") != offset) throw new IOException("Attachment offset changed.");
                var bytes = Convert.FromBase64String(Value(chunk, "data"));
                await output.WriteAsync(bytes, stopping.Token); offset += bytes.Length;
                if (chunk.GetProperty("next").ValueKind == JsonValueKind.Null)
                {
                    if (offset != Number(chunk, "size")) throw new IOException("Attachment size changed.");
                    break;
                }
                if (Number(chunk, "next") != offset || bytes.Length == 0) throw new IOException("Attachment download stopped.");
                GmailStatus.Text = $"Saving {filename} · {offset:N0} bytes";
            }
            await output.FlushAsync(stopping.Token); output.Close(); File.Move(temp, target, true);
            GmailStatus.Text = "Saved " + filename;
        }
        catch (Exception error) { try { File.Delete(temp); } catch { } GmailStatus.Text = error.Message; }
    }
    private void ShowCompose(JsonElement? defaults = null, JsonElement? forward = null)
    {
        GmailDetail.Children.Clear();
        GmailDetail.Children.Add(Label(forward.HasValue ? "Forward" : defaults.HasValue ? "Reply" : "New email", 20, "#F8F9FA", true));
        var to = Input(defaults.HasValue && defaults.Value.ValueKind == JsonValueKind.Object ? Value(defaults.Value, "to") : "");
        var cc = Input(defaults.HasValue && defaults.Value.ValueKind == JsonValueKind.Object ? Value(defaults.Value, "cc") : "");
        var bcc = Input(defaults.HasValue && defaults.Value.ValueKind == JsonValueKind.Object ? Value(defaults.Value, "bcc") : "");
        var subject = Input(forward.HasValue ? "Fwd: " + Value(forward.Value, "subject") : defaults.HasValue && defaults.Value.ValueKind == JsonValueKind.Object ? Value(defaults.Value, "subject") : "");
        var body = Input(forward.HasValue ? "\n\n---------- Forwarded message ----------\n" + Value(forward.Value, "body") : "", true);
        foreach (var (caption, field) in new[] { ("To", to), ("Cc", cc), ("Bcc", bcc), ("Subject", subject), ("Message", body) })
        { GmailDetail.Children.Add(Label(caption, 11, "#ADB5BD", true)); GmailDetail.Children.Add(field); }
        var replyTo = defaults.HasValue && defaults.Value.ValueKind == JsonValueKind.Object ? Value(defaults.Value, "replyTo") : "";
        GmailDetail.Children.Add(Actions(ActionButton("Review send", () => _ = PreviewCompose(to.Text, cc.Text, bcc.Text, subject.Text, body.Text, replyTo)),
            ActionButton("Cancel", () => { GmailDetail.Children.Clear(); GmailDetail.Children.Add(Label("Choose an email to read.")); })));
    }
    private async Task PreviewCompose(string to, string cc, string bcc, string subject, string body, string replyTo)
    {
        try
        {
            var preview = await bridge.RequestAsync(new { op = "email_preview", account = gmailAccount, to, cc, bcc, subject, body, replyTo }, stopping.Token);
            approvalCode = Value(preview, "code");
            await RefreshApprovals(false); ShowPanel("approvals");
        }
        catch (Exception error) when (error is not OperationCanceledException) { GmailStatus.Text = error.Message; }
    }
    private void ShowCategoryEditor(JsonElement? category)
    {
        GmailDetail.Children.Clear();
        GmailDetail.Children.Add(Label(category.HasValue ? "Edit category" : "New category", 20, "#F8F9FA", true));
        var id = category.HasValue ? Value(category.Value, "id") : "";
        var rules = category.HasValue ? category.Value.GetProperty("rules") : default;
        var fields = new Dictionary<string, TextBox>();
        var name = Input(category.HasValue ? Value(category.Value, "name") : "");
        GmailDetail.Children.Add(Label("Name")); GmailDetail.Children.Add(name);
        foreach (var key in new[] { "from", "subject", "body", "labels" })
        {
            var text = category.HasValue ? string.Join(", ", rules.GetProperty(key).EnumerateArray().Select(x => x.GetString())) : "";
            fields[key] = Input(text); GmailDetail.Children.Add(Label(key == "from" ? "Sender contains" : key == "labels" ? "Gmail labels" : key + " contains")); GmailDetail.Children.Add(fields[key]);
        }
        GmailDetail.Children.Add(Label("Terms are separated by commas. A message matches when any term matches.", 11, "#ADB5BD"));
        GmailDetail.Children.Add(Actions(ActionButton("Save category", () => _ = SaveCategory(id, name.Text, fields)),
            ActionButton("Cancel", () => _ = RefreshGmail(false))));
        if (id.StartsWith("custom:", StringComparison.Ordinal))
            GmailDetail.Children.Add(ActionButton("Delete category", () => _ = DeleteCategory(id)));
    }
    private async Task SaveCategory(string id, string name, Dictionary<string, TextBox> fields)
    {
        try
        {
            await bridge.RequestAsync(new { op = "gmail_category_save", categoryId = id, name, rules = fields.ToDictionary(x => x.Key, x => x.Value.Text) }, stopping.Token);
            GmailDetail.Children.Clear(); GmailDetail.Children.Add(Label("Category saved.")); await RefreshGmail(false);
        }
        catch (Exception error) { GmailStatus.Text = error.Message; }
    }
    private async Task DeleteCategory(string id)
    {
        try { await bridge.RequestAsync(new { op = "gmail_category_delete", categoryId = id }, stopping.Token);
            gmailCategory = ""; GmailDetail.Children.Clear(); await RefreshGmail(false); }
        catch (Exception error) { GmailStatus.Text = error.Message; }
    }
    private void GmailSearch_KeyDown(object sender, KeyEventArgs e) { if (e.Key == Key.Enter) { e.Handled = true; _ = LoadGmailList(true); } }
    private void GmailSearch_TextChanged(object sender, TextChangedEventArgs e)
    { if (GmailSearchHint != null) GmailSearchHint.Visibility = string.IsNullOrEmpty(GmailSearch.Text) ? Visibility.Visible : Visibility.Collapsed; }
    private void GmailAccounts_Click(object sender, RoutedEventArgs e)
    {
        var menu = new ContextMenu { Background = Brush("#202326"), Foreground = Brush("#F8F9FA") };
        foreach (var account in gmailAccounts)
        {
            var item = new MenuItem { Header = account.Email, Foreground = Brush("#F8F9FA"), Background = Brush("#202326") };
            item.Click += (_, _) => { gmailViewRevision++; gmailGroupRequest++; gmailGroup = ""; gmailFilters.Clear(); gmailAccount = account.Id; gmailOpenId = ""; GmailAccounts.Content = account.Email; _ = RefreshGmail(false); };
            menu.Items.Add(item);
        }
        menu.PlacementTarget = GmailAccounts; menu.IsOpen = true;
    }
    private void GmailCompose_Click(object sender, RoutedEventArgs e) => ShowCompose();
    private void GmailRefresh_Click(object sender, RoutedEventArgs e) => _ = RefreshGmail(true);
    private void GmailOlder_Click(object sender, RoutedEventArgs e) => _ = LoadGmailList(false);
}
