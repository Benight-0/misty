# Misty overlay UI guide

This is the owner-approved design and interaction guide for the native Windows
overlay in desktop/Misty.Overlay. The separate docs/misty-ui.md describes the
archive website. For data flow, installation, and VM integration, see
[Misty desktop overlay](misty-overlay.md).

The latest explicit decision takes precedence when earlier directions differ.
For example, the shell is deliberately very rounded, while navigation buttons
remain clean, unboxed icons. The visible typography chooser was useful during
experimentation and was then removed from the production interface.

## Overall character

- Make the overlay feel like a deliberate, compact production app: ordered,
  restrained, useful, and visually consistent.
- Use a narrow vertical rail as the resting state. Open a connected panel to
  its left when a rail action is selected. The panel and rail should read as
  one object.
- Keep navigation in a fixed vertical order with even spacing and clear hit
  areas. Use simple white line icons without button boxes.
- Keep the interface dark, with contrast from neighboring shades rather than
  dividing lines. Reserve color for data categories, status, and unread state.
- Give the rail, expanded shell, and composer generous rounding. Round VM
  cards more modestly. Do not turn every control into a pill.
- Keep the Misty profile image circular. Use the bundled bot profile picture
  for the rail and Misty's messages.

## Shell and navigation

The rail actions, from top to bottom, are **Direct Message**, **Codex**,
**Laptop activity**, **Archive**, **VM status**, **Gmail**, and **Approvals**. The Misty avatar sits above
them; the connection indicator and hide control sit below them.

Selecting Direct Message, Codex, Laptop activity, or VM status opens its panel
to the left. Selecting the active action again or using the panel close control
returns to the compact rail. Archive opens the existing archive site. A panel
has one concise heading, with no subtitle. The window has no native Windows
title bar or chrome. Section labels within a panel are allowed where they help
scan the content.

A dotted outline encloses the **whole current shell**, a few pixels outside
the actual surface. It follows the rounded bar in compact mode and the combined
panel and bar in expanded mode. It is never a detached line on the right.
That outline is the one intentional decorative line; content separation comes
from shade and spacing.

**Ctrl+Shift+Space** toggles the overlay. If Windows cannot register it, the
existing fallback is **Ctrl+Alt+Shift+M**, shown in VM status. The app starts at
Windows sign-in and stays available in the notification area when hidden.
Keep the hotkey and tray behavior synchronized with any future navigation
change.

Current sizing is a baseline for deliberate tuning, not a reason to add a
permanent settings panel:

| Element | Current baseline |
| --- | --- |
| Compact shell | 82 px wide, about 470 px high |
| Expanded shell | 622 px wide, about 650 px high |
| Rail action | 64 × 58 px hit area, about 25 px icon |
| Shell and outline | 34 px surface clipping radius; about 40 px outline radius |
| Panel heading | 19 px, semibold |
| Composer | At least 43 px high, 18 px corners |
| VM status card | 10 px corners |

## Typography and message rhythm

Whitney is the preferred interface face, specifically **Whitney Book** for
normal conversation text. It is installed for the owner and is not bundled
with the app. Use Segoe UI as the system fallback. The bundled open-source
alternatives for controlled typography trials are Inter, Roboto, IBM Plex
Sans, Source Sans 3, and Mona Sans.

Body text should feel light and normal, not artificially bold. Reserve
semibold for names, panel headings, and a few key figures. Match Discord's
comfortable chat density through font choice, line height, and grouping.
Use the font's natural letter and word spacing rather than imposing unusual
tracking or word gaps. The current conversation baseline is 16 px text with a
22 px line height; a new message group has about 17 px of separation and
messages within the group about 2 px.

Font, size, and line height may be adjusted in a **temporary local tuning
surface** when comparing options. The chosen settings can be saved. Do not
restore the visible typography or typing-option chooser to the production
chat.

## Color

The shell and content use this owner-selected grayscale scale:

