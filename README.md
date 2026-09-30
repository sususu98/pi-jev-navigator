# ⚡ pi-jev-navigator

Context routing for Pi Coding Agent using TypeSafe Jev: code directories, SOP skills, and Hermes memory guards are selected before the main agent runs.

## Behavior and safety boundaries

- **Request-local navigation:** selected subsystems, full skill paths and memory rules are appended to the latest user message sent to the model. Persisted transcripts and the original user content are not rewritten.
- **Scoped pruning:** after a successful decision, only system skill sections are replaced with a stable catalog placeholder. User messages, tool results, tool schemas and tool-call arguments are never searched/replaced. There is no provider-payload mutation hook.
- **Whole-run lifetime:** guidance survives tool batches, retries and recovery until Pi's `agent_settled` event. Sessions are isolated and superseded decisions are discarded.
- **Fail-open:** missing credentials, cancellation, invalid responses and request failures leave native context unchanged. A failed decision is not interpreted as “select no skills”.
- **Independent controls:** disabling pruning keeps the native catalog while still adding guidance. Disabling skills keeps native skills and disables Jev skill selection. Disabling tail injection disables automatic routing and pruning; `/jev-eval` remains an explicit diagnostic command.
- **Credential boundary:** only trusted global configuration, environment variables, or explicit library-constructor options can configure credentials and endpoints. Project `endpoint`, `apiKey` and `keyFilePath` are ignored with diagnostics. HTTP redirects are rejected.

The extension does not guarantee provider prefix-cache hits. Successful routed requests use a decision-independent system catalog placeholder, but fail-open requests restore native context, and other extensions/providers may also change prompts.

## Pipeline

```text
before_agent_start
  → collect enabled inputs
  → estimate serialized payload tokens
  → unified request OR parallel Track A (overview) + Track B (skills/memory)
  → capacity batches and Jev shortlist arbitration when an individual track is too large
  → validate every answer against its request criteria
context_with_system (every model request)
  → replace system skill catalog only after routing succeeds
  → append cached navigation guidance, including full SOP file paths
agent_settled / session_shutdown
  → clear session-scoped decision
```

Directory and skill candidates are sent in full: there is **no client-side keyword or semantic pre-filter**. Candidate IDs are collision-free within a request. Pi's canonical skill catalog supplies package/custom-path and resource-selection behavior; learned Hermes SOPs supplement it without overriding native names. Standalone library usage also supports recursive directories, symlinks, YAML frontmatter, explicit paths and literal skill paths from settings. Manual-only skills are not auto-selected.

Memory entries use full-content hashes for exact deduplication. Metadata ranking organizes eligible global/current-project candidates without a routing cutoff; different rules sharing a title or prefix are not merged. The legacy `maxMemoryGuards` setting no longer truncates routing candidates. `maxInjectedMemoryGuards` (default 3) limits only the final Jev-selected tail constraints. Memory source fingerprints (inode, size, nanosecond mtime/ctime and mode) are checked on every collection, so edits, appends, deletes and new files invalidate immediately; unchanged files reuse their parsed blocks. The five-minute TTL refreshes metadata ranking, not memory visibility.

### Auto routing and capacity

`auto` measures the complete serialized request's UTF-8 bytes, using **2.85 bytes/token**, and splits above **28,000 estimated tokens** when both logical tracks have inputs. **Track A contains repository overview only; Track B contains Skill metadata, scoped Memory and safety constraints.** Both receive the current task. A 255-choice capacity overflow can also require batching below the byte threshold. Disabled/empty tracks do not cause an empty second stream.

Every outgoing request is checked against the estimated **32K per-request** and **255 options per choice question** limits. These remain calibrated estimates, not exact tokenizer guarantees. Oversized tracks are mechanically partitioned without candidate truncation. Track B winners are re-evaluated by Jev together (with bounded recursive arbitration if necessary); batch-local confidence is not treated as a globally comparable rank. Overview batches preserve every symbol record and merge evaluated directory coverage. An unsplittable task/record, non-converging shortlist, forced oversized `unified` request, error or timeout fails open.

Cards, status and `/jev-eval` display **Unified versus Parallel** and per-track actual API input usage. Batched usage is explicitly labeled as an aggregate across requests. Telemetry stores estimated payload/track tokens separately from actual usage; two tracks never share a single 64K window.

All batches and arbitration rounds share a deadline of at most **1,500ms** and a global four-request concurrency limit. `timeoutMs` can reduce this budget, not increase it. Headers **and the response body** are bounded, cancellation propagates and responses are limited to 4 MiB. Local graph/skill/memory collection happens before this deadline and still includes synchronous filesystem/Git work; successful decision latency includes that collection, but this is not an end-to-end latency guarantee.

### Graph implementations

