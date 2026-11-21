using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using Button = System.Windows.Controls.Button;
using CheckBox = System.Windows.Controls.CheckBox;

namespace Misty.Overlay;

public partial class MainWindow
{
    private string gmailGroup = "";
    private int gmailViewRevision, gmailGroupRequest;
    private JsonElement? gmailNavigation;
    private readonly Dictionary<string, HashSet<string>> gmailFilters = new();
    private readonly Dictionary<string, JsonElement> gmailExampleMail = new();
    private Task? gmailExampleLoading;
    private string gmailExampleError = "";

    private void RenderGmailFolders(JsonElement navigation)
    {
        gmailNavigation = navigation.Clone();
        RenderMailNavigation();
    }

    private void RenderMailNavigation()
    {
        if (gmailNavigation is not JsonElement navigation) return;
        GmailTopNavigation.Children.Clear();
        foreach (var (id, name) in new[] { ("primary", "Primary"), ("sent", "Sent"), ("inbox", "All inbox") })
        {
            var button = ActionButton(name, () => SelectGmailFolder(id, ""));
            button.Background = Brush(gmailGroup == "" && gmailCategory == "" && gmailFolder == id ? "#495057" : "#202326");
            AutomationProperties.SetName(button, name);
            GmailTopNavigation.Children.Add(button);
        }
        foreach (var group in MailGroupingCatalog.Groups)
        {
            var count = gmailFilters.TryGetValue(group.Id, out var selected) ? selected.Count : 0;
            var button = ActionButton(group.Name + (count > 0 ? $" ({count})" : "") + " ▾", () => SelectMailGrouping(group.Id));
            button.Background = Brush(gmailGroup == group.Id ? "#495057" : "#202326");
            AutomationProperties.SetName(button, group.Name + " grouping");
            GmailTopNavigation.Children.Add(button);
        }
        GmailFolders.Children.Clear();
        if (gmailGroup != "")
        {
            var group = MailGroupingCatalog.Groups.First(x => x.Id == gmailGroup);
            GmailFolders.Children.Add(Label(group.Name.ToUpperInvariant(), 11, "#ADB5BD", true));
            GmailFolders.Children.Add(Label("Example labels only", 11, "#ADB5BD"));
            GmailFolders.Children.Add(Label("Any selected category matches within a grouping. Different groupings combine.", 11, "#ADB5BD"));
            foreach (var category in group.Categories)
            {
                var count = gmailAccount == MailGroupingCatalog.ExampleAccount ? MailGroupingCatalog.Examples.Count(x =>
                    x.Labels.TryGetValue(group.Id, out var labels) && labels.Contains(category.Id) &&
                    MailGroupingCatalog.Matches(x, gmailFilters, group.Id)) : 0;
                var box = new CheckBox
                {
                    Content = new TextBlock { Text = $"{category.Name}  {count}", TextWrapping = TextWrapping.Wrap },
                    IsChecked = gmailFilters.TryGetValue(group.Id, out var selected) && selected.Contains(category.Id),
                    Foreground = Brush("#DEE2E6"), Margin = new Thickness(0, 4, 0, 8),
                    VerticalContentAlignment = VerticalAlignment.Center
                };
                AutomationProperties.SetName(box, group.Name + ": " + category.Name);
                RoutedEventHandler changed = (_, _) =>
                {
                    if (!gmailFilters.TryGetValue(group.Id, out var labels)) gmailFilters[group.Id] = labels = new();
                    if (box.IsChecked == true) labels.Add(category.Id); else labels.Remove(category.Id);
                    RenderMailNavigation();
                    _ = LoadGmailList(true);
                };
                box.Checked += changed;
                box.Unchecked += changed;
                GmailFolders.Children.Add(box);
            }
            GmailFolders.Children.Add(ActionButton("Clear all filters", () =>
            { gmailFilters.Clear(); RenderMailNavigation(); _ = LoadGmailList(true); }));
        }
        else GmailFolders.Children.Add(Label("Choose a grouping above to reveal its categories.", 12, "#ADB5BD"));
        var folderPanel = new StackPanel();
        foreach (var row in navigation.GetProperty("folders").EnumerateArray().Where(x =>
            !new[] { "primary", "sent", "inbox" }.Contains(Value(x, "id"))))
        {
            var id = Value(row, "id");
            var button = ActionButton($"{Value(row, "name")}  {Number(row, "count")}", () => SelectGmailFolder(id, ""));
            button.HorizontalContentAlignment = System.Windows.HorizontalAlignment.Left;
            button.Background = Brush(gmailGroup == "" && gmailCategory == "" && gmailFolder == id ? "#495057" : "#202326");
            folderPanel.Children.Add(button);
        }
        GmailFolders.Children.Add(new Expander { Header = "More folders", Content = folderPanel,
            Foreground = Brush("#DEE2E6"), Margin = new Thickness(0, 14, 0, 8), IsExpanded = gmailGroup == "" });
        var saved = new StackPanel();
        foreach (var row in navigation.GetProperty("categories").EnumerateArray())
        {
            var category = row.Clone(); var id = Value(row, "id");
            saved.Children.Add(ActionButton(Value(row, "name"), () => SelectGmailFolder("all", id)));
            saved.Children.Add(ActionButton("Edit " + Value(row, "name"), () => ShowCategoryEditor(category)));
        }
        saved.Children.Add(ActionButton("+ Saved rule", () => ShowCategoryEditor(null)));
        GmailFolders.Children.Add(new Expander { Header = "Saved rule filters", Content = saved,
            Foreground = Brush("#ADB5BD"), Margin = new Thickness(0, 8, 0, 8) });
        RenderGmailPendingSends();
        RenderMailFilterSummary();
    }

