# Mail grouping UI

The native overlay mail view has Primary, Sent, All inbox and six grouping tabs: Topics, Intent, Utility, Relationship, Status and Context. Selecting a grouping reveals its category checkboxes. An email may carry several categories in each grouping. Selected categories match with OR inside a grouping and AND across groupings. Clear all filters resets the selections; returning to a normal folder resets grouping mode.

This first UI release includes seven real emails with example labels stored only in MailGroupingCatalog.cs. Grouping views explicitly show that example scope and leave all other mail unclassified. Example retrieval and opening from the grouped view are read-only. Existing normal folder read handling, compose, approvals, account switching, older mail and saved rule editing remain available. No bulk classifier, Gmail label mutation or background labelling is installed.

Try Topics / Software and Money, then Intent / Proof. AWS credits and the NTU receipt demonstrate multiple topic labels; combining groups narrows the results. Search applies within the example set when grouping mode is selected.

Check with `dotnet run --project desktop/Misty.MailGroups.Tests -c Release` and build `desktop/Misty.Overlay`. The filter checks cover OR, AND, facet counts, account isolation and unlabelled mail. Existing Gmail and overlay bridge node tests cover the unchanged backend boundary.