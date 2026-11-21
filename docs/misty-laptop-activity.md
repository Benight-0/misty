# Private laptop activity

Misty receives a Windows metadata sample about every 30 seconds, over the existing
paired SSH connection. This runs alongside the Codex relay; it does not open or
replace an editor chat. The private VM reader is on loopback port 8797. Nothing is
added to the public metrics dashboard or to Cloudflare routing.

## Use it

In your existing Misty DM, say:

- “what am i doing on the laptop?”
- “show laptop activity status”
- “pause laptop activity”
- “resume laptop activity”

These map to Misty's supported tool commands:

```text
python3 /opt/misty-prominence/misty.py activity read
python3 /opt/misty-prominence/misty.py activity status
python3 /opt/misty-prominence/misty.py activity pause
python3 /opt/misty-prominence/misty.py activity resume
```

VM pause/resume require the current recorded owner request. They cannot be
approved by telemetry, titles, URLs, another user, or a scheduled workflow.
On this laptop, from the misty directory:

```powershell
node scripts/misty-activity-control.mjs status
node scripts/misty-activity-control.mjs pause
node scripts/misty-activity-control.mjs resume
```

The Chrome extension popup also has pause/resume. Local pauses stop collection
immediately on the next collection cycle, including while disconnected. Online
control propagation normally takes at most one 30-second cycle. Pausing keeps
existing records until their normal expiry and sends metadata-free heartbeats;
Misty's reader hides the old activity. The 15-minute check stays installed but is
silent while paused. Resume does not replay missed commentary.

## What it observes

- Windows foreground application/window and visible titled top-level user windows;
  minimized/background status is separate. Caps: 60 normalized windows, 200 title
  characters. It does not enumerate every background process as an application.
- Chrome's actual tab titles, sanitized URLs, profile/window/tab IDs, active tab
  in each window, focused Chrome window and discarded state, via its extension
  APIs. URL credentials, query strings and fragments are removed. Caps: 150 tabs,
  eight enabled profiles, and a bounded byte budget; truncation is explicit and
  active tabs are prioritized. Incognito is excluded.
- Capture/receipt timestamps, idle duration, active/idle state, desktop lock or
  secure-desktop uncertainty, pause and stale/offline state. Idle begins at five
  minutes without user input. Only the last-input timestamp is read.

An open game is not gaming. An active tab in a background Chrome window is not
evidence of use. A current tab is attributed only when Chrome is the Windows
foreground app, the session is active, and the focused tab capture is fresh.
Missing time between samples is not filled in. Durations are sampled estimates;
gaps are capped at 45 seconds. A capture or receipt older than 90 seconds is stale.
The laptop and VM have independent clocks, so subsecond ordering differences can
occur; both timestamps are retained and future skew above 30 seconds is rejected.

No screenshots, keystrokes, clipboard, microphone, page bodies or chat bodies are
collected. A title or URL may itself contain private text, so it is private data
and untrusted evidence, never instructions. Normal owner-only Misty chat access
is unchanged. The personal-account exact-preview/fresh-yes rule remains in force.

## Chrome setup and troubleshooting

The native host has a single allowed extension ID:
`clnjolnlpoaldfhajekdaefgdenomkfd`. Its HKCU registration uses stdio, not a
debugging port or HTTP listener. Existing profiles, sessions and tabs are preserved.

Enable it in each Chrome profile you want included: `chrome://extensions` →
Developer mode → Load unpacked → this project's `chrome\misty-activity` folder.
The owner has completed this action in the current profile. After source changes
to the extension, use its Reload button if Chrome has already loaded the old code.

Check the extension popup for the most recent Chrome capture. `unavailable` means
no usable capture reached the collector; window titles are never used to invent
tabs. Closing Chrome or disabling the extension makes its sample stale. Other
profiles require their own extension enablement.