    private void SelectMailGrouping(string group)
    {
        gmailViewRevision++;
        gmailGroup = group; gmailCategory = ""; gmailFolder = "all"; gmailOpenId = "";
        GmailDetail.Children.Clear(); GmailDetail.Children.Add(Label("Choose an example-labelled email to read.", 14, "#ADB5BD"));
        RenderMailNavigation(); _ = LoadGmailList(true);
    }

    private void RenderMailFilterSummary()
    {
        GmailFilterSummary.Text = gmailGroup == "" ?
            (gmailCategory == "" ? "" : "Saved rule filter · " + gmailCategory) :
            "Example labels · " + (gmailFilters.Any(x => x.Value.Count > 0) ? string.Join("  +  ",
                gmailFilters.Where(x => x.Value.Count > 0).Select(x => string.Join(" or ",
                    x.Value.Select(v => MailGroupingCatalog.CategoryName(x.Key, v))))) : "All 7 examples") +
            " · Remaining mail is not categorised";
        GmailFilterSummary.Visibility = GmailFilterSummary.Text == "" ? Visibility.Collapsed : Visibility.Visible;
    }

    private string GmailViewStatus() => gmailGroup == "" ?
        (gmailCanManage ? "Stored mail · synced with Gmail" : "Reading and composing available · Gmail management needs a new Google grant") :
        "Example labels in Misty only · Gmail labels unchanged" + (gmailExampleError == "" ? "" : " · " + gmailExampleError);

    private async Task LoadMailExamples()
    {
        gmailExampleError = "";
        foreach (var example in MailGroupingCatalog.Examples)
        {
            var id = MailGroupingCatalog.MessageId(MailGroupingCatalog.ExampleAccount, example);
            if (gmailExampleMail.ContainsKey(id)) continue;
            try
            {
                // Read-only fetch: never use OpenGmail(markRead:true) while preparing previews.
                var mail = await bridge.RequestAsync(new { op = "gmail_open", messageId = id }, stopping.Token);
                gmailExampleMail[id] = mail.Clone();
            }
            catch (Exception error) when (error is not OperationCanceledException)
            { gmailExampleError = "Some examples could not load; Refresh to retry"; }
        }
    }

