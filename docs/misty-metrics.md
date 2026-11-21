# Misty status dashboard

Website: **https://status.example.com** — live and publicly verified on 23 October 2026.
Origin on the VM: `http://127.0.0.1:8793`. No login is required.

The page shows estimated recorded API spend (all available history and today),
token usage by model, task cost shares, seven days of spending, CPU/memory history and used disk
space. Times use Asia/Kolkata. CPU and memory are sampled and fetched every five
seconds by a separate, unprivileged host sampler. The default graph shows the
last 15 minutes of these samples; select "Last 24 hours" for the durable history.
The usage collector still refreshes every minute, and the browser checks costs
every 30 seconds. Durable resource history uses five-minute chart averages with
30 days of private samples retained. Live history is held in bounded memory and
starts again after a dashboard service restart. Memory can stay steady naturally.

## Cost coverage

- Imports real response token records from the archive, old Misty bridge and
  Apollo, and per-request token counters from retained Misty Codex session logs.
- Deduplicates shared response IDs and repeated cumulative token events. Partial
  JSON log writes are retried on the next refresh. Previously imported counters
  remain in the private ledger when source logs later disappear.
- Adds a compact counter-only logger for future ephemeral Misty Codex runs.
  Existing running agent work is not interrupted; the next agent invocation
  loads the updated helper. No chat text is written to this usage file.
- Uses official Standard USD token rates checked on 23 October 2026, including
  recorded cached input, cache writes and the applicable long-context premium.
  Reasoning output is already part of output tokens and is not charged twice.
- Historical Node response tables do not contain cache-write/service-tier fields;
  their estimates use their recorded input/cached/output values and Standard rates.
  Ephemeral run counters describe an agent turn, so an unknown per-request context
  premium cannot be reconstructed. Unknown models are shown as unpriced.

These are **estimates from recorded VM usage**, not the account's complete billed
total. Missing historical/ephemeral calls, laptop Codex activity, API tools,
taxes and unreported cache-write charges may be absent. OpenAI's organization
Costs API requires an Admin key; the existing project key is not an Admin key.
No new API calls are made to populate this dashboard.

Official sources: [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini),
[Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs).

## Spend by task

Added 24 October 2026. The table shows estimated USD and each task's percentage
of **priced recorded spend**, across the same full history as the total:

- **Summaries & profile analysis**: archive summaries, history analysis and consolidation.
- **Apollo chat reviews & replies**: 50-message/15-minute server batches, DM/group checks
  and requested Apollo replies. Those calls share a historical usage ledger.
- **Misty conversations & agent work**: old bridge calls and current owner conversations,
  tool-assisted work, helpers and background checks. Those are recorded together.
- **Other / unclassified** appears only for an unrecognized source.

No model call or extra analysis is needed to build this table. Database searches
have no separate API charge in these logs; associated model calls remain in their
conversation/agent category. Finer historical attribution is not reconstructed
from private messages, prompts or timestamps. Unpriced usage is labelled and
excluded from the cost denominator, so percentages can describe only the known
priced subtotal. Categories sum to the existing recorded spend without duplication.
The endpoint adds only fixed generic category names and aggregate counters.

## Publishing

The owner saved this route. Public HTTPS checks returned the page, assets and
fresh metrics without a login or cookies; private paths returned 404.

In Cloudflare, open **Networking → Tunnels → archival-vm → Routes → Add route →
Published application**. Enter:

| Setting | Value |
| --- | --- |
| Subdomain | `status` |
| Domain | `example.com` |
| Path | Blank |
| Service type | `HTTP` |
| Service address | `127.0.0.1:8793` |
| Access protection | Off for this hostname |

Saving the published route creates its DNS record. The public site uses HTTPS
through Cloudflare; the local origin uses HTTP. The archive site's existing
Access configuration is separate.

## Runtime and privacy

- Source: `/opt/misty-metrics`; local source: `metrics/`.
- `misty-metrics.service`: small static HTTP server running as `misty-metrics`.
- Its background thread samples only `/proc/stat`, `/proc/meminfo` and filesystem
  counters every five seconds. `/resources.json` exposes these aggregate numbers
  with a real sample timestamp and at most 181 recent points, using `no-store`.
- `misty-metrics-collect.timer`: runs the read-only collector once per minute.
- Private usage ledger: `/var/lib/misty-metrics/metrics.sqlite`, root-only.
- Public snapshot: `/var/lib/misty-metrics/public/metrics.json`.

The public server serves a fixed allowlist of page assets and the aggregate JSON.
It has no credentials and cannot read the archive or bot state directories, both
by file permissions and its systemd namespace. No chat names, identities, message
bodies, prompts, request IDs, session IDs or file paths appear in the export.
There are no write/control endpoints, cookies, analytics, external fonts or chart
libraries. Only localhost listens; the existing Cloudflare tunnel publishes it.

