# pi-jev-navigator

Context routing for Pi Coding Agent using TypeSafe Jev: code directories, SOP skills, and Hermes memory guards are selected before the main agent runs.

## Behavior and safety boundaries

- **Request-local navigation:** selected subsystems, full skill paths and memory rules are appended to the latest user message sent to the model. Original persisted messages are never rewritten. Frozen navigation tails are saved as non-context custom session entries and replayed on their original user messages.
- **Fixed native skill policy:** the first prompt freezes the session's catalog policy in a non-context `jev-skill-policy-v1` entry. Sessions started with skill routing enabled omit the native catalog before routing, even on missing credentials, bypass, timeout or cancellation. Routing outcomes and later config/flag changes cannot flip this policy. Reload restores it; changing the policy requires a new session.
- **Whole-run lifetime:** guidance survives tool batches, retries and recovery until Pi's `agent_settled` event. Sessions are isolated and superseded decisions are discarded.
- **Fail-open:** missing credentials, cancellation, invalid responses and request failures add no new navigation; historical tails and the fixed catalog policy remain intact. A failed decision is not interpreted as “select no skills”.
- **Independent controls:** starting a session with skills disabled retains native skills and disables Jev skill selection. Mid-session switches change routing, not the frozen catalog policy. Disabling tail injection disables automatic routing; `/jev-eval` remains an explicit diagnostic command.
- **Credential boundary:** only trusted global configuration, environment variables, or explicit library-constructor options can configure credentials and endpoints. Project `endpoint`, `apiKey` and `keyFilePath` are ignored with diagnostics. HTTP redirects are rejected.

The extension protects Jev-owned historical prefixes by keeping its catalog policy fixed and replaying frozen navigation tails. This does not guarantee upstream cache hits: other extensions, host/provider serialization changes, compaction, model/account changes and server-side eviction can independently affect cache.

## Pipeline

```text
before_agent_start
  → collect graph/skill metadata; retrieve bounded scoped memories from Hermes SQLite
  → estimate serialized payload tokens
  → unified request OR parallel Track A (overview) + Track B (skills/memory)
  → capacity batches preserving independent candidate verdicts when a track is too large
  → validate every answer against its request criteria
context_with_system (every model request)
  → keep system prompt and native skill catalog unchanged
  → freeze the current user tail once in non-context session metadata
  → replay unchanged tails for all retained user messages on the active branch
agent_settled / session_shutdown
  → clear volatile run state; durable historical tails remain replayable
```

Directory and skill candidates are sent in full: there is **no client-side keyword or semantic pre-filter**. Candidate IDs are collision-free within a request. Pi's canonical skill catalog supplies package/custom-path and resource-selection behavior; learned Hermes SOPs supplement it without overriding native names. Standalone library usage also supports recursive directories, symlinks, YAML frontmatter, explicit paths and literal skill paths from settings. Manual-only skills are not auto-selected.

Memory routing uses a **read-only Hermes SQLite/FTS5 adapter**, not a full Markdown dump. It reads the configured Hermes `memoryDir` (including the legacy-directory alias) and separates global/current-project searches; linked worktrees inherit the main project identity. The adapter recognizes the `memories` + trigram `memory_fts` schema; Hermes currently exposes no stable extension-to-extension search API, so unknown schemas are bypassed rather than migrated or repaired.

Bounded lexical queries use task identifiers and mechanical Chinese trigram segmentation, without topic dictionaries or hardcoded synonyms. Optional keyword expansion (`enableKeywordExpansion`, default enabled) invokes a lightweight upstream (`gemini-3.5-flash-lite`) over the native Gemini protocol (`/v1beta/models/...:generateContent`). This request enforces `thinkingBudget: 0` and `responseSchema` for pure JSON identifiers, using a constant `systemInstruction` and `X-Session-ID: jev-keyword-extractor` to anchor local CPA upstream connection pools. Extracted terms are quoted and merged into the SQLite query pool. An independent timeout (default 1,800ms) fails open in 0ms to base trigrams on any error or timeout. Identifier conjunctions, contextual clauses and Chinese fragments produce candidate lists; per-view leaders and reciprocal-rank fusion preserve lexical diversity. Correction/preference, failure-store and general-memory channels are interleaved across both scopes. This is **candidate recall, not semantic relevance evaluation**: only Jev may select final tail constraints. Lexical wording gaps and budget omissions remain possible; this does not guarantee exhaustive recall.

