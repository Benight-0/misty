namespace Misty.Overlay;

internal sealed record MailCategory(string Id, string Name);
internal sealed record MailGrouping(string Id, string Name, MailCategory[] Categories);
internal sealed record MailExample(string RemoteId, Dictionary<string, string[]> Labels);

// UI examples only. No inference rules, Gmail writes, or mailbox-wide assignments.
internal static class MailGroupingCatalog
{
    internal const string ExampleAccount = "27126bef47f198dd10d55055";
    private static MailGrouping Group(string id, string name, string categories) => new(id, name,
        categories.Split('|').Select(x => x.Split(':', 2)).Select(x => new MailCategory(x[0], x[1])).ToArray());
    internal static readonly MailGrouping[] Groups =
    [
        Group("topic", "Topics", "college:College & financial aid|research:Research & collaboration|competitions:Competitions & training|programmes:Programmes & learning|community:Community administration|software:Software & infrastructure|personal:School & personal documents|money:Money & entitlements|accounts:Accounts & security|reading:Reading & discovery|social:Social & hobbies|promotions:Commercial promotions"),
        Group("intent", "Intent", "request:Request or decision|progress:Progress or outcome|coordination:Coordination & logistics|proof:Proof or transaction|maintenance:Operational maintenance|account:Account event or login|reference:Learning or reference|opportunity:Optional opportunity|promotion:Promotion or engagement|personal:Personal exchange or files|delivery:Draft or delivery problem"),
        Group("utility", "Utility", "action:Needs review or action|waiting:Waiting on someone|upcoming:Upcoming|evidence:Keep as evidence|reading:Reading queue|optional:Optional opportunities|quiet:Quiet bulk|security:Account access & security|drafts:Drafts & delivery problems"),
        Group("relationship", "Relationship", "person:Personal correspondent|institution:Active institution|programme:Enrolled programme|service:Service you use|prospect:Prospective institution|publication:Publication or mailing list|platform:Platform notification"),
        Group("status", "Status", "current:Current|unconfirmed:Completion unconfirmed|proposed:Proposed appointment|waiting:Waiting|record:Record or reference|historical:Historical|expired:Expired|draft:Unsent draft"),
        Group("context", "Context", "ntu:NTU|uoft:UofT & Pearson|aws:AWS|implicit:Implicit Physics|battlecode:Battlecode|iaifi:IAIFI|railway:Railway")
    ];
    private static MailExample Example(string id, params string[] labels) => new(id,
        labels.Select(x => x.Split('=', 2)).ToDictionary(x => x[0], x => x[1].Split(',')));
    internal static readonly MailExample[] Examples =
    [
        Example("1a17be77beed1911", "topic=college,money", "intent=proof,progress", "utility=evidence", "relationship=institution", "status=record", "context=ntu"),
        Example("1a189f929b5aa038", "topic=software,money", "intent=progress,proof", "utility=evidence", "relationship=service", "status=record", "context=aws"),
        Example("1a15149a24eb90d2", "topic=competitions", "intent=proof,opportunity", "utility=evidence,optional", "relationship=programme", "status=historical,record", "context=battlecode"),
        Example("1a1886d099df256d", "topic=college", "intent=request", "utility=action", "relationship=institution", "status=current,unconfirmed", "context=uoft"),
        Example("1a1a7cdc78db7b8f", "topic=research", "intent=request,coordination", "utility=action", "relationship=person", "status=current,unconfirmed", "context=implicit"),
        Example("1a18ec82d696e68d", "topic=software,reading", "intent=reference,promotion", "utility=reading,quiet", "relationship=publication,service", "status=record", "context=railway"),
        Example("1a025ab81d126f3d", "topic=programmes,reading", "intent=reference,opportunity", "utility=reading,optional", "relationship=programme", "status=historical", "context=iaifi")
    ];
    internal static string MessageId(string account, MailExample example) => $"gmail:{account}:{example.RemoteId}";
    internal static MailExample? Find(string id) => id.StartsWith($"gmail:{ExampleAccount}:", StringComparison.Ordinal)
        ? Examples.FirstOrDefault(x => MessageId(ExampleAccount, x) == id) : null;
    internal static bool Matches(MailExample example, IReadOnlyDictionary<string, HashSet<string>> filters, string? except = null) =>
        filters.All(filter => filter.Key == except || filter.Value.Count == 0 ||
            (example.Labels.TryGetValue(filter.Key, out var labels) && labels.Any(filter.Value.Contains)));
    internal static string CategoryName(string group, string category) =>
        Groups.First(x => x.Id == group).Categories.First(x => x.Id == category).Name;
}