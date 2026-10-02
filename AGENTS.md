# AGENTS.md — pi-jev-navigator Developer & Agent Guide
> End every completed task with a **喵**

`pi-jev-navigator` is a TypeSafe Jev (`jev-latest`) System One navigation and context governance extension for Pi Coding Agent. It provides compact CodeGraph overview routing, tail navigation injection, Hermes memory guard protection, dual-pipeline execution, and Git Worktree awareness.

## Core Product Goal

Support **Pi + Hermes Memory with large-scale Skill and Memory catalogs**. Jev must quickly identify the SOP skills and memory constraints relevant to the current task, then append compact, actionable guidance to the **user prompt's trailing context** so the main agent can act precisely instead of repeatedly exploring or rediscovering known procedures.

* Review and implementation priorities: **task-relevant coverage, routing precision, end-to-end latency, and actionable tail guidance**. Peripheral findings do not replace evaluating this core goal.
* Do not equate the goal with injecting every skill/memory body or dynamically reducing the system prompt. Freeze the native skill-catalog policy for the session before routing; never let a routing outcome change it.
* Skill metadata and relevant memory constraints are sufficient routing inputs; the final navigation packet should contain only the selected, useful guidance.

---

## Build, Test & Packaging Commands

```bash
# Build complete extension (TypeScript bundle, .d.ts types, and 6-platform native Go AST binaries)
bun run build

# Run complete automated test suite (161 unit & integration tests across 19 test suites)
bun test

# Verify package metadata, native cross-platform binaries, and Node.js runtime compatibility
node scripts/check-package.mjs
```

---

## Core Architecture & Inviolable Invariants

### 1. Prefix Cache Invariant (System Prompt Purity — Inviolable Forbidden Zone)
* **System Prompt is an inviolable forbidden zone — NEVER mutate or modify it dynamically**: Once a session starts, the Leading System Prompt must remain **100% bit-for-bit identical across all turns**. It is strictly forbidden to rewrite, regex-prune, filter, or dynamically add/remove system prompt content in any lifecycle hook (`before_agent_start`, `context_with_system`, etc.).
* **Strictly forbidden to dynamically inject or filter skills in System Prompt**: Never dynamically alter `event.systemPromptOptions.skills` based on Jev's activated skills in `before_agent_start` (e.g., injecting an active skill when present and emptying it when absent). Turn-by-turn variance in the leading system instruction breaks the upstream LLM LCP (Longest Common Prefix) Merkle root, destroys hundred-thousand-token Prefix Caches, and breaks session affinity across multi-account gateways.
* **Turn-invariant native skill policy**: Freeze the catalog policy on the first prompt in a non-context `jev-skill-policy-v1` session entry. Sessions started with skill routing enabled omit native skills (`[]`) before all routing early returns, including missing credentials, failure, bypass and cancellation. Sessions started with routing disabled retain the host catalog. Reload, branch navigation and mid-session config/flag changes must not flip this policy; start a new session to change it. This protects Jev-owned prompt state, not changes made by other extensions or provider adapters.
* **All dynamic guidance MUST strictly use Tail Injection**: Dynamic navigation packets (Target Subsystem, Recommended SOP Skill, Active Memory Guard, Risk Score) must **strictly and exclusively be appended to the user prompt's trailing context (`TailInjector`)**. The model loads recommended SOP skills on demand via standard `read` tool calls into the conversation flow, never by mutating leading system prompts.
* **Historical wire prefix invariant**: request-local tails must remain present, byte-for-byte, on their original user messages in every subsequent request. Freeze the complete tail once in non-context session custom entries (`jev-navigation-tail-v1`) via `pi.appendEntry()`; replay them bit-for-bit on the active branch during `context_with_system`. Never strip or recalculate old tails on settle, new prompts, bypass/disable, reload or resume. Cross-run Skill/SOP/tool-history prefix equality is a mandatory regression test.
* **Mid-run steering prompt isolation**: prompts submitted while models or tools run (`streamingBehavior` in `pi.on('input')`) evaluate concurrently in background without blocking the terminal. Guidance attaches strictly to that steering user message in `context_with_system` and freezes independently in the session ledger, never altering historical prefixes or leading system prompts.

