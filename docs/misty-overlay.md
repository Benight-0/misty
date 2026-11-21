# Misty desktop overlay

The owner-approved visual and interaction rules are in
[Misty overlay UI guide](misty-overlay-ui-guide.md).

The Windows app is a native WPF dock. It opens as a compact, translucent black
rounded rail with white icons and Misty's circular profile picture at the top.
A rounded dotted outline sits a few pixels outside the entire dock; it expands
around both the panel and rail when a panel opens. Selecting an icon opens its
rounded panel to the left;
selecting that icon again or using the panel's close control returns to the
compact rail. The seven actions are **Direct Message**,
**Codex**, **Laptop activity**, **Archive**, **VM status**, **Gmail**, and **Approvals**. The archive icon
opens the existing Cloudflare-protected site. The other panels use the paired
SSH connection.

**Ctrl+Shift+Space** toggles the overlay from anywhere on the laptop. If another
app already owns that shortcut, Misty tries **Ctrl+Alt+Shift+M** instead. The
VM status panel shows the shortcut that registered. The app also stays in the
notification area when hidden and starts at user sign-in.

Whitney is the preferred interface font. It is a [commercial typeface](https://www.typography.com/fonts/whitney/overview)
and is not bundled with Misty. The owner-provided Whitney faces are installed
for the current Windows user. On a machine without Whitney, the interface uses
Segoe UI as its fallback. The cropped profile picture and app icon are bundled
under `desktop/Misty.Overlay/Assets`.

Saved typography settings continue to apply to the conversation, including
Whitney Book and any previously selected bundled font. The on-screen typography
chooser has been removed. Letter and word spacing use each font's natural
metrics. Bundled font licenses are under `desktop/Misty.Overlay/Assets/Fonts`.

## Conversation and events

The app sends text into the same verified owner inbox, owner session, and durable
reply outbox used by Misty's Discord DM. A private Unix socket in the existing
Prominence process admits local overlay input. The Windows process reaches the
socket through the established SSH key and runs the bridge as the `misty-bot`
account. It does not expose an HTTP port or make a second model conversation.
Each send has a stable client UUID; an uncertain acknowledgement can be checked
and retried with the same UUID without creating a second turn. The owner input is
also recorded in the VM bridge's `bot_turns` table so existing owner-scoped tools
see the actual request. Misty's replies still use her durable owner-only Discord
outbox and appear in the app from the verified owner DM history.

The conversation shows both owner and Misty messages in time order. Nearby
messages from the same person share one name, avatar, and timestamp header;
each later message in the group has a small time label. The owner name and
avatar come from the verified Discord DM feed, while Misty uses the bundled
profile image. Press **Enter** to send; use **Shift+Enter** for a new line.
There is no separate send button.

Hover over a Direct Message to show its reply arrow. Selecting it highlights
that message and adds a small reply strip above the composer; the cross cancels
the reply without clearing the draft. Sending stores the verified target
reference and gives Misty its quoted text as context. Overlay messages remain
local owner inputs; they are not posted from the owner's Discord account.
Existing Discord replies display their quoted target in the conversation too.

The dock uses a grayscale palette from black and gunmetal surfaces to slate,
platinum, and bright snow for controls and text. The activity chart uses
distinct colors for its categories, and status dots use green, amber, and red.

Scrolling upward at the top of the Direct Message or Codex transcript loads
the next saved page, with a skeleton while the private bridge responds.

The Codex panel lists the laptop relay's known chats and opens their saved
visible user and assistant transcript, including older pages. Hidden reasoning,
tool logs, and attachment bytes are outside this transcript. The laptop
periodically syncs these snapshots, so a newly completed turn can appear after
the relay result. A prompt typed in a selected chat enters the existing durable
Codex relay queue for that exact chat. The app shows queued, running, and
completion states. If the laptop is off, the prompt waits on the VM until its
relay reconnects. The app saves its message and event cursors and pending Codex
queue receipts under `%LOCALAPPDATA%\Misty\Overlay\state.json`.
New Misty messages and visible Codex output reveal the compact rail if it is
hidden and play a quiet ping. The rail pulses from full to quarter opacity and back five times over
five seconds. Separate red dots mark unread Direct Message and Codex activity;
each clears when its panel is viewed. The dots survive app restarts. The tray
menu's Notifications switch controls the reveal and pulse; unread dots still
track new activity when it is off. No message body appears in a system toast.
Connection loss is visible and the app reconnects; the VM remains the source
of truth.

While Misty works on an owner request, Direct Message shows one quiet status
strip above the composer, such as “Misty is checking Gmail.” It updates from
the active app-server item and disappears when the turn ends. In Discord, the
same current step is shown as one temporary `>` quote message. Its text is
edited as the work changes, then the message is deleted at turn completion.
These status updates are excluded from the desktop transcript and the agent's
conversation context. Published owner replies and progress messages stay in
the conversation. Discord status traffic runs on a separate worker so API
delays do not block the model event loop.

The activity panel aggregates the rolling 24-hour foreground samples into
active, idle, and observed time; a category pie chart; and top sites and apps.
Intervals are capped at 45 seconds so offline gaps are not counted as use.
These are estimates from 30-second samples. Background windows and inactive
Chrome tabs are excluded. The VM panel shows live CPU, memory, disk, usage, and
token totals from the same local aggregate feed that powers
`status.example.com`, alongside service health.

The VM panel also has a temporary **Trace** tab for the latest owner turn.
It shows the original message trigger, handler arrival, Codex readiness,
model turn start, first queued reply, total elapsed time, and a scrollable
timeline of visible progress, tool names and outcomes, reasoning summaries
when Codex provides them, visible model text, and queued/sent owner replies.
It does not expose raw private reasoning or arbitrary tool output. The trace
stays in an owner-only SQLite database on the VM, keeps the latest six turns,
and caps each text event. Opening the tab reads the latest trace through the
existing private overlay socket; it does not start a new model turn.

## Build and install

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-misty-overlay.ps1`.
`-BuildOnly` publishes without creating a scheduled task. The installer uses the
installed .NET 9 desktop runtime and produces a single app executable under
`data/deployment/misty-overlay`. The scheduled task is **Misty Overlay** and
starts only in the owner Windows session. The app resolves the paired SSH
configuration from the repository and uses no new local credentials.

Focused backend check: `python -m unittest -v test_overlay` from `prominence/`.
Native build check: `dotnet build desktop/Misty.Overlay/Misty.Overlay.csproj -c Release`.

The VM side consists of `prominence/overlay.py`,
`prominence/overlay_agent.py`, the socket registration in `prominence/bot.py`,
and narrow owner-input and selected-chat dispatch operations in
`app/misty-prominence-bridge.mjs` and `app/misty-direct.mjs`.
The bridge operation keeps existing owner-scoped tools authorized without
granting the Prominence service write access to the bridge database. A
supervised Misty restart and a bridge service restart load the changes. The VM
status panel reads `systemctl is-active` for Misty, the bridge, activity
ingestion, metrics, and the archive, plus the existing relay heartbeat and
activity DB.

## Gmail and approvals

Gmail opens a native three-column mail view: folders and editable categories,
stored message previews, and the selected email. Primary is the initial folder;
All inbox, Unread, Starred, Drafts, Sent, All mail, Spam, and Trash are also
available. The seeded categories are College, Promotional, Informatics, Direct
message, Internship, and Log-in. Category rules match sender, subject, body, or
Gmail labels and can be edited in the app. They classify the local archive;
they do not alter Gmail's own labels.
The Gmail column also has Pending sends for both email and personal-message
drafts. It opens their shared exact preview in Approvals. The Gmail rail icon
uses a monochrome folded M; Approvals uses a checkmark.

An email opens with its sender, recipients, full stored text, timestamp, and
stored attachments. The toolbar offers Reply, Reply all, Forward, Star,
read/unread, Archive, Inbox, Spam, and Trash where allowed. Attachment saving
requires an explicit file choice. Compose and reply first create an exact
approval preview; they never send on entering the composer.

Approvals opens automatically when a new personal message or email draft needs
the owner's decision. It shows exact destination and body, including Gmail
Cc/Bcc and subject. **Send** submits once after rechecking the destination;
**Cancel** retires it; **Edit** creates a new preview; **Ask Misty to edit**
sends the requested changes into the owner conversation. A Discord `yes` or
`no` does not approve or cancel the draft. The bridge remains private to the
paired Windows app and VM account. A preview remains pending for 24 hours;
its destination is checked again before sending.

Reading mail and composing use the existing Gmail connection. Star, read
state, archive, spam, and trash require a new Google `gmail.modify` grant.
Until that grant is installed, the app shows a permission note and leaves
those controls unavailable. The account authorization helper is
`scripts/authorize-misty-gmail-manage.mjs`; the staged credential is activated
by `scripts/activate-misty-gmail-manage.py` after Google sign-in.
