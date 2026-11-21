using System.Windows.Documents;
using System.Windows.Media;
using Misty.Overlay;
using FormattedText = Misty.Overlay.FormattedText;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        void Check(bool value, string name) { if (!value) throw new Exception(name); Console.WriteLine("PASS " + name); }
        FlowDocument Render(string value) => FormattedText.Document(value, new FontFamily("Segoe UI"), 16, 22, Brushes.White, _ => throw new Exception("must not launch while rendering"));
        var doc = Render("# Heading\n\n- first\n- second\n  - nested\n\n3. third\n4. fourth\n\n**bold** and *italic* and `code`\n\n[site](https://example.com) https://example.org\n\n```text\n- literal\nhttps://example.com\n```\n\n> quote");
        var blocks = doc.Blocks.ToList();
        var lists = blocks.OfType<System.Windows.Documents.List>().ToArray();
        Check(lists.Length == 2 && lists[0].ListItems.Count == 2, "bullet and numbered lists");
        Check(lists[0].ListItems.LastListItem.Blocks.OfType<System.Windows.Documents.List>().Any(), "nested lists");
        Check(lists[1].StartIndex == 3, "numbered start preserved");
        var spans = blocks.OfType<Paragraph>().SelectMany(x => x.Inlines).OfType<Span>().ToArray();
        Check(spans.OfType<Hyperlink>().Count() == 2, "named and bare URL links");
        var code = blocks.OfType<Paragraph>().First(x => x.FontFamily.Source == "Consolas");
        Check(!code.Inlines.OfType<Hyperlink>().Any() && new TextRange(code.ContentStart, code.ContentEnd).Text.Contains("- literal"), "code remains literal");
        Check(!FormattedText.SafeLink("javascript:alert(1)", out _) && !FormattedText.SafeLink("file:///C:/Windows", out _) && !FormattedText.SafeLink("ms-settings:", out _), "unsafe schemes disabled");
        Check(FormattedText.SafeLink("mailto:test@example.com", out _), "mail links allowed");
        var unsafeDoc = Render("[unsafe](javascript:alert)\n\n<img src=\"https://example.com/track\">\n\n![picture](https://example.com/track)");
        Check(!unsafeDoc.Blocks.OfType<Paragraph>().SelectMany(x => x.Inlines).OfType<Hyperlink>().Any(), "HTML and images never load external content");
        Check(Render("").Blocks.Count == 0 && Render("plain text\nnext line").Blocks.Count == 1, "plain and empty messages");
        using var work = System.Text.Json.JsonDocument.Parse("""{"active":true,"items":[{"id":"a","label":"reading","since":1000,"ended":3000,"state":"done"},{"id":"b","label":"testing","since":3000,"ended":0,"state":"running"}]}""");
        Check(WorkingDisplay.Render(work.RootElement, 5000) == "reading · 2s · done\ntesting · 2s", "work commands stack with elapsed time");
        Check(WorkingDisplay.Render(work.RootElement, 7000).EndsWith("testing · 4s"), "elapsed advances two seconds and completed duration freezes");
        if (args.Contains("--check-pin"))
        {
            var process = System.Diagnostics.Process.GetProcessesByName("Misty.Overlay").Single();
            var handle = process.MainWindowHandle;
            Check(WindowsDesktop.VirtualDesktop.PinWindow(handle) && WindowsDesktop.VirtualDesktop.IsPinnedWindow(handle), "Misty window pinned across desktops without switching");
        }
    }
}