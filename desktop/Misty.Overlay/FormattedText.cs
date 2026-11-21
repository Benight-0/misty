using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using WpfBlock = System.Windows.Documents.Block;
using WpfInline = System.Windows.Documents.Inline;
using RichTextBox = System.Windows.Controls.RichTextBox;
using FontFamily = System.Windows.Media.FontFamily;
using Brushes = System.Windows.Media.Brushes;
using Color = System.Windows.Media.Color;

namespace Misty.Overlay;

// Parse text into native document elements, never HTML/XAML or remote resources.
internal static class FormattedText
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UseAutoLinks().UseEmphasisExtras().DisableHtml().Build();

    internal static bool SafeLink(string? value, out Uri uri)
    {
        uri = null!;
        return Uri.TryCreate(value, UriKind.Absolute, out uri!) &&
            (uri.Scheme == "https" || uri.Scheme == "http" || uri.Scheme == "mailto");
    }

    internal static RichTextBox View(string text, FontFamily font, double size, double lineHeight,
        System.Windows.Media.Brush foreground, Action<string> open)
    {
        return new RichTextBox
        {
            Document = Document(text, font, size, lineHeight, foreground, open),
            IsReadOnly = true, IsDocumentEnabled = true, BorderThickness = new Thickness(0),
            Background = Brushes.Transparent, Padding = new Thickness(0),
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled
        };
    }

    internal static FlowDocument Document(string text, FontFamily font, double size, double lineHeight,
        System.Windows.Media.Brush foreground, Action<string> open)
    {
        var document = new FlowDocument
        {
            FontFamily = font, FontSize = size, Foreground = foreground,
            PagePadding = new Thickness(0), ColumnWidth = double.PositiveInfinity
        };
        foreach (var block in Markdown.Parse(text ?? "", Pipeline))
            document.Blocks.Add(RenderBlock(block, lineHeight, open));
        return document;
    }

    private static WpfBlock RenderBlock(Markdig.Syntax.Block block, double lineHeight, Action<string> open)
    {
        if (block is CodeBlock code)
            return new Paragraph(new Run(code.Lines.ToString()))
            {
                FontFamily = new FontFamily("Consolas"), FontSize = 13,
                Background = new SolidColorBrush(Color.FromRgb(32, 35, 38)),
                Padding = new Thickness(8), Margin = new Thickness(0, 5, 0, 8)
            };
        if (block is ListBlock list)
        {
            var result = new System.Windows.Documents.List
            {
                MarkerStyle = list.IsOrdered ? TextMarkerStyle.Decimal : TextMarkerStyle.Disc,
                StartIndex = list.IsOrdered && int.TryParse(list.OrderedStart, out var start) ? Math.Max(1, start) : 1,
                Padding = new Thickness(22, 0, 0, 0), Margin = new Thickness(0, 3, 0, 7)
            };
            foreach (var item in list.OfType<ListItemBlock>())
            {
                var entry = new ListItem { Margin = new Thickness(0, 0, 0, 3) };
                foreach (var child in item) entry.Blocks.Add(RenderBlock(child, lineHeight, open));
                result.ListItems.Add(entry);
            }
            return result;
        }
        if (block is QuoteBlock quote)
        {
            var section = new Section { Margin = new Thickness(10, 3, 0, 8),
                BorderThickness = new Thickness(2, 0, 0, 0), BorderBrush = Brushes.SlateGray,
                Padding = new Thickness(9, 0, 0, 0) };
            foreach (var child in quote) section.Blocks.Add(RenderBlock(child, lineHeight, open));
            return section;
        }
        if (block is ThematicBreakBlock)
            return new Paragraph(new Run("────────")) { Foreground = Brushes.SlateGray, Margin = new Thickness(0, 5, 0, 8) };
        if (block is LeafBlock leaf)
        {
            var paragraph = new Paragraph { Margin = new Thickness(0, 0, 0, 7), LineHeight = lineHeight };
            if (block is HeadingBlock heading)
            {
                paragraph.FontSize = heading.Level <= 2 ? 19 : 16;
                paragraph.FontWeight = FontWeights.SemiBold;
                paragraph.Margin = new Thickness(0, 7, 0, 6);
            }
            if (leaf.Inline != null) RenderInline(leaf.Inline, paragraph.Inlines, open);
            else paragraph.Inlines.Add(new Run(leaf.Lines.ToString()));
            return paragraph;
        }
        if (block is ContainerBlock container)
        {
            var section = new Section();
            foreach (var child in container) section.Blocks.Add(RenderBlock(child, lineHeight, open));
            return section;
        }
        return new Paragraph();
    }

    private static void RenderInline(ContainerInline container, InlineCollection target, Action<string> open)
    {
        foreach (var inline in container)
        {
            switch (inline)
            {
                case LiteralInline literal: target.Add(new Run(literal.Content.ToString())); break;
                case CodeInline code:
                    target.Add(new Run(code.Content) { FontFamily = new FontFamily("Consolas"),
                        Background = new SolidColorBrush(Color.FromRgb(52, 58, 64)) }); break;
                case LineBreakInline: target.Add(new LineBreak()); break;
                case AutolinkInline auto:
                    AddLink(target, auto.Url, auto.IsEmail ? "mailto:" + auto.Url : auto.Url, null, open); break;
                case LinkInline link:
                    if (link.IsImage)
                    {
                        target.Add(new Run("[image: ")); RenderInline(link, target, open); target.Add(new Run("]"));
                    }
                    else AddLink(target, "", link.Url, link, open);
                    break;
                case EmphasisInline emphasis:
                    var span = new Span();
                    if (emphasis.DelimiterChar == '~') span.TextDecorations = TextDecorations.Strikethrough;
                    else if (emphasis.DelimiterCount >= 2) span.FontWeight = FontWeights.SemiBold;
                    else span.FontStyle = FontStyles.Italic;
                    RenderInline(emphasis, span.Inlines, open); target.Add(span); break;
                case ContainerInline nested: RenderInline(nested, target, open); break;
                default: target.Add(new Run(inline.ToString() ?? "")); break;
            }
        }
    }

    private static void AddLink(InlineCollection target, string label, string? url, ContainerInline? content, Action<string> open)
    {
        if (!SafeLink(url, out var uri))
        {
            if (content != null) RenderInline(content, target, open); else target.Add(new Run(label));
            return;
        }
        var link = new Hyperlink { NavigateUri = uri, ToolTip = uri.AbsoluteUri,
            Foreground = new SolidColorBrush(Color.FromRgb(120, 169, 247)) };
        if (content != null) RenderInline(content, link.Inlines, open); else link.Inlines.Add(new Run(label));
        link.RequestNavigate += (_, args) => { args.Handled = true; open(uri.AbsoluteUri); };
        target.Add(link);
    }
}