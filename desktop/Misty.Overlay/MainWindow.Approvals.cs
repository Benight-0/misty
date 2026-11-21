using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using TextBox = System.Windows.Controls.TextBox;

namespace Misty.Overlay;

public partial class MainWindow
{
    private bool approvalEditing;
    private TextBox? mistyEditInstruction;

    private async Task RefreshApprovals(bool startup)
    {
        try
        {
            var response = await bridge.RequestAsync(new { op = "approvals" }, stopping.Token);
            var drafts = response.GetProperty("drafts").EnumerateArray().Select(item => item.Clone()).ToArray();
            pendingSendsCount = drafts.Length;
            if (gmailPendingSends != null)
            {
                gmailPendingSends.Content = $"Pending sends  {pendingSendsCount}";
                gmailPendingSends.Background = Brush(pendingSendsCount > 0 ? "#343A40" : "#202326");
            }
            var fresh = drafts.FirstOrDefault(d => !knownApprovals.Contains(Value(d, "code")));
            var hasFresh = fresh.ValueKind == JsonValueKind.Object;
            foreach (var draft in drafts) knownApprovals.Add(Value(draft, "code"));
            ApprovalUnreadDot.Visibility = drafts.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            ApprovalList.Children.Clear();
            if (drafts.Length == 0) ApprovalList.Children.Add(Label("Nothing waiting.", 12, "#ADB5BD"));
            foreach (var draft in drafts)
            {
                var code = Value(draft, "code");
                var target = draft.GetProperty("target");
                var destination = Value(target, "platform") == "gmail"
                    ? "Email · " + string.Join(", ", target.GetProperty("to").EnumerateArray().Select(x => x.GetString()))
                    : "Message · " + Value(target, "name");
                var button = ActionButton(destination + "\n" + Time(Number(draft, "created")), () => SelectApproval(draft));
                button.HorizontalContentAlignment = System.Windows.HorizontalAlignment.Left;
                button.Background = Brush(approvalCode == code ? "#495057" : "#202326");
                ApprovalList.Children.Add(button);
            }
            var chosen = drafts.FirstOrDefault(d => Value(d, "code") == approvalCode);
            if (chosen.ValueKind != JsonValueKind.Object && drafts.Length > 0) chosen = drafts[0];
            if (chosen.ValueKind == JsonValueKind.Object &&
                (!currentApproval.HasValue || Value(currentApproval.Value, "code") != Value(chosen, "code")))
                SelectApproval(chosen);
            else if (drafts.Length == 0)
            {
                currentApproval = null; approvalCode = "";
                ApprovalDetail.Children.Clear(); ApprovalDetail.Children.Add(Label("Nothing waiting for approval.", 14, "#ADB5BD"));
            }
            ApprovalStatus.Text = drafts.Length == 0 ? "No pending sends" : $"{drafts.Length} pending · exact preview required before sending";
            if (hasFresh)
            {
                SelectApproval(fresh);
                if (!IsVisible) ShowFromTray();
                ShowPanel("approvals");
                if (!startup && notifications) PulseRail();
            }
        }
        catch (Exception error) when (error is not OperationCanceledException) { ApprovalStatus.Text = error.Message; }
    }