| Token | Hex | Typical role |
| --- | --- | --- |
| Black | #000000 | Rail foundation |
| Gunmetal | #343A40 | Composer and strong dark surface |
| Iron grey | #495057 | Selected reply surface |
| Slate grey | #6C757D | Quiet marks and timestamps |
| Pale slate 2 | #ADB5BD | Secondary text |
| Pale slate | #CED4DA | Quiet icon details |
| Alabaster grey | #DEE2E6 | Subtle controls and labels |
| Platinum | #E9ECEF | Conversation text |
| Bright snow | #F8F9FA | Primary text and line icons |

Near-black surfaces between these tokens are useful for controlled depth:
#0B0C0D, #141618, #202326, and #2A2E32. Keep these neutral. A hover may
lighten the row background slightly; it should not move, scale, grow a border,
or add a glow.

Functional colors are deliberate exceptions:

| Meaning | Hex |
| --- | --- |
| Online, active, connected | #43C982 |
| Idle, paused, checking, stale | #F0B85A |
| Offline, unavailable, failed | #F07178 |
| Unread Direct Message or Codex | #FF4B55 |

The laptop activity donut and its legend use the same category color in each
pair. The current distinct sequence is #78A9F7, #58C9A6, #B391F2,
#F1AE69, #E987AF, #77CAE0, #D5C76C, and #E67E79. Keep the category labels
visible; color alone must not carry the meaning. The pie chart and status
dots should **not** be forced back into grayscale.

## Direct Message

- The panel is named **Direct Message**, with no “Talk to Misty” label or
  explanatory subtitle.
- Show both the owner's and Misty's messages in one chronological conversation.
  Use their names, profile pictures, and times. The owner's name and avatar
  come from the verified conversation feed. Messages from the same author
  within about five minutes and on the same local day share one
  name/avatar/time header; later messages in that group have a small time mark.
- Render message Markdown as native selectable text: bullet/numbered/nested lists,
  headings, emphasis, quotes, code and clickable links. Keep code literal and
  never execute embedded HTML or load remote images. Exact send previews stay literal.
- Keep message text directly on the conversation surface. Do not draw a
  separate bubble or box around every message.
- Show Misty's current work in one muted, compact strip above the composer;
  update or remove it without adding temporary rows to the transcript.
- Hovering a message may only lighten its background slightly. Its reply
  arrow appears on hover. Selecting Reply highlights that target and adds a
  small left-aligned strip above the composer: reply icon, “Replying to Misty”
  or “Replying to you,” and a small cross to cancel. Cancel preserves the
  unsent draft.
- A sent reply keeps its referenced message visible as a compact quote. The
  overlay sends owner input into Misty's existing conversation; it does not
  impersonate the owner's Discord account or create a native owner Discord
  reply.
- Keep the typing area short, quiet, and rounded. **Enter** sends;
  **Shift+Enter** inserts a new line. There is no Send button, typing-mode
  chooser, or permanent “Enter to send” instruction.
- When the reader scrolls upward beyond the loaded top, show a skeleton and
  fetch the next older chunk while preserving reading position. Do not add a
  “Load older” button.

## Codex

Show a searchable list of known chats. Opening one shows its saved visible
user and assistant conversation with the same restrained chat rhythm. Load
older transcript chunks by upward scrolling and show a skeleton while they
arrive. The composer sends a prompt to the **selected existing chat** and
shows concise queued, running, completion, or error feedback. It should
remain usable while the laptop relay is temporarily offline.

Be precise about coverage: the overlay shows synced visible conversation
text. Hidden reasoning, tool logs, and attachment bytes are outside this
view. Do not imply that a queued prompt has already completed.

## Laptop activity, archive, and VM status

Laptop activity leads with freshness, then active, idle, and observed time
for the rolling 24-hour window. Show a colored category donut and legend,
most time spent by target, and application totals. Use concise measurement
notes so the 30-second samples are not mistaken for exact continuous timing.