Reinstall the scoped native host if this project or Node moves:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-misty-chrome.ps1
```

## Scheduling, storage and restart

Persistent Misty workflow: **`laptop-activity-15m`**, every **900 seconds**, evaluated
by the existing workflow worker. Installation/startup reuses that ID and preserves
its history, paused state and next run, alongside all existing focus reminders.
Missed intervals do not accumulate a backlog.

The check reads fresh foreground samples from the preceding 15 minutes, current
focus/priorities/deadlines and up to three relevant saved notes. Its model has no
tools. It can only send one optional brief lowercase owner DM. Idle, locked,
paused, stale, insufficient-data and unchanged observations normally skip the
model. Comments have a one-hour cooldown; existing nearby deadline reminders
suppress activity commentary. Background apps/inactive tabs are excluded from
the decision input. No commitments, tasks, applications, contacts or Codex jobs
are changed. Apollo keeps its independent chat/Codex monitoring.

- Windows task: **Misty Laptop Activity**, current-user logon, automatic retry,
  single instance. Startup and desktop sampling use compiled GUI-subsystem
  helpers; neither launches PowerShell during normal tracking. The SSH child
  remains hidden. Its job object closes its entire telemetry process tree when
  stopped; replacement waits for the old worker to exit. **Misty Codex Relay**
  stays separate and was not restarted for this feature.
- VM service: **misty-activity.service**, enabled at boot, restart on failure,
  96 MB memory ceiling and 15% CPU quota. Misty's existing bot/supervisor owns the
  decision workflow; its supported graceful self-update restart was used.
- VM raw metadata: `/var/lib/misty-bot/laptop-activity.sqlite`, rolling 24-hour logical
  retention from the October 28 owner request, pruned every minute. Expired older
  observations cannot be recovered. Freshness and the 15-minute commentary summary
  are unchanged. Windows offline outbox: at most 240 samples or
  two hours, newest first. Duplicate IDs do not update original receipt times.
  Local Chrome caches expire after two hours. Private state is restricted to the
  Windows owner/SYSTEM and VM service user. Last-check state and 12 workflow run
  records are bounded; comments actually sent remain in the existing private DM
  and normal assistant history.

Windows recovery commands:

```powershell
Get-ScheduledTask -TaskName 'Misty Laptop Activity'
Stop-ScheduledTask -TaskName 'Misty Laptop Activity'
Start-ScheduledTask -TaskName 'Misty Laptop Activity'
```

## Verification and rollback

Focused tests:

```powershell
node --disable-warning=ExperimentalWarning --test app/tests/laptop-activity.test.mjs app/tests/misty-messages.test.mjs app/tests/misty-direct-codex.test.mjs
```

On Linux, run `python -m unittest -v test_laptop_activity` in the staged fork.
The eleven decision/scheduler tests use temporary stores and synthetic notification
sinks; no test DM is sent. `scripts/verify-misty-laptop-activity.py` checks the live
authenticated reader/ingestion, duplicates, actual Misty CLI, a silent dry-run and
a tool-free synthetic model decision. It writes sanitized evidence, never raw
titles or URLs, to the deployment staging directory.

Fresh provenance verification from the laptop (without republishing samples):

```powershell
node --disable-warning=ExperimentalWarning scripts/verify-laptop-activity-trace.mjs
```

This observes a new native-cache/outbox sample from the running collector, matches
its payload and Chrome metadata hashes to the VM database and actual Misty reader,
and checks the original collector acknowledgement. It also verifies extension
registration/profile coverage, scheduler state, deployed hashes and clock-skew
freshness boundaries. It never calls a messaging or Codex execution tool.
Sanitized evidence: `data/deployment/misty-laptop-activity/fresh-chrome-trace.json`.

Original affected VM files and pre-change workflow evidence are in
`/var/lib/misty-prominence/laptop-activity-before-20261023T162238Z`.
Supported fork snapshot: `/var/lib/misty-prominence/versions/20261023-162238`.
Hashes and evidence: `data/deployment/misty-laptop-activity/` on the laptop.

Rollback is scoped: stop/disable the new Windows task and new VM activity service;
remove only `laptop-activity-15m` under the workflow store lock; restore only the
affected files from the backup and gracefully restart the fork with
`selfupdate.py restart`. Restore the original SSH helper file for future SSH
connections. Do not restart the running Codex relay or overwrite the complete
workflow/focus databases. The pre-change workflow copy is evidence, not a file to
restore wholesale. Native-host removal, if wanted, removes only its named HKCU
registration and this feature's private files; the Chrome extension can be disabled.

## Files changed for this feature

Existing files extended:

- `scripts/misty-relay-agent.mjs`
- `prominence/bot.py`
- `prominence/misty.py`
- `prominence/misty_context.py`
- `WORK.md`

New files:

- `app/laptop-activity.mjs`, `app/laptop-activity-local.mjs`,
  `app/laptop-activity-server.mjs`, `app/chrome-native.mjs`
- `app/tests/laptop-activity.test.mjs`
- `scripts/collect-laptop-activity.ps1`
- `scripts/misty-activity-agent.mjs`, `scripts/misty-activity-control.mjs`,
  `scripts/misty-activity-ingest.mjs`
- `scripts/start-misty-activity.ps1`, `scripts/install-misty-activity.ps1`,
  `scripts/misty-activity-job.cs`
- `scripts/misty-chrome-launcher.cs`, `scripts/misty-chrome-native-host.mjs`,
  `scripts/install-misty-chrome.ps1`
- `scripts/deploy-misty-laptop-activity.py`,
  `scripts/verify-misty-laptop-activity.py`, `scripts/verify-laptop-activity-trace.mjs`
- `deploy/misty-activity.service`
- `chrome/misty-activity/manifest.json`, `background.js`, `popup.html`, `popup.js`
- `prominence/laptop_activity.py`, `prominence/test_laptop_activity.py`
- `docs/misty-laptop-activity.md`

Generated private state/install files are under
`data/deployment/laptop-activity/`; sanitized evidence/source hashes are under
`data/deployment/misty-laptop-activity/`. Those directories are ignored by Git.

## Windowless startup and sampling - 24 October 2026

Replaced the scheduled task's PowerShell entry point with the compiled
`misty-activity-job.cs` launcher. The desktop metadata implementation now lives in
`scripts/misty-desktop.cs`, compiled as a GUI executable communicating over pipes.
`collect-laptop-activity.ps1` remains an optional manual diagnostic wrapper around
the same desktop implementation. Normal collection does not launch it.
`install-misty-activity.ps1` builds versioned windowless helpers, writes the private
`native-runtime.json`, and updates only the existing task action. Existing logon,
retry, single-instance, user and battery settings are preserved. `-PrepareOnly`
builds helpers without changing/starting the scheduled task. Chrome native
registration and the extension are unchanged; no extension reload is necessary.

Fourteen focused Windows/activity tests passed, including real repeated samples,
GUI executable subsystem checks, no visible sampler window, and terminating the
launcher closing its complete test process tree. Production verification confirmed
the task Running, no PowerShell/cmd collector children, zero visible main window
handles for its launcher/worker/sampler/SSH/console host, and a fresh sample read by
Misty with Chrome available (one profile, 33 tabs at verification). Capture and
receipt: 2026-10-24 07:22:29.648 UTC / 07:22:30.843 UTC. The relay stayed Running;
no VM deployment or restart was needed. Pause state/outbox integrity and existing
task settings were checked.

Source, original task XML and a consistent outbox backup:
`data/deployment/activity-hidden-20261024T072026Z/`. For rollback, stop only the
activity task, restore its backed-up source and original task action from
`task-before.xml`, then start that task. Keep live outbox/control state; the
storage snapshot is evidence, not a replacement for newer records. The deployment
manifest and sanitized local/VM verification are in the same backup directory.