    private void SelectApproval(JsonElement draft)
    {
        currentApproval = draft.Clone(); approvalCode = Value(draft, "code"); approvalEditing = false;
        RenderApproval(draft);
    }
    private void RenderApproval(JsonElement draft)
    {
        ApprovalDetail.Children.Clear(); approvalEdits.Clear(); mistyEditInstruction = null;
        var target = draft.GetProperty("target");
        var email = Value(target, "platform") == "gmail";
        ApprovalDetail.Children.Add(Label(email ? "Review email" : "Review message", 20, "#F8F9FA", true));
        ApprovalDetail.Children.Add(Label("Draft " + Value(draft, "code") + " · expires " + Time(Number(draft, "expires")), 11, "#ADB5BD"));
        if (email)
        {
            ApprovalDetail.Children.Add(Label("From  " + Value(target, "from"), 12));
            AddApprovalField("To", "to", string.Join(", ", target.GetProperty("to").EnumerateArray().Select(x => x.GetString())));
            AddApprovalField("Cc", "cc", string.Join(", ", target.GetProperty("cc").EnumerateArray().Select(x => x.GetString())));
            AddApprovalField("Bcc", "bcc", string.Join(", ", target.GetProperty("bcc").EnumerateArray().Select(x => x.GetString())));
            AddApprovalField("Subject", "subject", Value(target, "subject"));
            if (!string.IsNullOrEmpty(Value(target, "replyTo"))) ApprovalDetail.Children.Add(Label("Reply to archived email " + Value(target, "replyTo"), 11, "#ADB5BD"));
        }
        else
        {
            ApprovalDetail.Children.Add(Label("From your " + Value(target, "platform") + " account", 12));
            ApprovalDetail.Children.Add(Label("To  " + Value(target, "name"), 13, "#F8F9FA", true));
            ApprovalDetail.Children.Add(Label("Chat ID  " + Value(target, "remoteId"), 11, "#ADB5BD"));
            if (!string.IsNullOrEmpty(Value(target, "guildId")))
                ApprovalDetail.Children.Add(Label("Server  " + Value(target, "guildName") + " · #" + Value(target, "channelName"), 11, "#ADB5BD"));
        }
        AddApprovalField(email ? "Email body" : "Exact message", "body", Value(draft, "body"), true);
        var code = Value(draft, "code"); var digest = Value(draft, "digest");
        ApprovalDetail.Children.Add(Actions(
            ActionButton(email ? "Send email" : "Send message", () => _ = SendApproval(code, digest)),
            ActionButton("Cancel", () => _ = CancelApproval(code, digest)),
            ActionButton(approvalEditing ? "Apply edit" : "Edit", () => ToggleApprovalEdit(code, digest)),
            ActionButton("Ask Misty to edit", ShowMistyEditBox)));
        ApprovalDetail.Children.Add(Label("Sending is a single attempt. If delivery is uncertain, check Sent before trying again.", 11, "#ADB5BD"));
    }
    private void AddApprovalField(string caption, string key, string value, bool multiline = false)
    {
        ApprovalDetail.Children.Add(Label(caption, 11, "#ADB5BD", true));
        var box = Input(value, multiline); box.IsReadOnly = !approvalEditing;
        box.Background = Brush(approvalEditing ? "#343A40" : "#282B2E");
        approvalEdits[key] = box; ApprovalDetail.Children.Add(box);
    }
    private void ToggleApprovalEdit(string code, string digest)
    {
        if (!approvalEditing)
        {
            approvalEditing = true;
            foreach (var field in approvalEdits.Values) { field.IsReadOnly = false; field.Background = Brush("#343A40"); }
            ApprovalStatus.Text = "Edit the fields, then choose Apply edit to review a new preview.";
            return;
        }
        _ = ApplyApprovalEdit(code, digest);
    }
    private async Task ApplyApprovalEdit(string code, string digest)
    {
        try
        {
            var fields = approvalEdits.ToDictionary(item => item.Key, item => item.Value.Text);
            var result = await bridge.RequestAsync(new { op = "approval_edit", code, digest, fields }, stopping.Token);
            approvalCode = Value(result, "code"); currentApproval = null; approvalEditing = false;
            await RefreshApprovals(false);
        }
        catch (Exception error) when (error is not OperationCanceledException) { ApprovalStatus.Text = error.Message; }
    }
    private async Task SendApproval(string code, string digest)
    {
        if (approvalEditing) { ApprovalStatus.Text = "Apply edits and review the new preview before sending."; return; }
        ApprovalStatus.Text = "Sending once…";
        try
        {
            var result = await bridge.RequestAsync(new { op = "approval_send", code, digest }, stopping.Token);
            ApprovalStatus.Text = Value(result, "state") == "sent" ? "Sent." : "Submission " + Value(result, "state") + ". Check Sent before another attempt.";
            await RefreshApprovals(false);
        }
        catch (Exception error) when (error is not OperationCanceledException) { ApprovalStatus.Text = error.Message; }
    }
    private async Task CancelApproval(string code, string digest)
    {
        try { await bridge.RequestAsync(new { op = "approval_cancel", code, digest }, stopping.Token);
            ApprovalStatus.Text = "Cancelled. Nothing was sent."; await RefreshApprovals(false); }
        catch (Exception error) when (error is not OperationCanceledException) { ApprovalStatus.Text = error.Message; }
    }
    private void ShowMistyEditBox()
    {
        if (mistyEditInstruction != null) { mistyEditInstruction.Focus(); return; }
        ApprovalDetail.Children.Add(Label("Tell Misty what to change", 11, "#ADB5BD", true));
        mistyEditInstruction = Input("", true); mistyEditInstruction.MinHeight = 75;
        ApprovalDetail.Children.Add(mistyEditInstruction);
        ApprovalDetail.Children.Add(ActionButton("Ask Misty", () => _ = AskMistyToEdit()));
        mistyEditInstruction.Focus();
    }
    private async Task AskMistyToEdit()
    {
        if (!currentApproval.HasValue || string.IsNullOrWhiteSpace(mistyEditInstruction?.Text)) return;
        var draft = currentApproval.Value;
        var prompt = "Please revise my pending personal message draft " + Value(draft, "code") + ". Keep it unsent and create a new app approval preview.\n" +
            "My requested changes: " + mistyEditInstruction.Text.Trim() + "\nCurrent exact destination: " + draft.GetProperty("target").GetRawText() +
            "\nCurrent exact body:\n" + Value(draft, "body");
        if (prompt.Length > 16000) { ApprovalStatus.Text = "Edit request is too long. Shorten the instruction."; return; }
        try
        {
            await bridge.RequestAsync(new { op = "send", clientId = Guid.NewGuid().ToString(), text = prompt }, stopping.Token);
            ApprovalStatus.Text = "Asked Misty to revise this draft. Wait for a new approval preview.";
        }
        catch (Exception error) when (error is not OperationCanceledException) { ApprovalStatus.Text = error.Message; }
    }
}
