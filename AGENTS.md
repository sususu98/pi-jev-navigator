# AGENTS.md — pi-jev-navigator Developer & Agent Guide
> End every completed task with a **喵**

`pi-jev-navigator` is a TypeSafe Jev (`jev-latest`) System One navigation and context governance extension for Pi Coding Agent. It provides compact CodeGraph overview routing, tail navigation injection, Hermes memory guard protection, dual-pipeline execution, and Git Worktree awareness.

## 🎯 Core Product Goal

Support **Pi + Hermes Memory with large-scale Skill and Memory catalogs**. Jev must quickly identify the SOP skills and memory constraints relevant to the current task, then append compact, actionable guidance to the **user prompt's trailing context** so the main agent can act precisely instead of repeatedly exploring or rediscovering known procedures.

* Review and implementation priorities: **task-relevant coverage, routing precision, end-to-end latency, and actionable tail guidance**. Peripheral findings do not replace evaluating this core goal.
* Do not equate the goal with injecting every skill/memory body or dynamically reducing the system prompt. Keep the system prompt and native skill catalog unchanged.
* Skill metadata and relevant memory constraints are sufficient routing inputs; the final navigation packet should contain only the selected, useful guidance.

---

## 🛠️ Build, Test & Packaging Commands

```bash
# Build complete extension (TypeScript bundle, .d.ts types, and 6-platform native Go AST binaries)
bun run build

# Run complete automated test suite (59 unit & integration tests across 7 test suites)
bun test

# Verify package metadata, native cross-platform binaries, and Node.js runtime compatibility
node scripts/check-package.mjs
```

---

## 🏛️ Core Architecture & Inviolable Invariants

### 1. Prefix Cache Invariant (System Prompt Purity — Inviolable Forbidden Zone)
* **System Prompt is an inviolable forbidden zone — NEVER mutate or modify it dynamically**: Once a session starts, the Leading System Prompt must remain **100% bit-for-bit identical across all turns**. It is strictly forbidden to rewrite, regex-prune, filter, or dynamically add/remove system prompt content in any lifecycle hook (`before_agent_start`, `context_with_system`, etc.).
* **Strictly forbidden to dynamically inject or filter skills in System Prompt**: Never dynamically alter `event.systemPromptOptions.skills` based on Jev's activated skills in `before_agent_start` (e.g., injecting an active skill when present and emptying it when absent). Turn-by-turn variance in the leading system instruction breaks the upstream LLM LCP (Longest Common Prefix) Merkle root, destroys hundred-thousand-token Prefix Caches, and breaks session affinity across multi-account gateways.
* **Turn-invariant system prompt purity**: Whenever Jev skill routing is active (`enableSkills !== false`), the system prompt's skill section is permanently kept empty (`[]`), ensuring that the System Prompt is byte-for-byte identical from turn 1 to turn 100+ and eliminating 56KB+ of skill catalog token bloat without turn-by-turn variance.
* **All dynamic guidance MUST strictly use Tail Injection**: Dynamic navigation packets (Target Subsystem, Recommended SOP Skill, Active Memory Guard, Risk Score) must **strictly and exclusively be appended to the user prompt's trailing context (`TailInjector`)**. The model loads recommended SOP skills on demand via standard `read` tool calls into the conversation flow, never by mutating leading system prompts.
* **Historical wire prefix invariant**: request-local tails must remain present, byte-for-byte, on their original user messages in every subsequent request. Freeze the complete tail once in non-context session custom entries (`jev-navigation-tail-v1`) via `pi.appendEntry()`; replay them bit-for-bit on the active branch during `context_with_system`. Never strip or recalculate old tails on settle, new prompts, bypass/disable, reload or resume. Cross-run Skill/SOP/tool-history prefix equality is a mandatory regression test.