`memoryCandidateLimit` defaults to **64** and `memoryCandidateTokens` to **8K estimated tokens** for the complete serialized independent Noul memory questions. Whole records that do not fit are omitted, never clipped; candidate limits are separate from `maxInjectedMemoryGuards` (default **3**). Stable SQLite IDs deduplicate results without merging similar rules, and every retrieval sees a fresh read transaction. A missing, incompatible, corrupt, empty or locked database returns no memory candidates, **never a whole-Markdown fallback**; graph/skill routing may still proceed. The old Markdown collector remains only for standalone compatibility. No database writes, synchronization, consolidation or pinned-instruction re-injection occurs.

Cards/status/telemetry distinguish eligible store size, unique retrieved results, candidates submitted, selected guards, retrieval latency, budget omissions and estimated memory tokens. An eligible corpus of 1,800 records does not mean 1,800 records were sent.

### Cross-turn prompt-cache invariant

Request-local injection must also preserve **the entire historical wire prefix**, not just the system prompt. A user message that was sent with a navigation tail must retain that exact tail on every subsequent request. Navigator freezes the complete guidance string once (including Skill paths and complete Memory rules; telemetry is human-only) in a `jev-navigation-tail-v1` custom entry through `pi.appendEntry()`. These entries are not model messages; the raw user transcript stays untouched. Replay follows `getBranch()` and native message provenance, with entry IDs, timestamps and canonical content fingerprints. It never re-evaluates or reformats old packets. The initial user keeps its own tail even when steering arrives before the first request; steering never inherits that decision. Metadata publication failures freeze an empty tail, including when the host updates its in-memory tree before a disk write throws. If skill-policy metadata was not saved, reload recovers its omission state from existing structured system history where available. Older unstructured histories cannot prove that state; start a fresh session for a clean invariant.

New routing failures, disabled routing, steering and idle/cancelled contexts do not remove earlier tails. Mid-run steering prompts submitted during tool execution or model streaming are intercepted via `pi.on('input')`, evaluated in the background, bound to their own user turn in `context_with_system`, and frozen independently in the session ledger. Reload/resume restores them from the session tree; compaction replays only messages still present. Empty decisions are frozen too, and failed metadata persistence cannot publish a transient new tail. The same 256Ki-character guidance limit applies before publication and during replay: an oversized combined tail freezes absence rather than clipping constraints or emitting an unreplayable packet. A host that completely unloads the extension cannot replay its metadata. Old sessions created before this fix have no frozen packets: their exact missing tails cannot be invented, so the first request after upgrading may rebuild cache. Other extensions, model changes and upstream cache eviction can still invalidate cache independently.

### Auto routing and capacity

`auto` measures the complete serialized request's UTF-8 bytes, using **2.85 bytes/token**, and splits above **28,000 estimated tokens** when both logical tracks have inputs. **Track A contains repository overview only; Track B contains Skill metadata, retrieved scoped Memory candidates and safety constraints.** Both receive the current task. A 255-choice capacity overflow can also require batching below the byte threshold. Disabled/empty tracks do not cause an empty second stream.

Every outgoing request is checked against the estimated **32K per-request** and **255 options per choice question** limits. These remain calibrated estimates, not exact tokenizer guarantees. Oversized overview/skill tracks are mechanically partitioned without candidate truncation; Memory is already bounded by local retrieval before this capacity check. Track B evaluates each Skill/Memory candidate with an independent Noul and merges every signal; no batch Top-1 shortlist or cross-batch Choice-confidence ranking is used. Overview batches preserve every symbol record and merge evaluated directory coverage. An unsplittable task/record, forced oversized `unified` request, error or timeout fails open.

Cards, status and `/jev-eval` display **Unified versus Parallel** and per-track actual API input usage. Batched usage is explicitly labeled as an aggregate across requests. Telemetry stores estimated payload/track tokens separately from actual usage; two tracks never share a single 64K window.

