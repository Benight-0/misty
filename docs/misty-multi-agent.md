# Misty multi-agent runtime

Misty remains the owner-facing `gpt-6.1-sol` agent at low effort. A coding worker uses high effort; an analysis worker and the scheduled supervisor use medium effort. Each role has a separate configurable model ID and instructions. No replies are selected from a fixed list.

## Runtime

- `prominence/agent_tasks.py` stores task provenance, objective, success criteria, context references, state, checkpoint, separate thread ID, lease, result, and stable key in `agent_tasks.sqlite`. Expired running tasks become `interrupted`; they are not replayed automatically after uncertain tool effects. Detailed task events and visible model traces expire after 30 days. Decisions, branch and release receipts, task state and results remain.
- `prominence/agent_runtime.py` runs as the separate `misty-agents.service` on the VM when `agent_runtime_external` is enabled. It has one worker per specialist role and an isolated supervisor loop. The coding and analysis workers return results to the coordinator. Misty consumes owner-origin results in her persistent app-server thread when direct owner chat is idle. A supervisor task assigned to Misty enters that same thread with supervisor provenance and may finish quietly.
- `prominence/supervisor.py` runs at most once per 30-minute interval and holds an exclusive lock. It uses durable source cursors for connected chat and Gmail journal events, Codex updates, verified owner inputs, and visible trace. It skips the model when there is no meaningful change. A failed or ambiguous run does not advance its cursors. The existing initiative plan and preference database is read in place; its 15-minute workflow is disabled when the supervisor is enabled. Explicit reminders stay on their separate workflow.
- Specialists can use the same searchable archives, shell, browser, and paired-laptop tools available to Misty. Their conversation MCP reports progress and outcomes to the coordinator; it does not publish to the owner. Delegated laptop calls carry the task ID, origin, original owner message when present, and a live lease. Third-party mail and messages cannot supply that authority. Personal-account sends still require the existing exact preview and fresh owner confirmation. Deletion and materially harmful actions still require the owner's explicit instruction or permission.

The supervisor sees visible messages, reasoning summaries, tool names and outcomes, plus decisions and handoffs. Raw private reasoning is not available. The desktop VM Trace panel shows role, task state, result and receipts, and has controls to pause initiative and stop individual tasks without deleting checkpoints.

## Flags and rollout

The flags in `/etc/misty-prominence/config.json` default off: `multi_agent_enabled`, `supervisor_enabled`, and `agent_runtime_external`. Set the last one to true when enabling `misty-agents.service`. `supervisor_read_only` defaults on. The role settings are `coding_model`, `coding_effort`, `analysis_model`, `analysis_effort`, `supervisor_model`, `supervisor_effort`; the existing `agent_model` and `agent_effort` configure Misty.

1. Deploy code with both enable flags off. Check syntax, unit tests, service status, owner DM, app Trace view, and archive bridge. Record the single-agent baseline with `python3 /opt/misty-prominence/agent_metrics.py`.
2. Enable `supervisor_enabled` while `supervisor_read_only` remains true. Verify one read-only review, cursor progress, quiet intervals, inherited pause state, and absence of duplicate notices. The sandbox and task MCP reject writes, delegation, and publishing in this phase.
3. Enable `multi_agent_enabled` and test a real owner-authorized coding and analysis handoff. Check direct chat while a specialist runs, task result in Misty's thread, restart recovery, and task stop. No test DM to another person is needed.
4. Turn off `supervisor_read_only` after the read-only review and specialist handoff checks pass. Initiative can operate with no registered projects, but supervisor coding tasks remain blocked until their project is registered. Automatic release is available only if that project has checks, deploy, health, and rollback commands. Otherwise the runner can push only a task branch for review. Changes to registered protected authority and send-confirmation paths require an owner decision.

On 2026-11-02, the VM reached step 4: the read-only supervisor review and a synthetic analysis worker task completed, and the service health checks passed. No project is registered yet, so autonomous branch publication and release are unavailable. The synthetic task did not send an owner message. The production flags are `multi_agent_enabled=true`, `supervisor_enabled=true`, `supervisor_read_only=false`, and `agent_runtime_external=true`.

Deployment backup: `/var/backups/misty/multi-agent-before-20261102T162916Z`. All 22 deployed source and service-unit files matched the canonical repository after the scoped fixes. The owner inbox, conversation and outbox counts remained 185, 74 and 164 through the synthetic worker check. Before the new roles processed owner requests, the available seven-day trace had a simple-reply median of 8.093 seconds and P95 of 8.474 seconds; this baseline contains only a few simple replies. The desktop Trace pause and resume controls were exercised and left resumed.

The first normal 30-minute supervisor review completed at 17:07 UTC with no source errors. It advanced the archive cursor from 32879 to 32880, the Codex cursor from 817 to 833, and the trace cursor from 6 to 9. One evidence-backed notice about newly arrived mail was sent through the owner outbox with a delivery receipt. There were no duplicate receipts, coding tasks, or project releases in that review. All five related services were active afterward.

## Project registration

Registration is an owner maintenance action. The project root must be the canonical root of a Git repository, and `repository` must equal its current `origin` URL. Commands are argv arrays with no shell interpolation. Example manifest:

```json
{
  "root": "/srv/my-project",
  "repository": "git@example.com:owner/my-project.git",
  "checks": [["npm", "test"], ["npm", "run", "build"]],
  "release": {
    "deploy": ["./ops/deploy-verified", "{commit}"],
    "health": ["./ops/health-check"],
    "rollback": ["./ops/rollback-last-release"],
    "protectedPaths": ["**/authority*", "**/confirmation*", "**/secrets*"]
  }
}
```

Register with `python3 /opt/misty-prominence/agent_projects.py register manifest.json --verify`. Verification runs the checks and existing production health check before storing the release recipe. Omitting `release` registers a project for isolated task branches and checked branch pushes only. The coding worker prepares and opens the isolated worktree before its model turn. It then commits there and uses `project_publish`; `project_release` records deployment and health or rollback receipts.

The pipeline always refuses to publish changes to Misty's control and personal-send files without an owner decision. A release recipe can add more protected path patterns.
For a small code fix handled by the supervisor directly, `project_prepare` binds the active review to one registered project and returns its isolated worktree. The supervisor then uses the same checks, push, release and rollback tools. It cannot bind to an unregistered project or switch to a second project within that review.

## Recovery and measurement

`agent_tasks.sqlite` and `owner_trace.sqlite` live in the existing protected Misty data directory. Keep them with the ordinary VM backup. An interrupted task retains checkpoint and visible receipts but needs reconciliation before continuation. `agent_metrics.py` reports quick reply latency, completed task duration, duplicate outbox receipts, unknown deliveries, and release/rollback counts; compare it with the baseline recorded before enabling flags. Cursor positions and source errors are visible in the coordinator database and Trace view.