VM status shows information from status.example.com directly in
the panel: CPU, memory, disk, seven-day CPU P95, estimated usage, today's
usage, and tokens, followed by connection and service states. Use modestly
rounded dark cards. Status values retain their text labels alongside their
green, amber, or red dots.

Archive is a utility action to the existing site, not an empty placeholder
panel.

## Gmail and approvals

Keep Gmail inside the connected panel with a stable left folder column, a
message list, and a wide reading area. Use the same black-to-gunmetal shades
and Whitney Book text as the rest of the overlay. Selected rows gain a slightly
lighter shade; email bodies remain readable plain text without message bubbles
or decorative borders. Show sender, subject, preview, and time in each row.
Folder and custom-category counts use restrained secondary text.

The Gmail panel starts in Primary. Keep all inbox, other Gmail folders, and
the six seeded custom categories easy to reach. Category editing is a clear
form in the reading area. Message actions are compact rectangular controls,
with modest rounding, grouped above the body. Compose and reply use the same
reading area and lead to a separate exact approval preview.
For Gmail changes, show immediate progress and disable the action row until the
request completes. If Gmail confirms a change but the inbox refresh fails, say
that the change applied and offer Refresh. If confirmation is uncertain, tell
the owner to refresh before trying the action again.
Keep a Pending sends entry in Gmail's left column for both email and personal
message drafts; it opens the same exact preview as the dedicated Approvals
button. The Gmail rail icon is the familiar folded M shape in white and gray
shades. The Approvals rail icon is a single white checkmark without a box.

The Approvals icon carries a red dot while a draft is pending. Open its panel
automatically for a new pending draft and show the complete destination and
body before Send, Cancel, Edit, or Ask Misty to edit. Edits make a new preview;
the old preview cannot send. Avoid claiming delivery when it is uncertain.

## Notifications

When Misty sends a new message or Codex produces visible output, reveal the
compact rail if it is hidden. If a panel is already open, leave the user's
work in place and pulse the rail. The pulse lasts **five seconds**: full
opacity to 25% and back, repeated five times. Play one short, quiet ping when
the pulse starts. Do not flash the full reading panel.

The Direct Message and Codex icons have independent red unread dots. Mark only
the source that produced new activity; clear its dot when that panel is viewed.
Unread state survives app restarts. The tray's Notifications switch suppresses
the reveal, pulse, and ping, while unread dots still track new activity. Do not
show private message bodies in a Windows toast or on the lock screen.

The small rail connection dot is separate from unread state. Its green, amber,
and red meanings are shown above. Keep status labels or tooltips so the state
is understandable without color alone.

## Explicit exclusions and review rules

- Do not use gradients, generic dashboard decoration, haphazard placement,
  pill-shaped navigation buttons, or boxed borders around the rail icons.
- Do not add bright white separators between chat messages or panels. Keep
  the enclosing dotted outline, and separate content through shade and space.
- Do not make normal conversation text heavy or semibold.
- Do not restore per-message bubbles, the Send button, “Load older” controls,
  the visible typography chooser, title subtitles, or native window chrome.
- Do not add routine computer-access or tool-review confirmation screens to
  the overlay. Keep the separate explicit confirmation flow for sending from
  the owner's personal accounts to other people.
- Do not replace the source-specific notification dots with one generic
  unread badge or a system balloon notification.

When changing the UI, inspect compact and expanded states, hover and reply
states, both chat composers, older-history loading, the activity chart, VM
cards, unread dots, and the registered shortcut in the running app. Preserve
  unsent drafts during an app restart.

The same overlay window is pinned across Windows virtual desktops. Switching
desktops preserves the open panel and draft state without moving focus. Hidden
stays hidden. Pinning is reapplied at startup and checked periodically for shell
recovery; desktop-presence.txt in the local overlay state directory records the
result. Startup does not activate the window over the owner's foreground app.
