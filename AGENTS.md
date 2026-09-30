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

### 1. Prefix Cache Invariant (System Prompt Purity — 绝对不能动的禁区)
* **System Prompt 是绝对不能触碰的禁区！永远都不能动态改动 System Prompt**：会话一旦启动，Leading System Prompt 必须保持 **100% 字节级绝对静态**。严禁在任何生命周期钩子（`before_agent_start`、`context_with_system` 等）中动态重写、正则剪枝或按轮次动态增删系统提示词。
* **严禁动态向 System Prompt 注入或筛选技能**：严禁在 `before_agent_start` 中根据 Jev 激活的技能动态修改 `event.systemPromptOptions.skills`（例如“有技能时塞入 1 个 skill，无技能时置空”）。这种轮次间的系统词跳变会直接斩断大模型上游 LCP（Longest Common Prefix）Merkle 树根，彻底击穿数十万 Token 的 Prefix Cache，并摧毁多账号反代网关的会话亲和性导致频繁强制换号。
* **全生命周期系统词纯净一致**：在启用技能剪枝时，系统提示词中的技能列表必须在整个会话中**永久恒定**（例如始终为 `[]` 或固定的统一静态注释），确保第 1 轮到第 100 轮的 System Prompt 每一个字符绝对不变。
* **所有动态指引 100% 仅能走尾部注入（Tail Injection）**：动态导航数据包（Target Subsystem, Recommended SOP Skill, Active Memory Guard, Risk Score）必须**严格且仅能追加在 User Prompt 尾部 (`TailInjector`)**。大模型通过阅读 User 尾部推荐的 SOP 路径，利用标准 `read` 工具将其作为会话上下文动态载入，严禁动首部系统提示词。
* **Historical wire prefix invariant**：发送给大模型的请求级历史尾部必须在后续所有请求中字节级保持原样。使用 `NavigationTailLedger` 将生成的尾部一次性冻结在非上下文的 Session Custom Entry (`jev-navigation-tail-v1`) 中，并在后续轮次通过 `context_with_system` 原样比特级回放。严禁在 `settle`、新轮次、绕过或恢复时剥离旧尾部，严禁重新计算历史遥测数字。跨轮次 Skill/SOP/工具历史前缀完全一致是强制性的回归测试防线。

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
