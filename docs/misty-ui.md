# Misty

The website keeps its existing address and Cloudflare sign-in. The visible app is now Misty; service names and archive paths retain their existing names.

## Conversations

- The left rail filters Discord (`DC`) or WhatsApp (`WA`). The Misty button returns to all conversations.
- Chats sort by latest activity. Following is a filter and does not override recency.
- Messages run from oldest at the top to newest at the bottom. Chats open at the latest message. Scrolling upward near the loaded boundary automatically prepends another 80 older messages while preserving your reading position. A retry button is available at the top if loading fails.
- Live arrivals keep you at the bottom when you are already there and preserve your position while you read older history. **Jump to latest** returns to the bottom. Search and author filters still apply to older chunks.
- **Summary** opens the chat's saved briefing, history findings, emerging topics, events, and people.
- Click an author's name/avatar or someone in the people panel to open their profile. Profiles show evidence-linked observations, preferences, notes, and summaries by shared conversation. More conversations load in pages of five.
- The people panel counts archived authors, not current group members or online presence.

## Settings

Click your profile at the bottom of the conversation list or the gear in the left rail. Full-screen settings contain **My profile & interests**, **People & identities**, and **Connections & storage**. Escape returns to conversations.

Identity names apply to the account ID. Chat-specific names and notes remain under each chat's briefing. Renaming an account does not merge it with another account.

Opening a chat fetches its metadata and first 80 messages together. The expensive conversation-interest comparison runs only when conversation preferences are opened. On the VM, that old comparison took about six seconds per open; fetching the actual messages took three milliseconds in the measured samples. Network and other VM activity still affect visible loading time.

## Loading and analysis

Unread analysis has an explicit pending state. A previous summary stays available while new history is analyzed. Profiles never launch additional AI calls just by opening; they read the saved analysis. Loading failures can be retried, and closed profiles cannot reopen when a slow request finishes.

Messages, aliases, selections, completed analysis and checkpoints are preserved. VM sending remains unavailable; use the native messaging apps.
