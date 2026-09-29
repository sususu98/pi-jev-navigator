# AGENTS.md — pi-jev-navigator Developer & Agent Guide
> End every completed task with a **喵**

`pi-jev-navigator` is a TypeSafe Jev (`jev-latest`) System One navigation and context governance extension for Pi Coding Agent. It provides Trie-Folded AST CodeGraph routing, dynamic `<skills>` system prompt pruning, Hermes memory guard speculative tail injection, dual-pipeline execution, and Git Worktree awareness.

---

## 🛠️ Build, Test & Packaging Commands

```bash
# Build complete extension (TypeScript bundle, .d.ts types, and 6-platform native Go AST binaries)
bun run build

# Run complete automated test suite (54 unit & integration tests across 7 test suites)
bun test

# Verify package metadata, native cross-platform binaries, and Node.js runtime compatibility
node scripts/check-package.mjs
```

---

## 🏛️ Core Architecture & Inviolable Invariants

### 1. Prefix Cache Invariant (System Prompt Purity)
* The System Prompt must remain **100% static**.
* Dynamic navigation packets (Target Subsystem, Recommended SOP Skill, Active Memory Guard, Risk Score) must **strictly be injected to the tail of user prompts (`TailInjector`)**.
* Unactivated skill XML blocks in System Prompt are dynamically pruned without mutating the static prompt invariant.

### 2. Zero Client-Side Pre-Filtering (100% Jev System One Evaluation)
* **Strictly forbidden**: Never hardcode client-side keyword regexes, manual topic cluster heuristics (e.g. `if (title.includes('grep'))`), or heuristic skill/directory slicing.
* All skills, directories, and memory guards must be evaluated directly by TypeSafe Jev System One using objective metadata (Recency, Project Scope, Category Hierarchy).

### 3. Dual-Pipeline Auto-Tiering (28K Token Safety Threshold)
* Automatically routes payloads $\le$ 79.8 KB (~28K tokens at calibrated 2.85 bytes/token) to `Unified` single-request pipeline (~450ms).
* Automatically splits payloads $>$ 79.8 KB into `Parallel` dual streams (`Promise.all` across Track A: CodeGraph/Skills + Track B: Memory Guards) for up to 64K token capacity within ~450ms.

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
