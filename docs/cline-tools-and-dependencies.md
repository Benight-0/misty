# Cline tools and dependencies: source audit for Misty's laptop harness

**Status:** documentation and static source inspection only. No tools have been added to Misty, no Cline dependencies have been installed, and no production configuration or service has been changed for this audit.

**Decision this supports:** keep Misty's existing conversation and model loop; expose selected Cline-derived operations directly to that loop through a laptop executor. Running Cline's own agent, delegating to a Cline model, and asking the existing Codex relay to do a task are separate architectures. This document examines the first option: reusing tools without adopting another agent.

**Navigation:** [architecture](#3-architecture-and-execution-contract), [default inventory](#4-default-tool-inventory), [read](#5-read_files), [search](#6-search_codebase), [commands](#7-run_commands), [fetch](#8-fetch_web_content), [patch](#9-apply_patch), [editor](#10-editor), [skills](#11-skills), [questions](#12-ask_question), [completion](#13-submit_and_exit), [optional tools](#14-optional-built-in-families), [teams](#15-the-18-team-tools-individually), [dynamic integrations](#16-dynamic-integrations), [CLI mode](#17-cli-specific-switch_to_act_mode), [browser and legacy names](#18-browser-control-and-older-tool-names), [dependencies](#19-dependency-matrix-for-extraction), [Misty extraction](#20-recommended-extraction-groups-for-misty), [tests](#22-upstream-test-pointers-and-future-implementation-checks).

## 1. Source, scope and how to read this document

| Item | Evidence |
| --- | --- |
| Upstream | [cline/cline](https://github.com/cline/cline) |
| Inspected revision | `40c5d99031fe1128189c5b52e40638d2b7787754` |
| Commit timestamp | October 23, 2026, 22:46:17 UTC-07:00; October 24, 2026, 11:16:17 Asia/Kolkata |
| Audit date | October 24, 2026 |
| Local source | `data/research/cline-source/`, a shallow, filtered, sparse checkout pinned to the revision above |
| Areas inspected | SDK packages, VS Code integration, CLI interactive runtime, Hub source, package manifests and license |
| Machine-readable companion | [cline-tools-source-manifest.json](cline-tools-source-manifest.json): inventories, declared package dependencies, source hashes, source links and validation results |
| Method | Follow registrations to factories, schemas, executors and host integrations; inspect implementation rather than assuming public tool names describe the current runtime |
| Verification limit | No upstream build, dependency install, executor execution, browser launch, model request or performance benchmark was performed. Existing test files are pointers, not passing-test claims. |

All source links below are pinned to the inspected commit. Future Cline versions can differ. The local checkout intentionally omits large documentation assets and unrelated application directories; this is not an audit of every third-party plugin, MCP server, desktop integration or released Cline version.

The official [SDK tools guide](https://docs.cline.bot/sdk/tools) and [public tools reference](https://docs.cline.bot/tools-reference/all-cline-tools) are useful background. For the inventory here, the pinned registrations and executors are the evidence. Public documentation and compatibility enums can retain older names.

**Evidence terminology:** “implemented” means the code exists at the pinned revision; “registered” means an inspected factory/runtime can expose it; “recommended” means a proposed Misty adaptation, not a capability installed by this task. Dynamic tools depend on the actual configured host and cannot be exhaustively listed from upstream source alone.

## 2. Main findings

1. **The primitive tool layer is separable from Cline's agent.** `createBuiltinTools()` constructs executors and tool objects and returns `AgentTool[]`. It does not construct an agent, start a session or call a model. Individual factories and executors are also exported. This is the main reuse point for Misty. [Tool exports and factory][tool-index]
2. **There are nine named default tool definitions, not nine tools always present.** Six Node executors are supplied by `createDefaultExecutors()`. Skills, questions and submission need host callbacks; editing alternatives are selected rather than both exposed. [Constants][constants], [executor factory][executor-index]
3. **The current VS Code integration uses the shared SDK tools too.** It adds IDE terminal behavior and MCP tools. An old `browser_action` enum member is not proof of a currently registered browser tool. [IDE runtime builder][vscode-runtime], [legacy names][legacy-tools]
4. **Most primitive tools contain no LLM call.** `fetch_web_content` even returns its analysis prompt as text rather than executing another summarizer. `spawn_agent`, configured agents and teammate runs explicitly introduce additional model loops. [Fetch executor][fetch-executor], [spawn tool][spawn], [configured agents][configured-agent]
5. **Copying executors does not copy the harness.** Approvals, policy hooks, remote delivery, reconnection, durable receipts, file boundaries and browser ownership still need a Misty host adapter. Directly calling `tool.execute()` bypasses Cline's agent-level approval path. [Agent execution path][agent-execution]

## 3. Architecture and execution contract

### 3.1 The useful extraction boundary

```text
Existing Misty conversation + its selected model
              |
     tool definitions + tool-call results
              |
Misty policy / authorization / authenticated laptop transport
              |
Laptop executor adapter
              |
Cline-derived file, search, command, edit and fetch implementations
```

This is a proposed boundary, not a new service deployed by this documentation task. The current Codex relay remains a separate way for Misty to delegate work to an existing Codex conversation.

Cline's relevant package split is:

| Package | Responsibility | Needed for a tool-only port? |
| --- | --- | --- |
| `@cline/shared` | Tool/context contracts, schema helpers, shell/path utilities and shared data types | Some contracts/helpers are direct dependencies. A port could preserve the API shape and vendor only the necessary helpers. |
| `@cline/core` | Default tool factories/executors, sessions, storage, configuration, extensions, Hub and telemetry | Tools live here; importing the package brings a broader declared dependency graph than any one executor. |
| `@cline/agents` | Model loop, tool orchestration, policies, events and agent lifecycle | Not needed as a second agent. Its approval/execution behavior is useful reference for Misty's adapter. |
| `@cline/llms` | Provider/model configuration, adapters and provider-native tools | Not intrinsically needed for filesystem/shell tools. Needed by Cline agent/provider integrations, including native web search. |
| `@cline/sdk` | Public facade over SDK functionality | Convenient for an SDK application; not the smallest extraction boundary. |
| VS Code extension / CLI / Hub | UI, terminal, account, runtime and client-specific integration | Host-specific. Misty would implement equivalent adapters only where required. |

Source: [SDK package boundaries][sdk-agents], [core manifest][core-package], [shared manifest][shared-package], [agents manifest][agents-package], [LLM manifest][llms-package].

### 3.2 Tool definition versus executor

An `AgentTool` has a name, description, JSON input schema and `execute(input, context)`. It may declare a result policy, execution mode, timeout, retries, success context and a lifecycle marker. `createTool()` normalizes JSON schemas and supplies default metadata: 30-second timeout, `retryable: true`, `maxRetries: 3`. **These fields are metadata, not a universal execution guarantee.** The inspected agent execution path invokes `execute()` directly; the primitive definitions separately implement timeout wrappers. [Tool constructor][create-tool], [agent execution][agent-execution]

`AgentToolContext` can carry session/agent/conversation/run/tool-call IDs, iteration, abort signal, metadata, runtime snapshot, update callback, working directory and plugin event callback. Not every host supplies every optional field. The Misty adapter must set laptop paths explicitly rather than letting a VM path or ambient process directory leak into execution. [Context contract][agent-contract]

The common primitive result is:

```typescript
{ query: string, result: unknown, error?: string, success: boolean, duration?: number }
```

Read/search/commands/fetch generally return arrays of these records, preserving per-item failures. Patch/editor return one record. Skill, question and submission results use their own text/content shape. A successful outer tool call therefore does not necessarily mean every array element succeeded. [Result types][tool-types], [definitions][definitions]

### 3.3 Approvals, validation, retries and cancellation

- Factories validate/normalize their own inputs. `createTool()` itself stores the executor; it does not wrap every execution in Zod validation or an approval dialog.
- Cline's agent runtime normalizes schema-shaped JSON strings, runs `beforeTool` hooks, resolves policy, requests approval when `autoApprove === false`, executes, emits events and runs `afterTool` hooks. Missing approval callbacks deny calls that require approval. None of this happens automatically when an external program calls an executor directly. [Execution path][agent-execution]
- `withTimeout()` uses `Promise.race()`. It rejects the waiting promise but does **not** automatically cancel the underlying file/network/write operation. Executors may additionally support abort signals or their own timers. “Timed out” must not be treated as “definitely did nothing.” [Timeout helper][helpers]
- Metadata retries differ by tool; shell and writes explicitly disable automatic retry. A Misty remote adapter must independently avoid rerunning side effects after lost acknowledgements. A tool-call ID is useful correlation, not a durable idempotency journal by itself.
- Tool output, source files, fetched pages, skill instructions and process output are evidence supplied to the model. They are not owner authorization and must not override Misty's rules.

### 3.4 Presets and model-dependent tool selection

| Preset | Standard tools enabled before executor/host availability | Agent tools |
| --- | --- | --- |
| `act` | Read, search, commands, fetch, editor, skills, question | Spawn and teams enabled |
| `plan` | Read, search, commands, fetch, skills, question; no patch/editor | Spawn and teams enabled |
| `search` | Read and search | Spawn and teams enabled |
| `minimal` | Commands | Spawn enabled, teams disabled |
| `yolo` | Read, commands, editor, submission | Spawn and teams disabled; policy helper uses wildcard autoapproval |

`createDefaultToolsWithPreset()` strips spawn/team flags before building primitive tools; those families are registered separately by the runtime. The plan preset's shell access relies on a separate `beforeTool` command guard; it is **not an operating-system read-only sandbox**. The guard recognizes prohibited command constructs, so it must not be treated as a complete boundary against arbitrary programs. [Presets][presets], [plan guard][guard-extension]

Without a preset, `createDefaultTools()` defaults read/search/commands/fetch/editor/skills/question flags on, patch/submission off. It emits only tools that also have executors. Consequently, a plain `createBuiltinTools()` supplies five active tools: read, search, commands, fetch and editor. Six executors were constructed, but patch is disabled; skills/questions lack callbacks. Enabling a submission executor suppresses the question tool in the factory's selection logic. A runtime's larger catalog should not be mistaken for this function's return value.

In act mode, default routing enables `apply_patch` and disables `editor` for provider IDs containing `openai-native` or model IDs containing `codex`/`gpt`, case-insensitively. This changes editing syntax, not the selected model. If both editing flags reach `createDefaultTools()`, editor wins. Host settings, mode, executor availability and dynamic registrations still determine the actual final tool list. [Routing][routing], [default factory][definitions]

## 4. Default tool inventory

| Model-facing name | Purpose | Built-in Node executor | Performs its own model call? | Default definition timeout / retry metadata |
| --- | --- | --- | --- | --- |
| `read_files` | Windowed text/image reads | Yes | No | 10s per item, 20s tool metadata; retry 1 |
| `search_codebase` | Regex search across workspace | Yes | No | 30s per query, 60s metadata; retry 1 |
| `run_commands` | Shell strings or direct executable calls | Yes | No | 30s per command, 60s metadata; retry disabled |
| `fetch_web_content` | HTTP GET and text extraction | Yes | No | 30s per request, 60s metadata; retry 2 |
| `apply_patch` | Add/update/move/delete using patch grammar | Yes | No | 30s; retry disabled |
| `editor` | Create/replace/insert text | Yes | No | 30s; retry disabled |
| `skills` | Load configured skill instructions | Host callback | No in the tool wrapper | 15s; retry disabled |
| `ask_question` | Ask one owner question with options | Host callback | No in the tool wrapper | No timeout declared by this factory; retry disabled |
| `submit_and_exit` | Submit final result and complete a run | Host callback | No in the tool wrapper | 15s; retry disabled |

Timeouts are configurable. This table separates wrappers/metadata from executor timers; do not add them together as guaranteed wall-clock deadlines. Definitions: [all factories][definitions], [schemas][schemas].

## 5. `read_files`

**Purpose.** Read several files in one call, with inclusive one-based line ranges. It returns bounded windows and can return images when the model supports them. It is not a directory listing or a PDF/Word parser.

**Advertised input:**

```json
{"files":[{"path":"C:\\project\\src\\main.ts","start_line":20,"end_line":80}]}
```

Ranges can be omitted/null. Runtime normalization also tolerates strings, string arrays, `file_path`/`filePath`, `paths`/`file_paths` aliases and numeric-string line bounds. An inverted range is rejected. Use the canonical object shape when building Misty's interface rather than relying on compatibility repairs.

**Implementation and results.** The definition runs reads concurrently, catches failures per file and reports query/result/success/duration. The Node executor uses `fs`, streams and `readline`, resolves existing paths with a shared Unicode-whitespace-aware path helper, checks file metadata and streams text. Relative paths resolve against `process.cwd()` in the standalone executor, despite the schema describing absolute paths. The VS Code override resolves relative paths against its supplied workspace. [Definition][definitions], [Node reader][read-executor], [VS Code reader][vscode-reader]

**Actual limits.** Text file admission uses `MAX_TEXT_STREAM_BYTES = 100,000,000`; the `maxFileSizeBytes` option's 10,000,000-byte default is used for image admission. Returned text is capped to 2,000 lines, 2,000 characters per line and 48,000 content characters per window, with explanatory metadata/markers. Unranged reads limit additional line scanning to 50,000 lines and can report an approximate total. These are not promises to deliver a whole large file. Line numbers are enabled by the actual default object, despite an older option comment saying otherwise. [Reader][read-executor], [output limits][output-limits]

**Images/cache.** GIF/PNG/JPEG/WebP are encoded as image content only when `context.metadata.modelSupportsImages === true`. `cline://` reads require the expected `ToolResultCache` in context metadata; the URI is a Cline cache reference, not a normal file. A miss must stay a miss rather than being silently replaced with unrelated content.

**Dependencies.** Node filesystem/streams/path/readline; shared storage path helper; Cline result-cache class for cache URIs. No ripgrep, Git, browser or LLM credentials are needed for ordinary text reads.

**Cancellation and policy.** Text streaming listens for abort; wrapper timeouts alone do not abort arbitrary custom executors. The reader is not a general workspace jail and does not itself implement Misty's owner access policy or credential-file exclusions.

**Misty adaptation.** Reuse windowing, range validation and output shape. Resolve Windows paths explicitly on the laptop; distinguish laptop files from VM paths; cap batch size and total returned bytes. Keep cache URIs unavailable until an equivalent cache exists. Image-file reading is a separate requested capability from the existing metadata-only activity collector.

## 6. `search_codebase`

**Purpose/input:** regex content search, using `{"queries":["createBuiltinTools","timeoutMs"]}`. This tool is not semantic search, an embedding database or an automatic “understand repository” model call. String/array compatibility inputs are normalized.

**Algorithm.** The executor caches ripgrep availability, uses `rg` JSON output when available, and falls back to a JavaScript `RegExp` search over a workspace file index. Queries run concurrently. Results include paths, line numbers, matches and context, plus a bounded readable representation. [Search executor][search-executor], [file indexer][file-indexer]

**Defaults and differences.** Default maximum is 100 matches per query, two context lines, 48,000 returned characters and a 10 Mi-character bound on buffered ripgrep output. The ripgrep attempt defaults to five seconds and uses `windowsHide: true`. The fallback uses extension/directory filters, a depth limit of 20 and case-insensitive multiline/global regex flags. It reads eligible files as UTF-8; there is no general large-file admission limit in the inspected fallback loop. Do not assume ripgrep and JS regex syntax, case behavior, ignore handling or every configured filter are identical.

The fast path specifically invokes `rg --json --context=<n> --max-count=1 -i <query>`. It therefore limits matching lines per file before the executor's overall result cap; it is not a promise to enumerate every occurrence. Both paths default to case-insensitive matching, but their regex/multiline semantics and file filtering can still differ.

The file indexer's fast path uses `rg --files --hidden -g !.git`; its fallback walks directories while excluding configured names. It avoids indexing the filesystem root/home as a normal project root. This is a file index, not a vector index, and it does not require Git merely to list/search files. Filesystem errors and stale indexes can limit coverage.

**Dependencies.** Node `child_process`, filesystem and path; shared output limits; workspace index/cache service. `rg` is the preferred optional executable. Without it, JS fallback is supported but can be much slower and consume more memory.

**Cancellation/retries.** Search and indexing check abort; the ripgrep child can be terminated and fallback returns/errors through the wrapper. The definition declares one retry, but a tool-only host must decide whether/how to honor that metadata. Concurrent unbounded queries and pathological regexes are not made harmless by the schema.

**Misty adaptation.** Reuse this for repository text search, not Misty's chat search. Pass a verified project root and explicit search budget. Keep file discovery, regex semantics and truncation visible to the model so “no matches” is not confused with complete semantic coverage. The existing chat archive/search subsystem remains separate.

## 7. `run_commands`

**Purpose/input:** execute non-interactive commands from an explicit working directory.

```json
{"commands":["git status --short","node --version"]}
```

The advertised schema is an array of command strings. Runtime normalization additionally accepts a string, arrays, `cmd`/`command` aliases and structured entries. A structured object executes directly **when it has an `args` property**, including an empty array; an object with only `command` is treated as a shell string. This distinction matters for quoting:

```json
{"commands":[{"command":"node","args":["--version"]}]}
```

**Execution.** `executeShellCommands()` starts independent commands concurrently and preserves result ordering. It repairs certain split heredoc inputs but is not a general shell-language compiler. The executor chooses platform shell invocation using shared helpers, or spawns a direct executable with argv. Supported shell handling covers PowerShell/cmd and POSIX-style shells, with Windows/Git Bash/WSL considerations. Commands inherit the host environment merged with configured overrides. [Command definition][definitions], [command executor][shell-executor], [normalization][helpers]

**Output/errors.** Stdout/stderr are combined by default, decoded across UTF-8 chunk boundaries and kept in a bounded rolling head/tail representation. The default output cap is 48,000 characters plus truncation markers. Typed failures distinguish spawn failure, command exit failure and termination; exit output is useful evidence and should not be discarded because the exit code is nonzero.

**Cancellation.** Abort and executor timeout attempt to terminate the process tree. Windows uses `taskkill.exe /PID ... /T /F` with fallback child termination; POSIX uses process-group behavior. `windowsHide: true` prevents the normal background child from flashing a console. It is not a guarantee that arbitrary launched GUI programs will remain hidden.

**Long-running commands.** The optional `RunCommandExecutionController` and registration hooks support detach/log behavior, process identity tokens, drain handling and cleanup. Default detached log retention is 24 hours in this implementation. This is not a ready-made authenticated remote job queue or durable “exactly once” command service. [Execution controller][command-controller]

**Dependencies.** Node process/crypto/filesystem/OS/path/string-decoder, shared shell resolution and process identity helpers, optional controller/log storage, installed executable and the selected shell. The tool does not install project dependencies or compilers automatically.

**IDE variant.** VS Code can replace the same `run_commands` name with visible shell-integrated terminals or a background SDK executor. Foreground behavior depends on `VscodeTerminalManager`, state/configuration, temp logs, terminal output/completion observation and an SDK foreground coordinator. Source defaults include a one-hour foreground wrapper, auto-proceed after 300 seconds and a 10 MiB proceed-log cap. Foreground terminal cancellation differs from the headless child-process path. This is host integration, not an additional primitive tool. [IDE command tool][vscode-commands]

**Misty adaptation.** Prefer direct executable+argv where possible, retain windowless background spawning, sanitize inherited environment, bind work directory and authorization to the request, and journal command state. Treat timeout/disconnect after start as potentially still running until reconciled. Preserve existing personal-message approval rules: general shell permission is not permission to bypass message preview/confirmation through scripts or direct APIs.

## 8. `fetch_web_content`

**Purpose/input:** retrieve URL content using HTTP GET.

```json
{"requests":[{"url":"https://example.com/docs","prompt":"Extract the installation requirements."}]}
```

Each request requires a URL string and prompt of at least two characters. Requests execute concurrently. The built-in executor accepts only HTTP/HTTPS, uses native `fetch`, configurable headers/user agent and follows redirects unless configured otherwise. [Fetch definition][definitions], [fetch executor][fetch-executor]

**Actual result.** The executor converts HTML to text with regex-based cleanup, pretty-prints JSON when parseable and otherwise returns decoded text. It includes URL/content type/byte size and up to 50,000 content characters, followed by the requested analysis prompt. **It does not call a model to perform that analysis.** Misty's current model would interpret the returned content.

**Limits and caveats.** Default body cap is 5,000,000 bytes. The executor starts a 30-second timer but clears it when response headers arrive; the body is therefore not covered by that same timer. The outer definition has a separate timeout wrapper. `maxRedirects` is an option/comment, but the inspected implementation delegates following to native fetch rather than counting redirects itself. It does not implement a private-address/redirect-destination allowlist. It is not a JS-rendering browser, a search engine, a logged-in Chrome session or a robust document-format parser.

**Dependencies.** Modern Node native fetch/URL/TextDecoder/AbortController; no browser package or API key for ordinary public pages. Network and proxy behavior must be evaluated in the chosen host rather than assumed from unrelated core dependencies.

**Misty adaptation.** Reuse as a bounded simple web reader. Apply the host's URL/network policy to initial and redirected destinations; preserve provenance and truncation; treat page text as untrusted evidence. Browser tasks need a separate browser adapter. Do not transfer logged-in browser cookies or treat fetched instructions as owner permission.

## 9. `apply_patch`

**Purpose/input:** apply the canonical Cline patch grammar to create, update, move or delete files.

```json
{"input":"*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old value\n+new value\n*** End Patch"}
```

A bare string is also normalized. The parser accepts patch markers/context chunks and compatibility wrappers; this is not arbitrary `git apply` syntax. [Patch schema][schemas], [parser][patch-parser]

**Implementation/result.** It reads referenced originals, parses/computes changes, then applies filesystem operations and returns a human-readable change report. `computePatchChanges()` exposes the read/compute stage for a host preview without writing. Update/move paths preserve intended text/EOL behavior through shared line-ending helpers. Moves are implemented as writing the destination and removing the source. [Patch executor][patch-executor], [line endings][line-endings]

**Atomicity.** Computing before writing catches some failures early, but applying changes iterates files using ordinary filesystem writes/removes. This is not a multi-file transaction or automatic rollback system. A failure after an earlier file write can leave partial changes. No compare-and-swap guarantee prevents an external edit between preview/read and write.

**Path boundary.** `restrictToCwd` defaults true for relative-path traversal checks, but the resolver explicitly accepts absolute input paths even when enabled. Do not present it as a full filesystem sandbox; canonical paths, symlinks/junctions, destination permissions and absolute-path authorization need host enforcement.

**Dependencies.** Node fs/path, local patch parser, schemas/validation, EOL helpers. No mandatory Git, VS Code, model credential or external patch binary. Wrapper default is 30 seconds, retries disabled; timeout does not roll back writes.

**Misty adaptation.** Strong candidate for the GPT-facing editing syntax. Preserve preimages/diff preview and bind writes to verified laptop paths. Add conflict detection, backup/rollback policy and durable operation receipts at the harness boundary rather than assuming Cline's executor supplies them.

## 10. `editor`

**Purpose/input:** create a missing text file, replace one exact occurrence or insert at a one-based boundary line.

```json
{"path":"C:\\project\\src\\example.ts","old_text":"const count = 1;","new_text":"const count = 2;"}
```

For insertion, omit `old_text` and use `insert_line`; `line_count + 1` appends. For a missing file, `new_text` is the new content. A null `old_text` is normalized to omitted. Existing-file replacement requires exactly one match; zero or several matches fail. Empty replacement text can delete a matched span, but there is no separate whole-file delete operation in this schema. [Schema][schemas], [editor executor][editor-executor]

**Limits/result.** The definition rejects `old_text` or `new_text` longer than 6,000 characters even though some schema descriptions call this a recommendation. The executor reads/writes UTF-8 text, creates parent directories, preserves line-ending conventions and formats bounded diff output (default 200 lines). Literal replacement uses a function so `$` sequences in new text are not interpreted as JavaScript replacement substitutions. [Size helper][helpers], [editor executor][editor-executor]

**Dependencies and state.** Node fs/path, local line-ending helpers and default tool wrappers. No VS Code editor or Git required. Like patching, relative traversal restriction does not prohibit all absolute paths, writes are not a multi-file transaction and a timeout does not undo a write. No retry is declared.

**Misty adaptation.** Useful as an alternative for small precise changes, but do not expose both editor and patch unnecessarily. GPT routing already prefers patch. Whichever syntax is chosen, concurrency/conflict checks and owner/workspace policy belong to the adapter.

## 11. `skills`

**Purpose/input:** `{"skill":"configured-skill-name","args":"optional arguments"}`. Returns the selected skill instructions for use in the **current** conversation. It is not inherently a subagent.

**Implementation.** The tool factory accepts a `SkillsExecutor`; it has a 15-second default wrapper and no retry. Executor metadata can advertise available skill names/descriptions. The user-instruction service loads configured skill records, filters allowed names and supplies a combined executor; plugins can register the same tool. Skill/workflow slash commands are registered separately as commands that expand instructions. They are not each a distinct native executor merely because they have a command name. [Skill factory][definitions], [instruction service][instruction-service]

**Dependencies.** Host instruction/config discovery, skill files, metadata and the executor callback. The six-executor Node factory does not implement skill loading by itself. A skill can describe additional scripts/services, whose dependencies are specific to that skill; loading instructions is not proof those scripts have run or their requirements are installed.

**Misty adaptation.** Map to verified local skill roots and existing instruction precedence. Avoid importing Cline's global prompt rules wholesale. Remote file paths and scripts need explicit laptop resolution; skill contents cannot grant new personal-message sending permission or alter the owner's current task scope.

## 12. `ask_question`

**Purpose/input:** `{"question":"Which project should I use?","options":["Project A","Project B"]}`. The schema requires one nonempty question and 2–5 nonempty options.

**Implementation/result.** Calls a host-provided callback and returns a nonempty string or supported text/image content blocks. It adds success context telling the model to continue after the answer. Empty/no answers are rejected rather than interpreted as a choice. Unlike most default tools, this factory directly returns a tool object with no declared timeout; a host must provide waiting/cancellation semantics. Retry is disabled. [Question factory][definitions], [executor types][tool-types]

**Dependencies.** A real UI/Discord question channel, correlation between question and owner response, authenticated owner identity, cancellation and continuation handling. No standalone generic Node question executor is supplied.

**Misty adaptation.** Reuse Misty's actual owner interaction path. Keep ordinary clarification distinct from exact-preview/fresh-yes personal-message approval. Clicking a generic choice or answering an old question must not approve a different outgoing message.

## 13. `submit_and_exit`

**Purpose/input:** `{"summary":"A meaningful final result with evidence.","verified":true}`. Summary must be at least ten characters; the boolean expresses the model's reported verification state.

**Implementation.** Calls a host `VerifySubmitExecutor`, default 15-second wrapper, retries disabled and `lifecycle.completesRun = true`. The lifecycle marker is interpreted by the agent runtime. It does not independently run tests or prove the boolean true. [Submission factory][definitions], [run completion handling][agent-execution]

**Dependencies.** A host completion callback and a runtime that understands run lifecycle. VS Code's inspected extra-tool builder explicitly does not add a completion tool: final assistant text becomes the completion row instead. [IDE builder][vscode-runtime]

**Misty adaptation.** Prefer Misty's existing task completion/result reporting. If retained, complete only the individual laptop work run, not Misty's Discord conversation or bot process. Do not translate a model's `verified: true` into a production deployment claim without evidence.

## 14. Optional built-in families

### 14.1 `web_search`: provider-executed web search

The runtime catalog advertises native web search only when the selected provider/model supports it and it is enabled. It is passed as model-tool intent and translated into provider-native requests. It is not a generic `search(query)` Node executor sitting beside the regex-search executor. Arguments/results and cost depend on the provider integration; some return provider tool events/citations. [Runtime catalog][runtime], [model tool contract][model-tools], [provider implementations][llms-builtins]

**Dependencies:** `@cline/llms`, provider adapter/model support, provider credentials/network and any provider tool charges. This is distinct from fetching an already-known URL. **Port decision:** use the existing Misty model client's supported search integration if needed; do not start Cline's model loop just to obtain search.

### 14.2 `tasks`: durable Todos and scheduled agent work

One tool selects a domain using `kind`. The top-level provider schema merges fields for compatibility, while execution validates the stricter domain-specific request. Retry is disabled. Todo support is optional; when the host omits it, only `kind: "scheduled"` is advertised/accepted. In the inspected builtin catalog, `tasks` is unavailable to CLI/VS Code client types and excluded in yolo mode; its presence elsewhere still depends on host registration. [Unified task tool][tasks], [runtime catalog][runtime]

| Domain | Operations | Main inputs | Result / dependencies |
| --- | --- | --- | --- |
| `todo` | `create`, `update`, `list`, `get` | Task ID/revision; type/title/description/instructions; workspace/global scope and paths; priority 0–5; assignee/model/mode; availability/expiry/automation eligibility; list filters and limit up to 500 | `{kind,ok,operation,task/tasks}` or structured error. Agenda manager/storage, session defaults, actor authorization and optional telemetry. |
| `scheduled` | `create`, `update`, `list`, `get`, `pause`, `resume`, `delete`, `run_now` | Schedule ID/type/name/prompt; exact `run_at` or five-field cron; IANA timezone; enabled/mode/system prompt; iteration/timeout/parallel limit; tags/model selection; list limit up to 200 | `{kind,ok,...}` schedule/execution data or structured error. Cron service, persistence, session workspace/defaults and scheduled agent executor. |

Todo `available_at` affects availability, not automatic execution. Agent-created Todos need approval; the tool does not expose an approve/start operation. Scheduled work starts a future agent session when due, so it is not simply a timer around an OS command. The implementation contains session/workspace scoping and mutation checks; Cline's task prompt further instructs explicitly requested schedules and interactive-user schedule changes. [Todo operations][todo-tool], [schedule operations][schedule-tool]

**Misty adaptation:** reference only initially. Misty already has reminders, initiative scheduling, current focus/work notes and approval semantics. Importing Cline's scheduler would risk duplicate jobs or a conflicting work board. Adapt to existing storage/services if a future requirement warrants it; documentation does not authorize replacing them.

### 14.3 `spawn_agent`

**Input:** `{systemPrompt, task}`. Creates a delegated agent using configured provider/model credentials and optional child tools. Returns final text, iterations, finish reason and usage. It is marked parallel, has a 300-second timeout declaration and disables retries. Abort is linked to the parent and observer hooks can report start/end. [Spawn implementation][spawn]

**Dependencies:** delegated-agent factory, config provider, `@cline/agents`/`@cline/llms`, model access, child tools and any approval callbacks/policies. **Port decision:** exclude from the initial tool-only harness. This is precisely the extra LLM agent the owner chose not to require for laptop work.

### 14.4 Configured agent tools: `subagent_<name>`

Configured agents generate model-facing tool names from sanitized configuration names, truncated/hashed to stay within 64 characters. Input is a nonempty `prompt`; configuration can select model/provider, instructions, skills, tools and iteration limits. Calls execute the configured delegated agent and return its result/usage. [Configured-agent implementation][configured-agent]

Names are dynamic; there is no finite fixed list. Child-agent policy inheritance must be inspected carefully: this implementation describes configured child tools as autonomous and does not simply inherit the parent's approval policy. **Port decision:** exclude from the initial no-delegation design, not merely rename these tools as ordinary executors.

## 15. The 18 team tools, individually

These are SDK multi-agent coordination operations, not Windows desktop automation. They use shared Zod schemas/result types, a requester identity, `AgentTeamsRuntime` and optionally persistent team storage. Teammate creation/execution connects to model configuration and delegated-agent loops. Registration can initially expose only spawn and unlock management tools later. Lead/role checks and runtime state affect availability. [Team factory][team-tools], [team schemas][team-schema]

Most team factories inherit `createTool()` metadata defaults of 30 seconds / retryable / max 3; `team_await_runs` declares a one-hour timeout. These declarations are not proof of a generic retry timer, durable delivery or idempotency. `team_run_task` has a specific in-flight sync deduplication map keyed by agent, not a universal persistent exactly-once guarantee.

| Tool | Inputs (`?` = optional) | Action/result and specific dependencies | Misty extraction assessment |
| --- | --- | --- | --- |
| `team_spawn_teammate` | `agentId`, `rolePrompt` | Lead-only teammate registration/spawn; returns agent ID/status. Needs delegated-agent configuration and child-tool factory. | Additional agent infrastructure; exclude initially. |
| `team_shutdown_teammate` | `agentId`, `reason?` | Lead-only shutdown; returns agent ID/status. Needs active team runtime/member lifecycle. | Not a general process killer. Exclude initially. |
| `team_status` | `{}` | Members/roles/status, task counts, unread mail, mission log count, active/queued runs and outcome counts. | Read-only team state, useful only if teams are adopted. |
| `team_task` | `action`; action-specific fields below | Create/list/claim/complete/block shared tasks; returns task/status or task list/readiness/dependencies. Needs team task store and actor checks. | Do not replace Misty's current work board. |
| `team_run_task` | `agentId`, `task`, `taskId?`, `runMode?: sync/async`, `continueConversation?` | Sync waits for a teammate response; async queues and returns run ID. Sync duplicates can join one in-flight call. Needs running teammate/model and run queue. | Delegated LLM work; exclude initially. |
| `team_cancel_run` | `runId`, `reason?` | Cancels one async run; returns run ID/status. Depends on run manager/cancellation. | Not a laptop command cancellation API. |
| `team_list_runs` | `status?`, `agentId?`, `includeCompleted?` | Returns run summaries with queued/running/completed/failed/cancelled/interrupted states, progress, leases and optional usage. | Team bookkeeping, not current Codex relay history. |
| `team_await_runs` | `runId?` | Waits for one/all active async runs and returns summaries; failed/cancelled/interrupted outcomes are errors. | One-hour declared timeout; requires runtime-owned runs. |
| `team_send_message` | `toAgentId`, `subject`, `body`, `taskId?` | Writes an internal teammate mailbox message; returns ID/recipient. | Not Discord/WhatsApp messaging; no owner-send authorization implied. |
| `team_broadcast` | `subject`, `body`, `taskId?` | Internal team broadcast; returns delivered count. | Not broadcast to contacts or servers. |
| `team_read_mailbox` | `unreadOnly?` (default true) | Returns mailbox records including sender/recipient, subject/body, timestamps and task link; the factory passes `markRead: true`. | Internal agent mail with a read-state side effect, not owner chat archive. |
| `team_mission_log` | `kind`, `summary`, `taskId?`, `evidence?`, `nextAction?` | Adds progress/handoff/blocked/decision/done/error entry; returns log ID. | Could inform future audit format; do not introduce competing notes storage now. |
| `team_cleanup` | `{}` | Lead-only team cleanup; fails while teammates are still running, otherwise returns status. | Not filesystem cleanup. Exclude initially. |
| `team_create_outcome` | `title`, `requiredSections?` | Creates an outcome with required review sections; returns ID/status/sections. Defaults: current_state, boundary_analysis, interface_proposal. | Structured team artifact tracking only. |
| `team_attach_outcome_fragment` | `outcomeId`, `section`, `content`, `sourceRunId?` | Attaches an evidence/content fragment; returns fragment ID/status. | Requires outcome store; no file write by that name alone. |
| `team_review_outcome_fragment` | `fragmentId`, `approved` | Records a fragment review decision; returns fragment ID/status. | This “approval” is not owner authorization for external actions. |
| `team_finalize_outcome` | `outcomeId` | Finalizes through required-section/review gates; returns outcome ID/status. | Not independent proof that code/tests passed. |
| `team_list_outcomes` | `{}` | Returns stored outcomes and statuses. | Useful only with team artifact infrastructure. |

`team_task` action details: create requires `title`/`description`, with optional `dependsOn`/`assignee`; list can filter `status`; claim requires `taskId`; complete requires `taskId`/`summary`; block requires `taskId`/`reason`. Some irrelevant create fields are reported as ignored. Team state and result schemas include dates, dependencies, status and identity rather than only a prose response. [Schemas][team-schema]

## 16. Dynamic integrations

### 16.1 MCP tools and resources

`createMcpTools()` asks a provider for descriptors, filters tool visibility, then creates one `AgentTool` per descriptor using its description and input schema. The executor calls the provider with original server/tool identity, arguments and context. Result policy is `cache-oversized`. [MCP wrapper][mcp-tools]

**Naming.** Default names combine `serverName__toolName`, sanitize to allowed characters and apply a hash when required by normalization/length. Maximum is 64 characters. The public name is an alias; preserve original server/tool identity for execution and receipts. [Name transform][mcp-names]

**Dependencies.** MCP provider/connection manager, the MCP SDK, configured stdio or network transport, server executable/service, its schema and any per-server credentials. Timeout/retry options are injected and can inherit constructor defaults; side-effecting third-party calls must not be retried solely because a generic wrapper says retryable. OAuth/resource support is part of MCP integration, not a universal guarantee that all servers support it.

**Resources are separate.** The provider interface can read resources, but the current default tool set does not separately register the old `access_mcp_resource` name. Do not infer a callable tool from an interface method or legacy enum.

**Port decision.** A useful future extension point. Reuse descriptors/transport concepts; expose only the configured tools Misty is authorized to use. A browser MCP server could provide browser operations, but it is a new dependency with its own permissions and behavior, not Cline's default fetch tool.

### 16.2 Composio connector tools

This extension discovers tools through Cline's hosted connector API and registers each slug lowercased as a tool name. The wrapper passes service-provided schema/description, declares a 120-second timeout and disables retries. Access is feature/account gated (`CLINE_COMPOSIO_BETA` in the inspected integration), with Cline API session/proxy dependencies. [Connector extension][composio-tools]

The allowlisted meta-tool family consists of:

| Source slug / exposed name | Role | Dependencies / boundary |
| --- | --- | --- |
| `COMPOSIO_SEARCH_TOOLS` / `composio_search_tools` | Discover relevant connector tools and schemas | Hosted discovery/API; not local code search. |
| `COMPOSIO_MANAGE_CONNECTIONS` / `composio_manage_connections` | Establish/manage connected-account flow | Hosted Connect Link/account authorization. |
| `COMPOSIO_WAIT_FOR_CONNECTIONS` / `composio_wait_for_connections` | Wait for requested account connections | Hosted connection state; owner completion may be required. |
| `COMPOSIO_MULTI_EXECUTE_TOOL` / `composio_multi_execute_tool` | Execute discovered connected-service calls | External account permissions and dynamic schemas; may have side effects. |

Schemas are supplied by the service; the source does not fix every downstream application's fields. Session creation has its own short timeout and the meta family is rejected if the expected group is incomplete. Additional connector tool names are dynamic. [Meta-tool discovery][composio-meta]

**Port decision:** exclude from initial local tool extraction. These are external hosted integrations, not private native Discord/WhatsApp session replacements. Existing owner approval and sender credential boundaries must not be bypassed through a connector.

### 16.3 Plugins, host contributions and skill commands

Plugins can register arbitrary tools with schemas/executors. The registry/sandbox wraps them with its lifecycle/timeouts and host capabilities. Host clients can contribute tools too. Neither has a finite universal upstream tool count. Inspect the actual configured extension and its own dependencies before claiming its tools are available. A plugin sandbox also does not automatically constrain every builtin tool's filesystem/network access. [Plugin registry][plugin-registry], [plugin sandbox][plugin-sandbox]

Skill/workflow slash-command expansions are distinct from executable tool registration. Custom host tools can replace builtins by name, so a final runtime inventory must retain tool origin, not just the string `run_commands`. The source manifest inventories the inspected fixed surfaces and records the dynamic families separately.

## 17. CLI-specific `switch_to_act_mode`

**Input:** an empty object. The interactive CLI registers this extra tool in plan mode. It sets pending mode-change state, updates the UI callback and completes the current run. The surrounding CLI then rebuilds the session and may auto-continue with act tools. It declares five seconds and no retry. [CLI mode tool][cli-mode]

The description requires a real user approval after presenting the plan; the executor itself primarily checks that mode is not already act and changes pending state. Its synthetic continuation text is generated by the CLI. That text must never be mistaken for a real owner's confirmation if porting this flow.

**Dependencies:** CLI config, pending-mode state, TUI callback, prompt resolution and session rebuilding. **Port decision:** do not port directly. Misty needs its own work-mode transition bound to actual owner authorization; changing a runtime mode cannot approve personal-account messages.

## 18. Browser control and older tool names

### 18.1 What is actually present now

The nine-tool default factory has no browser-click/type/screenshot tool. The inspected VS Code extra-tool builder adds MCP tools and a terminal override, and explicitly leaves completion to final text. Searches of the selected source did not establish a registered builtin `browser_action` executor in that runtime. This is a narrower claim than “Cline can never control a browser”: plugins, MCP tools or other hosts may add it. [Default exports][tool-index], [IDE builder][vscode-runtime]

A retained `BrowserSession` service does implement local/remote Chromium automation with Puppeteer: launch/close, navigation, coordinate click, typing, scrolling, console observation and screenshots. Screenshot output uses WebP with PNG fallback. It depends on browser state/configuration, browser discovery, Chromium installation detection/download helpers, logging/telemetry and browser lifecycle. **A service existing on disk is not evidence that a model currently has a tool for it.** [Browser service][browser-session]

Its Chrome-debug relaunch path uses a temporary `chrome-debug-profile` and debugging port 9222; local launch and remote endpoint attachment are separate flows. Copying these paths unchanged would not satisfy the existing requirement to preserve the owner's running Chrome profiles/session and avoid an exposed unauthenticated debugger. Browser adaptation needs an explicit session/transport design. The current activity extension reports metadata only; it is not a browser command harness.

| Browser-related dependency declared by VS Code package | Version range | Why it appears |
| --- | --- | --- |
| `puppeteer-core` | `^23.4.0` | Chromium page/session automation |
| `chrome-launcher` | `^1.1.2` | Chrome discovery/launch support |
| `puppeteer-chromium-resolver` | `^23.0.0` | Chromium resolution/download helper |
| `axios` | `1.20.0` | HTTP discovery/support code |
| `p-wait-for` | `^5.0.2` | Waiting/polling support |
| `playwright` | `^1.55.1` | Declared in extension development/test context; do not assume BrowserSession is implemented with Playwright |

These are manifest declarations, not an installed lock-resolved tree. Transitive dependencies and OS browser requirements would need validation during implementation. [VS Code manifest][vscode-package]

### 18.2 Compatibility names: map, do not blindly copy

The retained `ClineDefaultTool` enum contains these 25 identifiers. The table distinguishes explicit runtime-builder name aliases from names for which this audit did not establish a current default registration. An alias is an allowlist/name normalization mechanism, **not** automatic conversion of an old request's arguments into the new schema. [Legacy names][legacy-tools], [runtime builder aliases][runtime-builder]

| Retained name | Verified current relation / status |
| --- | --- |
| `ask_followup_question` | Legacy name; current default question tool is `ask_question`. No explicit alias in the inspected configured-agent map. |
| `attempt_completion` | Explicit name alias to `submit_and_exit`; host completion behavior still differs. |
| `execute_command` | Explicit alias to `run_commands`; old command shape is not automatically equivalent to its advertised array schema. |
| `replace_in_file` | Explicit alias to `editor`. |
| `read_file` | Explicit alias to `read_files`. |
| `write_to_file` | Explicit alias to `editor`. |
| `search_files` | Explicit alias to `search_codebase`. |
| `list_files` | Explicit alias to `run_commands`; no separate listing executor in the nine defaults. |
| `list_code_definition_names` | Explicit alias to `search_codebase`; no dedicated AST-definition extractor established in the default tool factory. |
| `browser_action` | Retained browser service/UI name; no current default model-tool registration established in inspected runtime. |
| `use_mcp_tool` | Current MCP wrapper exposes per-server/per-tool names instead of one universal dispatcher name. |
| `access_mcp_resource` | MCP resource interface exists; no separate default tool registration under this name established. |
| `load_mcp_documentation` | Legacy identifier; not registered by the inspected default factory. |
| `new_task` | Legacy identifier; not the current unified `tasks` schema merely because both concern tasks. |
| `plan_mode_respond` | Retained mode/UI identifier; not the current CLI `switch_to_act_mode` tool. |
| `act_mode_respond` | Retained mode/UI identifier; no separate default executor established. |
| `web_fetch` | Older name; current primitive is `fetch_web_content`. |
| `web_search` | Also an active provider-native model tool when supported/enabled; not a generic local executor. |
| `condense` | Retained context-management identifier; no default primitive factory registration established. |
| `summarize_task` | Retained identifier; no default primitive factory registration established. |
| `report_bug` | Retained identifier; no default primitive factory registration established. |
| `new_rule` | Retained identifier; configured rules/instruction loading are separate services. |
| `apply_patch` | Also a current default definition, selected by model/tool routing. |
| `use_skill` | Explicit alias to `skills`. |
| `use_subagents` | Retained identifier; current concrete families are `spawn_agent`, configured agents and teams. |

The same alias map also contains `bash -> run_commands` and `apply_diff -> editor`. This table does not assert every old Cline release behaved identically or that all retained UI paths are dead code; it only prevents treating historical names as a verified callable tool inventory today.

## 19. Dependency matrix for extraction

### 19.1 Per-tool dependency and side-effect summary

| Tool/family | OS/package prerequisites | Persistent/host state | Network / model | Filesystem or other effects |
| --- | --- | --- | --- | --- |
| Read | Node fs/streams, shared path helper | Optional result cache | None; model image support flag for image results | Reads approved files; returns content |
| Search | Node fs/process/path; optional `rg`; workspace indexer | File-index cache | None | Reads/searches workspace; spawns `rg` |
| Commands | Node child process; chosen shell; requested programs | Optional controller/temp logs | Command-dependent | Arbitrary effects of authorized command |
| Fetch | Modern Node fetch primitives | Optional configured headers | HTTP GET; no internal LLM | Downloads/transforms text in memory |
| Patch | fs/path, parser, EOL helpers | Host preview/backup recommended | None | Create/update/move/delete |
| Editor | fs/path, EOL helpers | Host conflict/backup recommended | None | Create/replace/insert |
| Skills | Instruction service/config/files | Config discovery/watchers | Skill-dependent after loading | Loads instructions; scripts are separate operations |
| Question | Host UI/owner response channel | Pending question correlation | Owner communication, not model delegation | Waits for actual response |
| Submission | Host completion handler | Run lifecycle | None in wrapper | Completes a work run |
| Native web search | Provider adapter/credentials | Model/tool settings | Provider network/tool billing | Provider search results/citations |
| Tasks | Agenda/cron manager/storage | Durable tasks/schedules/session scope | Scheduled execution may call model | Creates work state/future runs |
| Spawn/configured/team runs | Agent runtime/provider configuration | Child conversations/team runs/mailboxes | Additional LLM calls | Child tools can have their own effects |
| MCP | MCP SDK/server transport | Server connections/auth/cache | Server-dependent | Server-defined; not necessarily read-only |
| Composio | Cline account/hosted connector API | External account connections | External services | Connector-defined, potentially external writes |
| Browser service | Puppeteer/Chromium/discovery helpers | Browser/page/profile/connection | Web access; no internal LLM required for primitive action | Page actions, navigation, screenshots, lifecycle |
| CLI mode switch | CLI/TUI/session config | Pending mode and rebuilt session | Subsequent parent agent turn | Runtime control, not OS action |

### 19.2 Declared SDK dependencies versus the minimum port

The inspected packages declare Node **22 or newer**, ESM output and version `0.2.0` for the SDK packages. Upstream contributor instructions use Bun **1.4.2**. Those are upstream development/runtime requirements, not evidence that a standalone extracted executor requires the entire Cline build environment. Published exports point to `dist`; importing unbuilt source from this sparse checkout is not a verified installation method. [Core manifest][core-package], [source guidance][root-agents]

The machine-readable manifest includes complete declared dependency/peer/optional/dev maps for the inspected package manifests. Key `@cline/core` groups are:

| Dependency group | Declared examples | Required by every primitive? |
| --- | --- | --- |
| Internal SDK | `@cline/shared`, `@cline/agents`, `@cline/llms` using `workspace:*` | No. Contracts/helpers recur; full agent/provider modules are not logically required for every Node operation. |
| Validation/config | `zod ^4.3.6`, `yaml ^2.8.2`, `jiti ^2.7.0` | Zod/schema validation is used in tool wrappers; YAML/config loaders are host concerns. |
| MCP | `@modelcontextprotocol/sdk ^1.29.0` | Only MCP paths need its transport functionality. |
| General core services | `nanoid ^5.1.7`, `simple-git 3.36.0`, `ws ^8.20.0`, proxy agents, `proxy-from-env`, `node-machine-id` | Not universal executor requirements. Git/checkpoints, Hub/WebSocket, proxy and identity paths are broader services. |
| Telemetry | OpenTelemetry API/exporters/SDK; optional PostHog peer | Broader runtime integration. Do not silently enable telemetry when extracting tools. |
| Shared helpers | Shared package additionally declares `aws4fetch`, `jsonrepair`, `zod`, `zod-to-json-schema` | Actual import closure determines which are needed. |
| Model adapters | LLM package includes AI SDK/provider packages, optional external-agent provider peers and tracing integrations | Not needed to launch another model for primitive tools; Misty's existing model client should remain the caller. |

This is a dependency classification, not a claim about bundler tree-shaking or import-time side effects. Before choosing “import package” versus “vendor source,” build a small isolated adapter and measure the actual import closure, bundle, OS behavior and runtime footprint. Existing source uses internal module paths and workspace packages, so copying a single TypeScript executor verbatim is not generally sufficient.

### 19.3 What is not a separate model tool

Diff UI, checkpoints/Git snapshots, shell integration, context compaction, session persistence, provider routing, telemetry and transport are supporting services. Some are vital to a good harness, but none should be counted as an extra callable tool solely because an implementation directory exists. Cline-derived writes would not automatically acquire VS Code diff review or checkpoints outside that host.

### 19.4 Executor configuration reference

These options are supplied by the host when constructing executors, not free-form extra permissions a model can grant itself in a tool call. Separate wrapper timeout options live in `DefaultToolsConfig`. [Executor options][executor-index], [configuration types][tool-types]

| Executor / wrapper | Host options and effect |
| --- | --- |
| File reader | `maxFileSizeBytes` (image cap in this implementation), `encoding`, `includeLineNumbers`; text streaming uses its own constant limits. |
| Search | `includeExtensions`, `excludeDirs`, `maxResults`, `contextLines`, `maxDepth`; fast-path and fallback behavior must be evaluated separately. |
| Shell | `shell`, `timeoutMs`, `maxOutputChars`, deprecated `maxOutputBytes` alias, `env`, `combineOutput`, `executionController`, `detachedLogRetentionMs`, `processStartTokenProbe`. |
| Fetch | `timeoutMs`, `maxResponseBytes`, `userAgent`, `headers`, `followRedirects`, `maxRedirects`; the last is declared but not enforced as a custom redirect counter. |
| Patch | `encoding`, `restrictToCwd`; absolute paths remain accepted by its resolver. |
| Editor | `encoding`, `restrictToCwd`, `maxDiffLines`; same absolute-path caveat. |
| Tool definitions | `cwd`, `shell`, enable flags and per-tool timeout settings (`fileReadTimeoutMs`, `searchTimeoutMs`, `bashTimeoutMs`, `webFetchTimeoutMs`, `applyPatchTimeoutMs`, `editorTimeoutMs`, `skillsTimeoutMs`, `submitTimeoutMs`). |
| Skills / question / submission | Host supplies callbacks; there is no default implementation to configure through `createDefaultExecutors()`. |

For `createBuiltinTools()`, top-level `shell` wins over `executorOptions.bash.shell`; the resolved shell is used to align description and executor behavior. An overriding shell executor replaces the builtin wholesale and is responsible for honoring the described shell. `cwd` and abort context must be handled explicitly in overrides.

## 20. Recommended extraction groups for Misty

This section is an architectural assessment. It does not install or authorize the operations below.

| Group | Candidates | What can be reused | What Misty must supply |
| --- | --- | --- | --- |
| First primitives | `read_files`, `search_codebase`, `run_commands`, `apply_patch` | Schemas/normalization, bounded output, executors, shell/patch helpers | Windows-local dispatch, explicit cwd, authorization, event/progress reporting, cancellation, durable command/write receipts and conflict handling |
| Small optional primitives | `fetch_web_content`, alternative `editor` | Bounded fetch/text conversion or small exact edits | URL policy, output provenance, edit selection and same write controls |
| Existing-host adapters | `skills`, `ask_question`, completion | Input/result concepts | Misty's own skill/owner DM/run-completion paths |
| Separate browser stage | Browser primitives through a supported adapter, possibly MCP | Browser action concepts/session helpers where appropriate | Actual supported session attachment, profile preservation, origin/session permissions, observations, cleanup and action receipts |
| Reuse current Misty systems | Notes/work board/reminders/initiative | Task schema concepts only if useful | Existing durable stores and scheduler; no duplicate Cline scheduler |
| Not part of the no-delegation port | Spawn/configured agents/team model runs, Cline provider/session loop | Reference material only | Explicit future decision if extra agents are ever desired |
| Optional future external integration | MCP/Composio | Discovery/transport patterns | Per-server/service credentials and policy; no automatic expansion of access |

The same Misty model can choose a tool, receive its result and continue in the existing conversation. That satisfies the owner's “Misty working itself on the laptop” idea. Reusing tools does not require importing Cline's agent personality, replacing Misty's memory or starting another Cline/Codex session.

## 21. Host requirements that extraction does not solve

These are concrete integration gaps discovered by inspecting the source, not permission changes enacted by this document:

1. **Authenticated routing:** bind each request to owner, laptop, workspace, tool version, call ID and deadline through the existing private transport. Never accept a model-selected arbitrary public command endpoint.
2. **Operation state:** separate queued/started/completed/failed/cancelled/unknown. Sleep/reconnect must reconcile in-flight commands rather than replay edits or side effects blindly.
3. **File boundaries:** canonical Windows paths, junction/symlink handling, approved roots and protected files. Neither schema descriptions nor `restrictToCwd` is a full boundary.
4. **Concurrent edits:** record preimages or hashes, detect external changes and retain appropriate rollback. Do not overwrite unrelated owner edits.
5. **Cancellation:** propagate abort through transport to executor/process/browser. A Promise timeout is not proof of cancellation.
6. **Observation bounds:** batch/output/log limits, paging and explicit incomplete results. Preserve verified paths/URLs/line numbers as provenance.
7. **Owner interaction:** integrate existing Misty question/status/pause paths. General work-mode authorization cannot create a fresh yes for a personal-account message.
8. **Browser isolation:** agree session/profile/attachment behavior before browser actions. Preserve existing Chrome activity metadata reporting; do not convert it into page-body capture or expose a debugger implicitly.
9. **Runtime continuity:** keep existing Codex delegation, Apollo notifications/store-only discussion preferences, reminders and activity checks independent of a future direct-executor feature.

## 22. Upstream test pointers and future implementation checks

The companion manifest records discovered test paths next to the audited tool directories. They were **not executed**. Useful examples include tool definitions/schema/helper tests, file reader tests, search tests, shell and PowerShell tests, run-command controller tests, editor/patch/parser tests, plan-guard tests, team/schema tests and SDK agent-runtime approval/execution tests.

Concrete paths under `sdk/packages/core/src/extensions/tools/` include:

| Coverage area | Existing test files |
| --- | --- |
| Definitions / composition / presets | `definitions.test.ts`, `index.test.ts`, `presets.test.ts`, `runtime.test.ts`, `model-tool-routing.test.ts` |
| Read / search / edits | `executors/file-read.test.ts`, `executors/search.test.ts`, `executors/editor.test.ts`, `executors/apply-patch.test.ts` |
| Commands / Windows / detach | `executors/bash.test.ts`, `executors/bash.powershell.test.ts`, `executors/run-command-execution-controller.test.ts`, `helpers.run-commands.test.ts`, `shell-contract.test.ts` |
| Plan guard | `command-guard.test.ts`, `command-guard-extension.test.ts` |
| Delegation / teams | `team/spawn-agent-tool.test.ts`, `team/spawn-agent-concurrency.test.ts`, `team/configured-agent-tool.test.ts`, `team/delegated-agent.test.ts`, `team/team-tools.test.ts`, `team/multi-agent.lifecycle.test.ts`, `team/persistence-policy.test.ts` |

No dedicated `executors/web-fetch.test.ts` was found alongside the inspected executors. That is a coverage observation, not proof that no broader test covers fetching. The manifest lists test paths but does not evaluate their assertions or coverage percentages.

For a later Misty implementation, upstream tests are necessary reference but insufficient evidence of remote integration. Focused additional checks should cover:

| Area | Meaningful verification |
| --- | --- |
| Tool-only boundary | Primitive invocation makes no extra LLM/agent session; model/provider settings and existing Codex sessions remain unchanged |
| Files | Range/truncation/image flags, explicit Windows cwd, missing paths, protected roots, absolute/relative/junction escapes |
| Search | Real `rg` and fallback paths, ignore/case/regex differences, abort, truncation, absent/stale index |
| Commands | Direct argv versus shell parsing; hidden Windows spawn; stdout/stderr; nonzero exit; timeout; process tree; disconnect after start |
| Writes | Patch create/update/move/delete; unique replacement; CRLF; preimage conflict; partial multi-file failure; no blind retry |
| Fetch | Redirects, response cap, slow body, cancellation, private destination policy, untrusted page text |
| Host UI | Question ownership/correlation; no answer; cancellation; completion ends only the work run |
| Browser | Real supported session, no profile replacement/debugger exposure, observations distinguish active page from background metadata |
| Transport/state | Replay/deduplication, restart recovery, expiry, result size, honest unknown outcomes |
| Existing constraints | Owner-only access, Apollo restrictions, personal-message preview/fresh yes, reminders/focus/work notes and monitoring unchanged |

## 23. Reproducibility, license and audit completion

The companion manifest records the exact source revision, fixed names/families, hashes of cited source files, package declarations and test-path inventory. Its validator checks that all nine default names, all eighteen team names, all twenty-five retained legacy names and four Composio meta-tool identifiers are represented here; source-link targets exist locally; line anchors stay within their files; and the Markdown has balanced code fences. These are static documentation checks, not executor tests.

Cline's root license at this revision is **Apache-2.0**. A future source port should retain applicable license/copyright/NOTICE information, record modifications and review individual dependency licenses. Package/version declarations here do not replace a dependency-license review, and source reuse does not grant branding or unrelated service access. [Upstream license][license]

**Completed by this audit:** reproducible source checkout, fixed and dynamic tool inventory, detailed primitive behavior, individual team-tool reference, browser/legacy distinctions, declared dependency inventory and a Misty extraction assessment.

**Not yet done:** dependency resolution/build, an executor-only proof of concept, actual Windows/browser tests, package import/bundle measurements, remote protocol implementation or production deployment. The next implementation decision is whether to use the exported factories with controlled host adapters or vendor a small pinned executor/helper subset. Both can keep Misty as the sole decision-making model.

## Pinned source references

<!-- SOURCE_REFERENCES: generated from cline-tools-source-manifest.json by the documentation inventory script. -->

[tool-index]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/index.ts#L194-L227
[constants]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/constants.ts#L12-L23
[executor-index]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/index.ts#L97-L108
[definitions]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/definitions.ts#L268-L285
[schemas]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/schemas.ts#L57-L70
[tool-types]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/types.ts#L27-L51
[helpers]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/helpers.ts#L49-L63
[presets]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/presets.ts#L20-L34
[routing]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/model-tool-routing.ts#L60-L78
[runtime]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/runtime.ts#L43-L60
[guard-extension]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/command-guard-extension.ts#L39-L83
[read-executor]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/file-read.ts#L208-L285
[search-executor]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/search.ts#L332-L406
[shell-executor]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/bash.ts#L1133-L1182
[fetch-executor]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/web-fetch.ts#L98-L167
[patch-executor]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/apply-patch.ts#L316-L378
[patch-parser]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts#L1-L50
[editor-executor]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/editor.ts#L221-L268
[line-endings]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/line-endings.ts#L1-L37
[output-limits]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/output-limits.ts#L18-L50
[command-controller]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/executors/run-command-execution-controller.ts#L13-L43
[sdk-agents]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/AGENTS.md#L1-L65
[root-agents]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/AGENTS.md#L1-L34
[core-package]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/package.json#L1-L90
[shared-package]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/shared/package.json#L1-L67
[agents-package]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/agents/package.json#L1-L45
[llms-package]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/llms/package.json#L1-L92
[vscode-package]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/apps/vscode/package.json#L463-L542
[create-tool]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/shared/src/tools/create.ts#L81-L142
[agent-contract]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/shared/src/agent.ts#L194-L253
[agent-execution]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/agents/src/agent-runtime.ts#L2422-L2631
[vscode-runtime]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/apps/vscode/src/sdk/vscode-runtime-builder.ts#L68-L117
[vscode-reader]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/apps/vscode/src/sdk/vscode-file-read-executor.ts#L1-L27
[vscode-commands]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/apps/vscode/src/sdk/vscode-run-commands-tool.ts#L1-L95
[legacy-tools]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/apps/vscode/src/shared/tools.ts#L8-L34
[file-indexer]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/services/workspace/file-indexer.ts#L1-L95
[instruction-service]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/config/user-instruction-service.ts#L205-L276
[model-tools]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/shared/src/llms/model-tools.ts#L1-L40
[llms-builtins]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/llms/src/providers/builtins.ts#L1-L100
[tasks]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/tasks/task-tool.ts#L116-L204
[todo-tool]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/tasks/agenda-task-tool.ts#L47-L96
[schedule-tool]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/cron/service/schedule-tool.ts#L36-L110
[spawn]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/team/spawn-agent-tool.ts#L117-L204
[configured-agent]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/team/configured-agent-tool.ts#L1-L180
[team-tools]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/tools/team/team-tools.ts#L294-L358
[team-schema]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/shared/src/team/schema.ts#L1-L280
[mcp-tools]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/mcp/tools.ts#L17-L49
[mcp-names]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/mcp/name-transform.ts#L1-L35
[composio-tools]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/composio/composio-tools-extension.ts#L1-L214
[composio-meta]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/composio/composio-meta-tools.ts#L1-L125
[plugin-registry]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/plugin/plugin-registry.ts#L866-L945
[plugin-sandbox]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/extensions/plugin/plugin-sandbox.ts#L748-L842
[cli-mode]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/apps/cli/src/runtime/interactive/mode.ts#L31-L100
[browser-session]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/apps/vscode/src/services/browser/BrowserSession.ts#L38-L187
[runtime-builder]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/sdk/packages/core/src/runtime/orchestration/runtime-builder.ts#L105-L154
[license]: https://github.com/cline/cline/blob/40c5d99031fe1128189c5b52e40638d2b7787754/LICENSE#L1-L20