### 2. Jev Relevance Evaluation, Skill Metadata & Memory Scope
* **Strictly forbidden**: Never hardcode client-side keyword regexes, manual topic cluster heuristics (e.g. `if (title.includes('grep'))`), or heuristic skill/directory slicing to guess task relevance. Jev performs relevance evaluation.
* **Skill metadata only**: send names, descriptions and locations to Jev; do not include complete SKILL.md bodies in routing requests. A selected skill's name/path and an instruction to read the complete SOP are valid tail guidance, not a missing feature.
* **Memory scope**: consider global memories and the current project's memories, including canonical project inheritance for linked worktrees. Exclude memories belonging to unrelated projects. This is required scope isolation, not prohibited semantic pre-filtering.
* **Hermes retrieval boundary**: scope eligibility is not permission to transmit the entire corpus. Use read-only SQLite/FTS5 lexical recall across global/current-project scopes, then bound candidates by count and serialized token budget before Jev. Generic tokenization, trigram queries, category channels and rank fusion are allowed retrieval mechanics, not client-side semantic relevance claims. No hardcoded topical keywords/synonym maps and no whole-corpus fallback on misses/errors.
* Objective metadata (Recency, Project Scope, Category Hierarchy) may organize eligible candidates, but metadata rank alone is not proof of task relevance. Distinguish eligible corpus, retrieved candidates and final injected set.
* **Precise memory injection**: inject only the memory constraints most relevant to the current task. Do not append the whole memory corpus or unrelated rules merely because they are available.

### 3. Dual-Pipeline Auto-Tiering (32K Per Request, 28K Split Threshold)
* **Jev currently has a 32K context window per request**. Two requests do not share a single 64K context window; each track must independently fit the service's limit.
* **Track A — Repository Overview**: the repository's CodeGraph/overview, which can be large. Skill catalogs do NOT belong to Track A.
* **Track B — Hermes Skills + Memories**: Skill metadata and eligible global/current-project Memory candidates belong together in this track. Both tracks receive the current user task needed for relevance evaluation.
* Estimate the complete combined serialized payload, including task, overview, metadata, questions and request overhead, using the calibrated **2.85 bytes/token** estimate.
* In `auto` mode, combined estimated payload **≤ 28K tokens** (~79.8 KB) uses the `Unified` single-request pipeline. When it **exceeds 28K**, execute Track A and Track B concurrently via `Promise.all` and merge their routing decisions.
* Splitting is not sufficient if either individual track still exceeds 32K. Capacity handling must respect each request's limit; do not silently treat a large catalog as supported merely because two tracks exist.
* **Explicit parallel visibility**: navigation cards, status output and reports must clearly identify `Unified` versus `Parallel`. Show per-track actual token usage, e.g. `Track A (Overview): 24K | Track B (Skills + Mem): 8K (Parallel)`.
* Never display the two tracks' token sum as an unexplained single-request count. If a total is shown, label it as an aggregate across parallel requests. Keep estimated payload tokens distinct from actual API usage.
* Fast routing is a product goal, not an unverified fixed ~450ms guarantee. Measure local collection plus API evaluation and injection when reporting end-to-end latency.

### 4. Fail-Open Timeout & Resilience
* Hard timeout of **1,500ms** enforced on all Jev API requests.
* Any network jitter, API error, or timeout must fail open immediately in **0ms**, allowing the main agent to proceed without interruption while logging `bypassed: true`.

### 5. Security & Scope Boundaries
* Global API keys and endpoints configured in `~/.pi/agent/jev-config.jsonc` or `~/.pi/agent/secrets/jev.key` (mode `0600`) must **never be overridden or leaked by untrusted project-local `.pi/jev-config.jsonc`**.
* Telemetry logs in `~/.pi/agent/jev-sessions/<project-slug>/<session-id>.jsonl` use `0700` directories and `0600` files on POSIX systems. API keys are always redacted in `/jev-config` and logs.

### 6. File Scanning & Directory Safeguards
* Home directory `~` and system roots (`/`, `/Users`, `/home`) are guarded with **0ms immediate bypass** to prevent runaway indexing.
* Standard ignore list (`.git`, `.worktrees`, `node_modules`, `vendor`, `dist`, `build`, `temp`, `auths`, `logs`, `Library`, `.cache`, `.cargo`, `.rustup`, etc.) and `maxFilesIndexed: 3000` cap are strictly enforced.

---

## 📋 General Tooling & Coding Defaults

* **Tooling Rules**: Always use `fd` (never `find`), `rg` (never `grep`), and `lsof` for process/port checks.
* **No Micro-Reading**: Forbid repetitive fixed-step micro-reading (e.g. 50-line chunks dozens of times). Locate symbols and line numbers with `rg` first, then read adequate chunks directly.
* **Zero Unverified Code**: Every code change MUST be actively verified by executing `bun run build && bun test && node scripts/check-package.mjs`.
