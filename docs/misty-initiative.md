# Misty's own check-ins

Owner enabled 24 October 2026. Misty can choose to start a private conversation,
ask about current work, offer a useful thought or nudge about a confirmed urgent
deadline. It uses its existing lowercase dry voice and **gpt-6.1-sol / high**.
It does not pretend to be a human or invent experiences.

## Talk normally

- “Check in later about how the essay went.”
- “You can decide when to ask me about that.”
- “What check-ins have you planned?”
- “Stop checking in for now.” / “Resume your check-ins.”
- “Cancel that essay follow-up.”

Misty looks up the real saved owner message, focus item or note before saving a
plan. Rescheduling uses the same stable key. A plan means **consider checking in**,
not send mandatory text. Explicit reminders keep their existing behavior.

## Timing

The owner asked for no fixed limits. Misty chooses whether, when and how much to
say using current context and saved talking preferences. There are no daily quotas,
quiet hours, message/topic cooldowns, forced short replies, plan count limits or
seven-day planning horizon. It judges urgency from actual evidence rather than
a fixed deadline window. It must not invent progress or due times, nag, or repeat
an already delivered reminder.

One workflow, `misty-initiative-15m`, uses the existing worker's 15-minute polling.
The model chooses its next review interval without a policy minimum or maximum;
reviews/plans can wake the worker sooner (about 20-second worker resolution).
Changed owner evidence can prompt a new review. A review need not produce a text.
Missed checks are coalesced rather than replayed as a catch-up burst.

Tell it naturally "talk less", "be more chatty", or "leave me to work". Misty saves
updated preferences across restarts; it does not invent a numerical quota from
that feedback. Pause/resume remain available.

## Controls and state

Run on the VM using Misty's existing OS identity and config:

```text
python3 /opt/misty-prominence/initiative.py status
python3 /opt/misty-prominence/initiative.py list
python3 /opt/misty-prominence/initiative.py pause
python3 /opt/misty-prominence/initiative.py resume
python3 /opt/misty-prominence/initiative.py cancel KEY
python3 /opt/misty-prominence/initiative.py preference "Current owner talking preferences"
python3 /opt/misty-prominence/initiative.py plan KEY '{"task":"what to consider","source":"focus:REAL_ID","at":"FUTURE_ISO_TIME_WITH_OFFSET"}'
```

Natural requests in the owner DM use these controls. `pause` affects this feature,
not explicit focus reminders, laptop comments or Apollo's separate controls.

`/var/lib/misty-prominence/initiative.sqlite` holds active plans, saved talking
preferences, pause/review settings and delivery receipts. Active plans remain until
considered, rescheduled or cancelled; the legacy expires column has no expiry effect.
Finished plans, decision notes and receipts retain the existing 30-day storage policy.
SQLite and an exclusive check lock prevent duplicate concurrent runs. An attempt is
saved **before** Discord delivery; uncertain sends are not automatically retried.
Restart preserves workflow identity, plan times, pause and receipts.

The scheduled decision receives bounded current work, unexpired relevant notes,
recent owner messages and DM context, existing plans/reminders and recent
proactive texts. It has no tools. The runtime validates and saves permitted future
plans, rechecks pause/current evidence, and can only send a private owner response (split by the existing Discord transport if needed).
It cannot publish to a server, change commitments, operate apps, send Codex tasks
or message as the owner. Personal sends retain exact-preview/fresh-yes approval.

Apollo's discussion inbox remains store-only, and new Codex updates remain live.
This is not another archive watcher, activity observer or scheduled chat digest.
No access rules or model/helper routing changed.

Focused verification: `test_initiative`, `test_focus`, `test_laptop_activity`,
`test_activity`, `test_fork`. Tests use fake delivery callbacks, not test DMs.
Deployment manifests, model fixture and consistent backup location are saved in
`data/deployment/misty-initiative/`. Rollback restores source through the supported
self-update path; never overwrite live workflow state, focus or receipts.