All batches and arbitration rounds share a default deadline of **1,500ms** with a hard ceiling of **3,000ms**, respecting configured `timeoutMs` budgets up to 3,000ms, and a global four-request concurrency limit. Headers **and the response body** are bounded, cancellation propagates and responses are limited to 4 MiB. Local graph/skill/memory collection happens before this deadline and still includes synchronous filesystem/Git work; successful decision latency includes that collection, but this is not an end-to-end latency guarantee.

### Graph implementations

- The extension uses a compact **regex-based exported-symbol map** for Go, TS/JS (including TSX/JSX), Rust and Python. It is not a complete multi-language AST or call graph.
- The separate `jev-graph` CLI uses Go's AST parser for **Go files only**.
- GitNexus status can be inspected, but its analyzer and impact queries are not automatically part of the routing pipeline.
- Extension scanning limits actual supported-source read attempts (including files without symbols and failed reads), with a hard ceiling of 3,000; indexed-file statistics count only emitted symbol records.
- The symbol-map cache has a configurable TTL. Use `/jev-refresh` after source changes when immediate freshness is needed. Cache writes reject linked files/directories and path escapes, and use private atomic replacement; unsafe cache publication does not prevent routing with the generated in-memory map.

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

Project-local secret-file auto-discovery is intentionally disabled. `/jev-config` recursively masks credentials in objects and arrays, including unused project rules. Diagnostics and telemetry also redact known configured/resolved Jev keys if echoed in text. Redaction operates on detached copies, never on the configuration used for HTTP authentication. Toggle operations never copy global credentials into project configuration.

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
  "enableKeywordExpansion": true, // optional fast Gemini native keyword expansion
  "keywordModel": "gemini-3.5-flash-lite", // native protocol + 0 thinking + session affinity
  "keywordTimeoutMs": 1800, // independent extraction timeout before falling back

  "executionMode": "auto", // auto | parallel | unified
  "timeoutMs": 3000, // routing deadline budget (default 1500, max 3000)
  "memoryCandidateLimit": 64, // bounded local recall, hard ceiling 254
  "memoryCandidateTokens": 8000, // estimated serialized memory-question budget (8K)
  "maxInjectedSkills": 3, // independently applicable SOP tail output limit
  "maxInjectedMemoryGuards": 3, // Jev-selected tail output limit
  "skillApplicabilityThreshold": 0.75, // provisional Noul gate; calibrate on your tasks
  "memoryApplicabilityThreshold": 0.75, // same range: greater than 0.5, at most 1
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
| `/jev-toggle skills\|mem\|subsystems\|mode` | Persist a switch to the active project JSON/JSONC file |
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

### Independent Skill / Memory applicability

Each skill metadata record and each bounded, whole memory record gets its own `Noul`
against the current task. Structured question instructions carry candidate data separately
from the question, with explicit field references and symmetric true/false criteria.
Multiple candidates or none may apply. Noul answers contain `type` and `noul`, not a
`confidence` field; Choice and Score still require confidence. Capacity batches preserve
every question and merge all signals without batch Top-1 elimination.

`skillApplicabilityThreshold` and `memoryApplicabilityThreshold` default to **0.75**.
They accept finite values in **(0.5, 1]**; equality with the configured threshold passes.
Lower or uncertain signals are not injected. These are provisional conservative defaults,
not measured accuracy guarantees: calibrate thresholds on relevant and irrelevant tasks.
After filtering, output caps prefer higher Noul applicability signals; exact ties use
stable candidate identities rather than catalog order. This is not a proof of an optimal,
mutually complementary or conflict-free guidance set. Raw answers retain the signals for
validation, and historical tails are never re-ranked after publication.

`maxInjectedSkills` defaults to **3**; like `maxInjectedMemoryGuards`, it accepts a
non-negative safe integer, including **0** to suppress output without disabling evaluation.
For example, a documentation task may independently select `documentation-style` and
`link-checking`, each with its complete SOP path in the tail. Only metadata is sent for
skills; the agent reads selected SOP bodies on demand. Memory evaluation and tails retain
complete guidance. Every request is estimated separately against **32K**, and all batches
share the default **1500ms** deadline (configurable up to **3000ms**) and global worker limit. More questions increase payload and
may require more batches; estimates are not a service-tokenizer guarantee.
