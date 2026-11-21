using Misty.Overlay;

void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
Dictionary<string, HashSet<string>> Filter(params string[] entries) => entries.Select(x => x.Split('=', 2))
    .ToDictionary(x => x[0], x => x[1].Split(',').ToHashSet());
var examples = MailGroupingCatalog.Examples;
Check(MailGroupingCatalog.Groups.Select(x => x.Id).Distinct().Count() == 6, "Six distinct groupings");
foreach (var example in examples)
    foreach (var pair in example.Labels)
        foreach (var label in pair.Value)
            Check(MailGroupingCatalog.Groups.First(x => x.Id == pair.Key).Categories.Any(x => x.Id == label), "Unknown example label");
Check(examples.All(x => MailGroupingCatalog.Matches(x, Filter())), "No selection must include all examples");
var aws = examples.First(x => x.RemoteId == "1a189f929b5aa038");
Check(MailGroupingCatalog.Matches(aws, Filter("topic=software")), "First same-group label");
Check(MailGroupingCatalog.Matches(aws, Filter("topic=money")), "Second same-group label");
Check(MailGroupingCatalog.Matches(aws, Filter("topic=college,software")), "OR within a grouping");
Check(!MailGroupingCatalog.Matches(aws, Filter("topic=college", "intent=proof")), "AND across groupings");
Check(MailGroupingCatalog.Matches(aws, Filter("topic=software", "intent=proof")), "Cross-group positive match");
Check(!MailGroupingCatalog.Matches(aws, Filter("topic=not-a-category")), "Unknown category cannot match all mail");
var selected = Filter("topic=software", "intent=request");
Check(MailGroupingCatalog.Matches(aws, selected, "intent"), "Facet counts ignore only their own grouping");
Check(selected["intent"].SetEquals(["request"]), "Matching must not mutate selected categories");
var id = MailGroupingCatalog.MessageId(MailGroupingCatalog.ExampleAccount, aws);
Check(MailGroupingCatalog.Find(id) == aws, "Exact example message lookup");
Check(MailGroupingCatalog.Find(id.Replace(MailGroupingCatalog.ExampleAccount, "other-account")) == null, "Never label another account");
Check(MailGroupingCatalog.Find("gmail:" + MailGroupingCatalog.ExampleAccount + ":unlabelled") == null, "Unclassified mail stays unlabelled");
Check(examples.Select(x => MailGroupingCatalog.MessageId(MailGroupingCatalog.ExampleAccount, x)).Distinct().Count() == 7, "Seven unique examples");
Console.WriteLine("Mail grouping checks passed: multiple labels, same-group OR, cross-group AND, facet counts, account isolation and unlabelled mail");