    private async Task<bool> LoadGroupedGmail()
    {
        var request = ++gmailGroupRequest; var account = gmailAccount;
        GmailOlder.Visibility = Visibility.Collapsed;
        GmailMessages.Children.Clear(); GmailMessages.Children.Add(Label("Loading example-labelled emails…", 13, "#ADB5BD"));
        GmailStatus.Text = "Loading examples · no Gmail labels are being changed";
        if (account == MailGroupingCatalog.ExampleAccount)
        {
            if (gmailExampleLoading == null || gmailExampleLoading.IsCompleted) gmailExampleLoading = LoadMailExamples();
            await gmailExampleLoading;
        }
        if (request != gmailGroupRequest || gmailGroup == "" || account != gmailAccount) return false;
        GmailMessages.Children.Clear();
        var query = GmailSearch.Text.Trim();
        var matches = account == MailGroupingCatalog.ExampleAccount ? MailGroupingCatalog.Examples.Where(x =>
            MailGroupingCatalog.Matches(x, gmailFilters)).Select(x => MailGroupingCatalog.MessageId(account, x))
            .Where(gmailExampleMail.ContainsKey).Select(x => gmailExampleMail[x])
            .Where(x => query == "" || (Value(x, "from") + " " + Value(x, "subject") + " " + Value(x, "body"))
                .Contains(query, StringComparison.OrdinalIgnoreCase)).OrderByDescending(x => Number(x, "at")).ToArray() : [];
        foreach (var mail in matches)
        {
            var id = Value(mail, "id"); var stack = new StackPanel();
            stack.Children.Add(ListLine(Value(mail, "from"), 13, "#F8F9FA"));
            stack.Children.Add(ListLine(Value(mail, "subject"), 13, "#DEE2E6"));
            stack.Children.Add(ListLine(Regex.Replace(Value(mail, "body"), @"\s+", " ").Trim(), 11, "#ADB5BD"));
            AddMailCategorySummary(stack, id);
            stack.Children.Add(ListLine(Time(Number(mail, "at")), 10, "#6C757D"));
            var button = ActionButton("", () => _ = OpenGmail(id, false));
            button.Content = stack; button.HorizontalContentAlignment = System.Windows.HorizontalAlignment.Stretch;
            button.Background = Brush("#282B2E"); GmailMessages.Children.Add(button);
        }
        if (matches.Length == 0) GmailMessages.Children.Add(Label(account == MailGroupingCatalog.ExampleAccount ?
            "No example emails match. Clear filters or change your search." : "No example labels for this account yet.", 13, "#ADB5BD"));
        RenderMailFilterSummary();
        GmailStatus.Text = $"{matches.Length} example emails · " + GmailViewStatus();
        return true;
    }

    private static void AddMailCategorySummary(StackPanel panel, string id)
    {
        var example = MailGroupingCatalog.Find(id); if (example == null) return;
        var names = example.Labels["topic"].Select(x => MailGroupingCatalog.CategoryName("topic", x));
        panel.Children.Add(new TextBlock { Text = "Example · " + string.Join(" · ", names), FontSize = 10,
            Foreground = Brush("#ADB5BD"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 3, 0, 4) });
    }

    private static void RenderMailCategoryDetails(StackPanel panel, string id)
    {
        var example = MailGroupingCatalog.Find(id); if (example == null) return;
        panel.Children.Add(Label("EXAMPLE LABELS · MISTY ONLY", 10, "#ADB5BD", true));
        foreach (var group in MailGroupingCatalog.Groups)
            if (example.Labels.TryGetValue(group.Id, out var labels))
                panel.Children.Add(Label(group.Name + "  " + string.Join(" · ", labels.Select(x =>
                    MailGroupingCatalog.CategoryName(group.Id, x))), 11, "#ADB5BD"));
    }
}