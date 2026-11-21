# Gmail in Misty's VM archive

Misty archives Gmail directly on the VM, including while your laptop is off. Each connected mailbox has its own Google authorization and durable sync checkpoint in `/var/lib/archival/data/archive.sqlite`. New messages are checked through Gmail history about every 15 seconds. The archive includes Inbox, Sent, archived mail, Drafts, Spam, Trash and other labels. Attachment bytes are stored in the archive database and can be downloaded from the authenticated website. Misty's archive search can find stored email text and links to its source.

## Reuse the existing local Archival connection

If the original Desktop OAuth client is already configured on this laptop, you can reuse its Google project and downloaded JSON. A refresh token rejected by Google with `invalid_grant` must be authorized again; copying the old token will not resume mail sync.

1. Run `node scripts/authorize-misty-gmail-desktop.mjs` in this repository on the laptop. It uses the existing client but requests **Gmail read-only** access for a separate VM authorization. The original local Archival token is left intact.
2. Open the printed Google sign-in URL in your usual browser and approve access for the same mailbox within ten minutes. The helper stages the new token in `data/deployment/misty-gmail-auth/credentials.json` and verifies that it can refresh. Do not paste the token into chat.
3. Transfer that staged file through the VM maintenance SSH connection to `/var/lib/archival/gmail/credentials.json` with owner `archival` and mode `0600`, then restart only `archival.service`. After checking VM sync, remove the staged token from the laptop.

The VM website recognizes a migrated Desktop client and offers **Check mail now**. The read-only token continues to sync all mailbox categories and attachment files. It cannot save drafts or send. For that capability, use the separate compose authorization below.

## Let Misty save drafts and send approved emails

1. Run `node scripts/authorize-misty-gmail-compose.mjs` on this laptop. It reuses the original Desktop OAuth client and requests `gmail.readonly` plus `gmail.compose`; the older read-only VM token keeps syncing until replacement. The helper does not alter the original local Archival credential.
2. Open the generated Google sign-in URL **on this laptop** and approve both Gmail reading and managing drafts/sending. The helper checks the same mailbox and verifies that the new token refreshes. It stages the token at `data/deployment/misty-gmail-compose-auth/credentials.json`; never paste this file into chat.
3. After deploying the reviewed application and Misty email tools, run `python scripts/activate-misty-gmail-compose.py` in this repository. It verifies the same mailbox, client and scopes; backs up the current VM credential; then atomically replaces `/var/lib/archival/gmail/credentials.json` over the maintenance SSH connection with owner `archival` and mode `0600`. It restarts only `archival.service`. Verify sync and Misty's draft/send capability without sending a test email. After verification, remove the staged token from the laptop.

Misty can list mailboxes with `misty.py email-accounts`. `email-save-draft` creates an unsent Gmail draft from a current verified owner request. For sending, `email-send-preview` queues the complete From, To, Cc, Bcc, Subject and exact body in the same owner DM. **Every email to another person requires a fresh owner yes after the complete preview.** A changed recipient or body needs a new preview. Unknown delivery is never retried automatically; check Gmail Sent before considering another send. The VM website's direct compose/send endpoints remain disabled so this confirmation cannot be bypassed from the archive UI.

## Connect a new Web OAuth client directly on the VM

1. In [Google Cloud Console](https://console.cloud.google.com/), select or create a project and [enable Gmail API](https://developers.google.com/workspace/gmail/api/quickstart/nodejs).
2. Configure the Google Auth platform consent screen for your account. If the project is in Testing, add each Gmail address under **Test users**. Under **Data Access**, add `https://www.googleapis.com/auth/gmail.readonly` and, if Misty should draft/send, `https://www.googleapis.com/auth/gmail.compose`. These scopes do not grant permanent deletion.
3. Under **Clients**, create an OAuth client of type **Web application**. Add this exact authorized redirect URI: `https://archival.example.com/oauth/gmail/callback`. Download its JSON. The older local Archival **Desktop app** client JSON is a different client type and cannot be uploaded through the VM website; use the laptop reuse flow above for it.
4. Sign into `https://archival.example.com` through Cloudflare Access. Open **Connections & storage → Gmail accounts**, upload the Web application JSON, then choose **Add / reconnect Gmail account**. Follow **Continue to Google** in your usual browser, select the mailbox, and approve the requested Gmail access.
5. Return to **Gmail accounts** to watch the stored count, import progress, last successful page, and any error. Repeat **Add / reconnect** for other mailboxes. Use **Check mail now** to request an immediate pass.

The consent action is required for each mailbox. Do not paste the OAuth JSON, its client secret, or refresh tokens into chat. An existing local Archival token is separate from the VM connection until you explicitly migrate a fresh, read-only authorization as above.

## What is stored

- Available received, sent, archived, draft, spam and trashed messages are imported without an intentional age or count cap. The initial scan is paginated and resumable. A one-time rescan discovers older messages in newly included folders. Drafts also receive a separate paginated pass. New messages are checked through [Gmail history](https://developers.google.com/workspace/gmail/api/guides/sync) about every 15 seconds while the VM service runs. If its history cursor expires, a full ID scan recovers mail still available in Gmail.
- Message text, subject, sender/recipient headers, labels, timestamps, thread IDs, attachment metadata and attachment bytes go into the VM archive database. Existing attachment metadata is backfilled in bounded batches; the status card shows the remaining count and files Gmail no longer provides. A manual rescan retries those unavailable files. HTML is converted to inert text, and downloads use `Content-Disposition: attachment` with `nosniff`.
- A message already archived remains in Misty's database if later deleted or moved in Gmail. Bytes for a message deleted in Gmail before backfill cannot be recovered; its saved text and metadata remain.
- Gmail threads start excluded from personality/profile analysis. You may enable selected threads in their conversation settings. Misty can search stored mail when asked; the normal proactive chat notification loop does not treat each email as an incoming personal DM.
- The read-only connection continues to archive mail until upgraded. `gmail.compose` is required for Misty to create Gmail drafts and send after owner confirmation. The VM website cannot send directly.

## Storage and recovery

The VM stores OAuth client details and tokens in `/var/lib/archival/gmail/credentials.json`, separate from the archive database. Both the archive and this token file are included in the VM's normal private backup package. Access to the archive website is protected by Cloudflare Access, while the VM administrator and its services can read the stored data. Removing a local login stops future sync and retains archived mail; revoke the Google grant separately in [Google Account connections](https://myaccount.google.com/connections) if desired.

Google can revoke or expire a refresh token. In particular, an External OAuth app in Testing may require renewed authorization after seven days; see [Google's token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration). Reconnect the affected mailbox in **Gmail accounts**; its stored mail remains in the database.