The collector uses no network and does not modify any source database. Its
minute timer, private cursor ledger and atomic snapshot writes make refreshes
independent of public traffic. The web service is limited to 64 MiB RAM and
10% CPU; the short-lived sampler to 128 MiB and 20% CPU. At installation the
server used about 11 MB and a subsequent refresh used 0.22 CPU seconds.

## Checks and recovery

Eight focused metrics checks cover billing arithmetic, cache/long-context rates,
deduplication, partial log writes/restarts, interval CPU, IST dates, public export
boundaries, endpoint allowlists and the counter-only logger. The seven existing
fork checks also pass. Live HTTP, data, permissions and timer checks passed.
The shipped JavaScript also rendered the actual snapshot in a real DOM test:
seven spending bars, three model rows, CPU/memory paths and the empty-history
state passed. The live update test advances the five-second timer and verifies
that both numbers and the graph change without reload, that an older minute
snapshot cannot overwrite live values, and that the 24-hour selector works.
Browser visual verification requires an available browser session.

The deployment did not restart archive collection, analysis, either bot or the
Cloudflare connector. Agent source backup:
`/var/lib/misty-prominence/metrics-before-20261023T135003Z`. Deployment manifest:
`data/deployment/misty-metrics/deployment.json`.

To stop public metrics, disable `misty-metrics.service` and
`misty-metrics-collect.timer`, then remove only the `status` published route in
Cloudflare. Keep the private ledger if later resuming. Restore `agent.py` from
its backup only after checking for newer unrelated self-updates.

### Task-breakdown update evidence

11 focused Python checks passed, including task totals, shared-response deduplication,
persistence, unknown-source privacy, empty/zero/unpriced states and public route boundaries.
A DOM test rendered the real aggregate snapshot, checked task costs/shares and automatic
refresh, and handled empty/unpriced data without HTML injection. Public HTTPS assets and
aggregate totals were checked against deployed source. Browser automation was unavailable;
no visual screenshot verification is claimed.

This update changed only the metrics collector, its tests and static page assets. It did
not restart the bots or dashboard, modify their models, reset accounting cursors or alter
recorded usage rows. Consistent ledger and source backup:
`/var/backups/misty/metrics-tasks-20261024T063812Z`. Restore only source and rerun
`misty-metrics-collect.service`; retain the live ledger and cursors. Deployment and public
verification evidence: `data/deployment/misty-metrics-tasks/`.

### GPT-6 Luna pricing correction - 24 October 2026

The rate catalog omitted `gpt-6-luna`, so its counters were saved with NULL cost.
Added the [verified official rate](https://developers.openai.com/api/docs/models/gpt-6-luna):
Standard USD per million tokens: input 0.10, cached input 0.01, cache write 0.125,
output 0.50; existing long-context/tier arithmetic applies. Other model rates are unchanged.
The catalog date now means last updated.

Filled missing cost estimates for 135 existing per-response Node records (about $0.322264),
using recorded tokens and the existing Standard-tier assumption. Did not replay imports,
reset cursors, rerun models or overwrite previously priced costs. Future calls are priced
normally; repeated recovery changes nothing. Unpriced agent records with discarded tier
metadata are not guessed. Public verification showed 136 Luna records at about $0.325588
with zero unpriced records, and task totals matching overall spend. 13 focused tests passed.

Source and consistent ledger backup: `/var/backups/misty/metrics-luna-rate-20261024T064409Z`.
Restore source only; never replace the live ledger/cursors. A targeted cost reversal, if
needed, must join the backup by record ID and revert only originally NULL Luna costs.
Evidence: `data/deployment/misty-metrics-luna/`. No bot or dashboard restart/model changes.


### Seven-day CPU percentile - 24 October 2026

Added CPU 95th percentile for the rolling last seven days to the public status page.
Uses nearest-rank p95 of valid recorded minute CPU averages directly from durable
samples, excluding missing/invalid/future samples. Graph five-minute buckets and
live five-second values do not enter this calculation. Missing time is not zero.
Refreshes with the minute collector; the card shows sample count and available
history start, including when less than seven days has been collected. Empty
history displays Unavailable. Zero is valid. No new storage or telemetry source.

15 Python tests passed locally and on the VM. DOM checks using the deployed real
snapshot verified the percentile, available-history label, zero/empty handling,
automatic minute refresh and separation from live CPU updates. Public HTTPS
returned the new HTML, matching JS/CSS and p95 31.0% from 1,031 samples (about 17.4
hours at deployment). Browser visual inspection was unavailable; none claimed.
Source and a consistent ledger backup: /var/backups/misty/metrics-cpu-p95-20261024T071436Z. Deployment preserved all old usage
rows, CPU samples and cursors; protected bot/activity components unchanged and
eight service/timer units active. No bot or dashboard restart. Restore source
only and run misty-metrics-collect.service; retain the live ledger/cursors.
Artifacts and hashes: data/deployment/misty-metrics-cpu-p95/.