### 2. Jev Relevance Evaluation, Skill Metadata & Memory Scope
* **Strictly forbidden**: Never hardcode client-side keyword regexes, manual topic cluster heuristics (e.g. `if (title.includes('grep'))`), or heuristic skill/directory slicing to guess task relevance. Jev performs relevance evaluation.
* **Skill metadata only**: send names, descriptions and locations to Jev; do not include complete SKILL.md bodies in routing requests. A selected skill's name/path and an instruction to read the complete SOP are valid tail guidance, not a missing feature.
* **Memory scope**: consider global memories and the current project's memories, including canonical project inheritance for linked worktrees. Exclude memories belonging to unrelated projects. This is required scope isolation, not prohibited semantic pre-filtering.
* **Hermes retrieval boundary**: scope eligibility is not permission to transmit the entire corpus. Use read-only SQLite/FTS5 lexical recall across global/current-project scopes, then bound candidates by count and serialized token budget before Jev. Generic tokenization, trigram queries, category channels and rank fusion are allowed retrieval mechanics, not client-side semantic relevance claims. No hardcoded topical keywords/synonym maps and no whole-corpus fallback on misses/errors.
* **Gemini keyword expansion with session affinity**: optional pre-retrieval keyword extraction uses `gemini-3.5-flash-lite` over the native Gemini protocol (`/v1beta/models/...:generateContent`). Must enforce `thinkingBudget: 0` and `responseSchema` for pure JSON terms, accompanied by constant `systemInstruction` and `X-Session-ID: jev-keyword-extractor` to anchor local CPA upstream connection pools and avoid cross-account proxy drift. Independent bounded timeout (default 1,800ms) fails open in 0ms back to baseline trigram lexical queries on any error or timeout.
* Objective metadata (Recency, Project Scope, Category Hierarchy) may organize eligible candidates, but metadata rank alone is not proof of task relevance. Distinguish eligible corpus, retrieved candidates and final injected set.
* **Precise memory injection**: inject only the memory constraints most relevant to the current task. Do not append the whole memory corpus or unrelated rules merely because they are available.

### 3. Dual-Pipeline Capacity (64K Total, 32K State + Longest Question)
* **Jev 1.13 has two independent per-request limits**: `state + all questions ≤ 64K`, and `state + the longest single question ≤ 32K`. State is ingested once and questions are evaluated in parallel. Source: https://docs.typesafe.ai/models.md. This supersedes the old total-32K assumption. Separate requests never share a capacity window.
* **Safe planning budgets are 56K total and 28K state + longest question**, leaving 12.5% headroom on each dimension. These are estimates, not tokenizer guarantees.
* **Track A — Repository Overview**: the repository's CodeGraph/overview, which can be large. Skill catalogs do NOT belong to Track A.
* **Track B — Hermes Skills + Memories**: Skill metadata and eligible global/current-project Memory candidates belong together in this track. Both tracks receive the current user task needed for relevance evaluation.
* Estimate both dimensions including task, overview, metadata, question content and request overhead, using the conservative **2.85 bytes/token** approximation. Question-map IDs are excluded from inference per the official API docs; preserve full wire bytes separately for calibration.
* In `auto` mode, use `Unified` when both safe budgets and choice limits fit; total question content above 28K alone does not require splitting. Otherwise, when both logical tracks have inputs, execute Track A and Track B concurrently via `Promise.all` and merge their routing decisions.
* Every actual outgoing track/batch must independently pass both budgets. Partition complete question/overview records without truncating candidates. Unsplittable state or a single oversized question fails open. Do not reduce either rule to one aggregate-token threshold.
* **Explicit parallel visibility**: navigation cards, status output and reports must clearly identify `Unified` versus `Parallel`. Show per-track actual token usage, e.g. `Track A (Overview): 24K | Track B (Skills + Mem): 8K (Parallel)`.
* Never display the two tracks' token sum as an unexplained single-request count. If a total is shown, label it as an aggregate across parallel requests. Keep estimated payload tokens distinct from actual API usage.
* Fast routing is a product goal, not an unverified fixed ~450ms guarantee. Measure local collection plus API evaluation and injection when reporting end-to-end latency.

### 4. Fail-Open Timeout & Resilience
* Default timeout of **1,500ms** with a hard ceiling of **3,000ms** enforced on all Jev API requests. User-configured `timeoutMs` up to 3,000ms is respected.
* Any network jitter, API error, or timeout must fail open immediately in **0ms**, allowing the main agent to proceed without interruption while logging `bypassed: true`.

### 5. Security & Scope Boundaries
* Global API keys and endpoints configured in `~/.pi/agent/jev-config.jsonc` or `~/.pi/agent/secrets/jev.key` (mode `0600`) must **never be overridden or leaked by untrusted project-local `.pi/jev-config.jsonc`**.
* Telemetry logs in `~/.pi/agent/jev-sessions/<project-slug>/<session-id>.jsonl` use `0700` directories and `0600` files on POSIX systems. API keys are always redacted in `/jev-config` and logs.

### 6. File Scanning & Directory Safeguards
* Home directory `~` and system roots (`/`, `/Users`, `/home`) are guarded with **0ms immediate bypass** to prevent runaway indexing.
* Standard ignore list (`.git`, `.worktrees`, `node_modules`, `vendor`, `dist`, `build`, `temp`, `auths`, `logs`, `Library`, `.cache`, `.cargo`, `.rustup`, etc.) and `maxFilesIndexed: 3000` cap are strictly enforced.

---

## General Tooling & Coding Defaults

* **Tooling Rules**: Always use `fd` (never `find`), `rg` (never `grep`), and `lsof` for process/port checks.
* **No Micro-Reading**: Forbid repetitive fixed-step micro-reading (e.g. 50-line chunks dozens of times). Locate symbols and line numbers with `rg` first, then read adequate chunks directly.
* **Zero Unverified Code**: Every code change MUST be actively verified by executing `bun run build && bun test && node scripts/check-package.mjs`.
