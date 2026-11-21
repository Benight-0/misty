# Connect Gmail accounts to Archival

You create one Google OAuth client, then sign into each mailbox separately. You do not need a Gmail password or app password in Archival. Complete these steps in your usual browser on this laptop.

## 1. Create the Google project

1. Open https://console.cloud.google.com/ and sign into your Google account.
2. Open the project picker beside the Google Cloud logo, then choose **New project**.
3. Name it **Archival Local** and click **Create**. Select that project after it is created.
4. Open **APIs & Services → Library**, search for **Gmail API**, open it and click **Enable**.

Google's setup reference: https://developers.google.com/workspace/gmail/api/quickstart/nodejs

## 2. Configure Google sign-in

1. Open **Google Auth platform → Branding**. If prompted, click **Get started**.
2. Enter **Archival Local** as the app name. Choose your own email for support.
3. For **Audience**, choose **External** when using personal @gmail.com accounts. Internal is for accounts in a Google Workspace organization.
4. Enter your own developer contact email, review Google's terms, and create the configuration.
5. Open **Audience → Test users → Add users**. Add **every Gmail address you intend to connect**, then save.
6. Open **Data Access → Add or remove scopes**. Select or manually enter both:

   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.send

7. Update and save. `gmail.readonly` reads mail and `gmail.send` sends mail. These permissions do not allow deleting mail or marking it read.

Google's consent setup: https://developers.google.com/workspace/guides/configure-oauth-consent
Scope reference: https://developers.google.com/workspace/gmail/api/auth/scopes

## 3. Download the OAuth client JSON

1. Open **Google Auth platform → Clients → Create client**.
2. Choose **Desktop app**, name it **Archival Laptop**, and create it.
3. Download its JSON file immediately from the creation dialog and keep it on your laptop. Google only makes the full client secret visible/downloadable when it is created; do not assume the same complete credential JSON can be downloaded later from the client list.

Use **Desktop app**, not Web application or service account. You do not need to add an authorized website domain or manually configure a redirect URI. Archival opens a temporary callback listener at a random port on 127.0.0.1 for each login.

Keep this file on your laptop and upload it into the local app. Do not paste its contents into chat.

### If the JSON download is lost

First open your browser's downloads list with **Ctrl+J**, find the client JSON download and use **Show in folder**. Check Downloads and the Recycle Bin for the original file. If it was already uploaded successfully into Archival, the local app has its own stored copy and does not need another upload.

If the file is truly gone and Archival was not configured, open the same project's **Google Auth platform → Clients → Create client**, choose **Desktop app**, and create another client named **Archival Laptop 2**. Download the new JSON immediately and select it in Archival. Existing project-level Gmail API, consent settings, scopes and test users remain in that project. Do not delete a client that another app or existing Gmail connection still uses. A configured Archival client with connected accounts cannot be replaced with a different client ID until those local connections are removed.

Google documents client-secret rotation as another recovery option under the existing client's **Add Secret** control, where available. The simpler first-time setup route is a new Desktop app client in the same project.

Google's current credential visibility and recovery policy: https://support.google.com/cloud/answer/15549257?hl=en

## 4. Connect the first mailbox

1. Open http://127.0.0.1:8787 and choose **Sync & storage**.
2. Find **Gmail accounts** and use the file picker to select the downloaded JSON. It is copied into Archival's private data directory.
3. Click **Add / reconnect Gmail account**, then **Continue to Google**.
4. Select the mailbox you want to archive. Sign into Google if necessary.
5. Check that the app is your **Archival Local** project. If Google displays an unverified-app warning for your own personal-use project, its available **Advanced → Go to Archival Local** option lets you continue. A Workspace policy block requires your administrator; the app cannot bypass it.
6. Approve Gmail reading and sending access. Google may require selecting both permission checkboxes.
7. Wait for the local page saying Gmail connected, then close that tab and the Archival dialog.
8. The account appears under Gmail accounts with its import progress. The first scan continues in the background and resumes after a restart.

## 5. Add your other Gmail accounts

Repeat **Add / reconnect Gmail account → Continue to Google** for each address. Reuse the same OAuth JSON. In Testing mode, each address must be listed in Google's Test users section. Mailboxes are stored separately, even when the same email appears in both.

If you connected earlier with read-only access, add `gmail.send` under Google Data Access and reconnect the same mailbox here. You do not need a new OAuth client JSON. The existing archive is preserved; receiving still works with the old connection, but sending requires Google's new consent.

## Send email and reply

1. In **Conversations**, click **Compose email**, or use the same button in **Sync & storage → Gmail accounts**.
2. Choose the From mailbox. Enter To, optional Cc/Bcc, subject and message. Multiple addresses can be separated by commas.
3. Click **Review email**. The app saves a local prepared email and shows the exact sender, recipients, subject and body. Nothing has been sent yet.
4. Click **Send email** to send that prepared email through Google. The From address is the chosen mailbox's main address; choosing send-as aliases is not implemented.
5. To reply, use the **Reply** button on a stored Gmail message. The original mailbox, Message-ID and Gmail thread are retained. Reply-To is used when present. This is a reply to the sender, not automatic Reply all; add other recipients explicitly if needed.
6. Open **Send history** in Gmail accounts to inspect the last 50 prepared emails and send outcomes. Ready emails can be reopened and sent later. This history is local, not Google's Drafts folder.