- The extension uses a compact **regex-based exported-symbol map** for Go, TS/JS (including TSX/JSX), Rust and Python. It is not a complete multi-language AST or call graph.
- The separate `jev-graph` CLI uses Go's AST parser for **Go files only**.
- GitNexus status can be inspected, but its analyzer and impact queries are not automatically part of the routing pipeline.
- The symbol-map cache has a configurable TTL. Use `/jev-refresh` after source changes when immediate freshness is needed.

## Installation

Requirements for development: Node.js **22.19+**, Bun, Go **1.22+**. The extension targets Pi **0.87.1+** (pre-1.0 API compatibility should be checked on upgrades).

```bash
bun install
bun run build
bun test
bun run test:native
```

Install the local package through Pi:

```bash
pi install /absolute/path/to/pi-jev-navigator
```

Or keep the existing bundled-extension setup (do not install twice):

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf /absolute/path/to/pi-jev-navigator/dist/index.js ~/.pi/agent/extensions/jev-navigator.js
```

Run `/reload` after rebuilding. Building the bundle does not reload an already-running extension instance.

## Credentials

Supported sources, in priority order:

1. `apiKey` in trusted global config or explicit constructor options.
2. Explicit trusted `keyFilePath` (absolute path or `~/...`); an unreadable explicit file does not silently select a different account.
3. `TYPESAFE_API_KEY` or `JEV_API_KEY`.
4. `~/.pi/agent/secrets/jev.key`, then the legacy `~/.pi/secrets/jev.key`.

```bash
mkdir -p ~/.pi/agent/secrets
# Write your key to ~/.pi/agent/secrets/jev.key using your preferred secure editor.
chmod 600 ~/.pi/agent/secrets/jev.key
```

Project-local secret-file auto-discovery is intentionally disabled. `/jev-config` masks API keys. Toggle operations never copy global credentials into project configuration.

## Configuration

- Global: `~/.pi/agent/jev-config.jsonc` (or `.json`).
- Project overrides: `<cwd>/.pi/jev-config.jsonc` (or `.json`).
- JSONC supports comments and trailing commas without modifying string values.
- Saves preserve JSONC comments, write only the appropriate layer/explicit updates, and atomically replace files using exclusive no-follow staging files with `0600` permissions. Linked files (including hard links), linked parent directories, out-of-root destinations and protected global/key files are refused for project saves; directory identities are checked again before replacement.
- Home-directory project preferences default to `~/.jev-config.json`, never the legacy global `~/.pi/jev-config.json` fallback.

```jsonc
{
  // Endpoint and credentials are global-only, never trusted from a project.
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "model": "jev-latest",
  // "keyFilePath": "~/.pi/agent/secrets/jev.key",

  "enableTailInjection": true,
  "enableSubsystems": true,
  "enableSkills": true,
  "enableMemories": true,
  "enableSystemPromptPruning": true,

  "executionMode": "auto", // auto | parallel | unified
  "timeoutMs": 1500,
  "maxInjectedMemoryGuards": 3, // output limit, not a candidate cutoff
  "cacheTtlDays": 7,
  "logDecisions": true,
}
```

### Privacy

Enabled routing sends the user task and enabled catalogs to the configured Jev service. `logDecisions` records original prompts, selected guards and raw answers locally under `~/.pi/agent/jev-sessions/<project>/<session>.jsonl`. On POSIX systems, directories use `0700` and files use `0600` (Windows access control depends on the account's ACLs); multiple selected guards and token breakdowns are recorded. Set `logDecisions: false` if original prompts must not be retained. Automatic log retention/deletion is not implemented.

If an older version copied a global API key into project configuration, remove that legacy copy and consider rotating it if the file was shared or committed.

## Commands

| Command | Purpose |
| --- | --- |
| `/jev-status` | Inspect graph, Git/worktree metadata, credentials presence and switches |
| `/jev-config` | Inspect merged configuration with the API key redacted |
| `/jev-toggle skills\|mem\|subsystems\|pruning\|mode` | Persist a switch to the active project JSON/JSONC file |
| `/jev-refresh` | Rebuild the exported-symbol map |
| `/jev-eval <query>` | Run an explicit diagnostic decision |

## Native CLI and packaging

```bash
node scripts/jev-graph.cjs -root /path/to/go/project -out /tmp/map.dsl
```

The launcher selects a packaged binary for macOS, Linux or Windows on x64/ARM64. Invalid roots and output/read/write failures exit nonzero. Go syntax-invalid source files are currently omitted from the symbol map.

`npm pack` runs `prepack` to build the JavaScript bundle, declarations and all six native targets. The package declares its Pi extension entry explicitly. Local development requires Go/Bun to build; consumers of the published package do not need Go.

```bash
bun run typecheck
bun test
bun run test:native
bun run pack:check
```

Tests use isolated filesystem fixtures and offline transports. They cover lifecycle/role boundaries, images, failed routing, cancellation, response-body deadlines, credential origins, config persistence, collector identity, graph extraction and telemetry. No live Jev API is required.

## License

MIT © sususu
