# Misty shared browser and desktop tools

Misty and her coding/analysis specialists use the existing durable laptop tool
broker. The broker records a work task, a session grant, and an immutable
operation ID before any worker acts. Misty can continue a chat while a delegated
task works. A completed specialist returns through the existing agent task queue.

```text
Misty / specialist MCP tools -> VM loopback broker + SQLite receipts
                                 |                 |
                    paired Windows worker    isolated VM worker
                    Browser Harness/Chrome    Playwright/Chromium
                    HCU/Windows desktop       independent browser context
                    existing Cline file/shell tools
```

## Task and session flow

1. `laptop_task start` records the objective, execution location and flags.
   Laptop file/shell work still uses a Windows workspace. A VM browser task uses
   `location=vm` and no laptop workspace.
2. `laptop_session open` binds a browser tab or the desktop focus resource to
   the task. The grant sets read/action scope, allowed hosts or apps and the
   maximum number of actions in one call. Opening a Chrome tab starts with
   `browser_run` and `new_tab`; an existing tab can be named by target ID.
3. Inspect first, act in short batches, then inspect the receipt. Calls have a
   stable operation ID; a timeout does **not** authorize a second execution.
   `laptop_result` reports the original operation's state.
4. Misty or the supervisor can hand an owned session to a verified child task.
   The broker checks the child in `agent_tasks.sqlite`, narrows the grant, and
   transfers ownership. The child sees the assigned session in its context
   packet. The parent can reclaim after the child finishes and no operation is
   unresolved. A different agent cannot act in that tab or desktop focus.
5. Cancel a session or task to release its ownership. Expired sessions release
   their resources. The worker never replays an operation that began before a
   restart; it returns `unknown` until the outcome is inspected.

Browser Harness uses one local Chrome daemon and switches its attached tab
serially; the paired Windows worker handles one operation at a time. HCU runs as
one persistent MCP process in the logged-in user session, preserving accessibility
refs between calls. The separate VM worker claims only `route=vm` operations and
keeps its own Chromium storage state in `/var/lib/misty-bot/vm-browser-sessions`.
Its browser can run while the laptop is offline. [Browser Harness usage](https://github.com/browser-use/browser-harness/blob/main/SKILL.md)
and [HCU's MCP contract](https://github.com/microsoft/Hybrid-Computer-Use/blob/main/docs/MCP.md)
describe the underlying adapters.

## Tools

| Tool | Purpose |
| --- | --- |
| `laptop_session` | Open, inspect, hand off, reclaim or cancel a session |
| `laptop_browser_inspect` | List tabs, inspect page/AX nodes or capture a screenshot |
| `laptop_browser_run` | New tab, navigate, click, type, key, scroll or wait, up to eight actions |
| `laptop_desktop_ax` | HCU apps, observe, find and bounded action steps |
| `laptop_desktop_gui` | HCU screenshot, zoom and bounded desktop input |
| Existing `laptop_*` | File, search, shell, fetch, patch and editor tools stay on the same worker |

The browser and desktop adapters accept structured actions, not arbitrary
Python, JavaScript, CDP calls, or agent supplied MCP server commands. Known
mail and messaging sites are refused for browser actions. HCU refuses input
to browser and messaging windows; generic desktop input is limited to a
non-browser app visible to HCU. Personal messages and emails must still use
Misty's exact preview and fresh owner confirmation sender. Generic shell and
native UI access cannot provide a perfect technical guarantee against every
possible indirect send, so the existing agent instructions and owner task
boundary also apply.

## Runtime setup

- On Windows, install Browser Harness in the logged-in account and enable
  Chrome remote debugging in `chrome://inspect/#remote-debugging`. Chrome may
  show an Allow prompt. Browser Harness is installed locally as version
  0.1.13; its recording preference remains off. If a later Chrome instance
  disconnects, check that browser setting again.
- Build HCU's Windows `computer-use.exe` and provider from the pinned HCU
  source, placing both under `data/deployment/hcu-build/windows`, or set
  `MISTY_HCU_EXE` for the scheduled worker. HCU must run in the unlocked
  interactive user session. Its read-only `AX apps` and `GUI screenshot` probes
  verified the local build.
- On the VM, install `playwright-core` matching `package.json`, download its
  Chromium headless shell, and provision a distinct `vm-browser-token` for
  `misty-laptop-tools.service` and `misty-browser.service`. Both services bind
  through VM loopback. The browser service has access only to Misty's private
  state directory.

The implementation is in `app/laptop-tools-broker.mjs`,
`app/shared-tool-sessions.mjs`, the two browser executors, `app/hcu-adapter.mjs`,
and the existing Windows worker. The worker credential is selected by the HTTP
Authorization header, never by an agent supplied role field.

## Verified rollout on 4 November 2026

- Scoped VM source and service backup: `/var/backups/misty/shared-tools-before-20261104T152836Z`.
  The broker, agent worker and VM browser services became active; authenticated
  broker status reported both workers online and ten executable primitives.
- Follow-up backups for the tool instructions and long task handoff are
  `/var/backups/misty/shared-tools-prompt-followup-20261104T153403Z` and
  `/var/backups/misty/shared-tools-handoff-followup-20261104T153557Z`.
- The VM Playwright browser loaded `https://example.com/`, returned the page,
  and resumed the same session target after executor restart. The paired
  Windows HCU process returned a live app inventory and compressed screenshot.
  Browser Harness attached to logged-in Chrome, listed nine tabs, then opened,
  read its accessibility nodes, captured a screenshot and closed only its own
  `example.com` probe tab.
- Local tests cover exclusive tab/desktop ownership, narrowed handoff, later
  owner-turn reclaim, worker credential routing, immutable receipts, HCU app
  binding and existing file/shell behavior. No test direct message was sent.