Sending currently supports plain text up to 20,000 characters, To/Cc/Bcc and Unicode. File attachments, rich HTML formatting, Gmail draft synchronization, scheduled sending and undo-send are not implemented.

A prepared email is submitted at most once by this app. Sending is not retried automatically. A successful Google API response means Google accepted the email, not a guarantee of delivery to the recipient's inbox. If the app loses connection during sending, or restarts before the result is saved, it marks delivery **unconfirmed**. Check Gmail's Sent folder before manually preparing another copy. Confirmed sent mail is fetched into the archive when the account/thread is being tracked; pauses and archive failures do not change its send outcome.

Sending reference: https://developers.google.com/workspace/gmail/api/guides/sending

## 6. Avoid weekly reauthorization

An External project in **Testing** receives Gmail refresh tokens that expire after **seven days**. For ongoing personal use, open **Google Auth platform → Audience → Publishing status**, then choose **Publish app** / **In production** when available. This changes the Google OAuth status; it does not upload Archival or your local archive anywhere.

Google allows personal-use apps with fewer than 100 users to operate without OAuth verification, subject to unverified-app warnings and applicable account restrictions. Publishing and verification are separate. If you first connected while the project was in Testing, reconnect each mailbox after changing the status to obtain fresh authorization. Other causes of token expiration still exist; no setting guarantees permanent access.

Google's token expiration rules: https://developers.google.com/identity/protocols/oauth2#expiration
Personal-use verification exception: https://support.google.com/cloud/answer/13464323?hl=en

## What this connection does

- Imports available received, sent and archived email, grouped into Gmail threads. There is no intentional age or message-count cap.
- Excludes Drafts, Spam and Trash from new imports. Existing archived emails are retained if later moved or deleted in Gmail.
- Stores text, mail headers and attachment metadata. Attachment bytes, remote images, Google Chat and Gmail settings are not imported. HTML is converted to text and never rendered as email HTML.
- Uses Gmail's sent-mail label to identify your outgoing messages, including sent aliases. An incoming From header alone is not trusted as proof that you wrote a message.
- Fetches at most four message bodies concurrently. Completed pages and checkpoints are committed together. Search can use already imported mail immediately. Sending does not wait for the full mailbox import to finish.
- After the initial scan, checks Gmail history approximately every 15 seconds while Archival runs. API delays, network failures, quotas and large backlogs can increase delivery time; this is not a real-time guarantee.
- If the laptop was off long enough that Google discarded the history cursor, rescans message IDs and downloads missing bodies. Previously cached bodies are reused. Older deleted messages that were never archived cannot be recovered.
- Lets you pause an account, remove its local login, or pause/disconnect individual threads without deleting the existing archive. Re-enabling a thread fetches its currently available history.
- Starts Gmail threads with **Include in your profile** off. Enable selected threads in their settings if desired. Common quoted replies are removed from profile text, but automatic quote stripping is imperfect; review evidence before drawing conclusions.

## Storage and privacy

- Mail and search index: `data/app/archive.sqlite`.
- OAuth client and per-account tokens: `data/gmail/credentials.json`. This is sensitive and is never returned by the browser API. The temporary OAuth listener only binds to loopback.
- Prepared emails and send outcomes: the local archive's `gmail_outgoing` table. Reviewing saves recipients, body and MIME content locally, even if you do not send. Normal archive backups include this table.
- Google still receives normal OAuth/API traffic. There is no Beeper, Matrix Gmail bridge, Pub/Sub project, third-party mail relay, or external AI processing in this connection.
- Files are not additionally encrypted by Archival. Windows account/disk access or malware could expose them; local storage is not a promise of absolute privacy.
- Archival's **backup** command covers the archive, not Gmail credentials. Back up the token file separately only to storage you trust, or reconnect accounts after restoring the archive.
- **Remove local login** deletes that mailbox's tokens from the current credential file and stops imports. It does not revoke Google's grant or erase historical backups. To revoke access, visit https://myaccount.google.com/connections and remove **Archival Local**. Revocation may affect all grants for that Google project under that Google account.

Gmail sync reference: https://developers.google.com/workspace/gmail/api/guides/sync
Desktop OAuth reference: https://developers.google.com/identity/protocols/oauth2/native-app

## If something fails

- **Access blocked / user not allowed:** add that exact account under Test users while in Testing.
- **API disabled:** enable Gmail API in the project that created this OAuth client.
- **Wrong client type:** download a Desktop app client JSON, not a Web application or service-account file.
- **Sign-in state expired:** start Add Gmail account again; the local login window lasts ten minutes and is single-use.
- **Authorization expired:** reconnect through Add Gmail account. Check publishing status if this happens every week.
- **Sending permission missing:** add `gmail.send` beside `gmail.readonly` in Data Access and reconnect each mailbox. Selecting only the reading checkbox keeps that account receive-only.
- **Workspace administrator block:** ask the organization to allow this OAuth client; personal Gmail and managed Workspace rules differ.
- **Google rate limit / network unavailable:** the app keeps its checkpoint and retries. Do not repeatedly restart the import.
