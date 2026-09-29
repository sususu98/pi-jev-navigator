# ⚡ pi-jev-navigator

> **Ultra-Low-Token System One Context Governance & Dual-Pipeline Intent Navigator for Pi Coding Agent**  
> Powered by [TypeSafe Jev](https://typesafe.ai) (`jev-1.13.0`), Trie-Folded CodeGraphs, and Hermes Memory Guard.

---

## 🌟 Overview

`pi-jev-navigator` is a high-precision, low-token context governance and intent dispatch extension for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). It solves the fundamental **Token Bloat**, **Attention Dilution**, and **"Memories Recorded But Never Used"** problems when working with massive repositories (e.g. 1,000+ files, 130+ skills, 1,000+ memory entries).

Instead of dumping hundreds of SOP skills and memory logs into the **System Prompt** (which ruins LLM Prefix Caching and wastes tens of thousands of tokens per turn), `pi-jev-navigator` uses **TypeSafe Jev (System One API)** as an upstream ~450ms decision engine:

1. **🌳 Trie-Folded CodeGraph**: Compresses full repository AST symbols (Go, TS, Rust, Python) into an ultra-compact Trie-Folded DSL (~14k tokens for 570+ Go files, 0 test files).
2. **⚡ Dual-Pipeline Auto-Tiering (64K Capacity)**: Automatically parallelizes CodeGraph/Skill routing and Hermes Memory Guards across two concurrent streams (`Promise.all`), doubling capacity to 64K tokens with zero extra latency (~450ms).
3. **🧠 Hermes Memory Guard Dispatcher**: Proactively recalls and attaches critical `[correction]` and `[preference]` constraints before the main model generates code (preventing repetitive command mistakes like `grep`/`find`).
4. **✂️ Dynamic System Prompt Pruning**: Strips all 130+ unactivated Skill XML tags from the System Prompt, keeping it 100% static and cache-friendly while saving 5,000–15,000 tokens per turn.
5. **🛡️ Fail-Open Timeout Bypass**: 1,500ms hard timeout guard. If external API or network jitters occur, the agent seamlessly bypasses in 0ms without blocking.
6. **🌲 Native Git Worktree Support**: `resolveGitContext` accurately detects linked worktrees and connects main repository project memories.
7. **🗂️ Pi-Mirrored Telemetry Logging**: Automatically partitions decision telemetry into `~/.pi/agent/jev-sessions/<project-slug>/<session-id>.jsonl` for Recursive Self-Improvement (RSI) data flywheels.

---

## 🏗️ Architecture Pipeline

```text
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 1. User Prompt (e.g. "查看一下 antigravity 和 prod 的敏感词配置")                         │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 2. Local State Assembly (<5ms, Zero Network)                                           │
 │    • Trie-Folded CodeGraph (.pi/cpa-macro-map.dsl) - 579 files, 2,051 symbols (~14k tok) │
 │    • 133+ All Skills Catalog (Project + Global + Hermes Dynamic Skills)                │
 │    • 50+ Hermes Active Memory Guards ([correction], [preference], [failure])            │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 3. TypeSafe Jev Dual-Pipeline Engine (jev-latest / jev-1.13.0, 440ms, <$0.001 USD)      │
 │    Promise.all([Req 1: CodeGraph & Skills, Req 2: Hermes Memory Guards])               │
 │    ├── q1_target_subsystem: internal/config & internal/runtime/executor/helps          │
 │    ├── q2_active_skill: none (No specialized SOP needed for read query)                │
 │    ├── q3_safety_guard: standard_safe                                                  │
 │    ├── q4_complexity_risk: 0.11 (Low cosmetic read)                                    │
 │    └── q5_memory_guard: [correction] 查看配置直接读取配置文件，严禁盲查源码               │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 4. System Prompt Pruning & Tail Injection                                              │
 │    • System Prompt: Prunes 132 redundant skills (100% Prefix Cache Hit)               │
 │    • User Tail: Appends Subsystem target & Active Memory Guard before LLM generates    │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Installation & Global Setup

### 1. Build and Test

```bash
cd ~/workspace/pi-jev-navigator
bun install
bun run build
bun test
```

### 2. Configure TypeSafe API Key

The extension automatically searches for your API key in the following locations (with fallback):

1. Config file: `"apiKey": "apikey_xxx"` in `~/.pi/agent/jev-config.jsonc`
2. Environment variable: `export TYPESAFE_API_KEY="apikey_xxx"` or `export JEV_API_KEY="apikey_xxx"`
3. Secure credential file (`0600` permissions): `~/.pi/agent/secrets/jev.key`

```bash
mkdir -p ~/.pi/agent/secrets
echo "your_typesafe_api_key_here" > ~/.pi/agent/secrets/jev.key
chmod 0600 ~/.pi/agent/secrets/jev.key
```

### 3. Install Globally in Pi Agent

Link the bundled standalone bundle to your global Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf ~/workspace/pi-jev-navigator/dist/index.js ~/.pi/agent/extensions/jev-navigator.js
```

---

## ⚙️ Configuration (`jev-config.jsonc`)

The extension supports full **JSONC** syntax (single-line `//`, multi-line `/* */`, and trailing commas).

* **Global Config**: `~/.pi/agent/jev-config.jsonc`
* **Project Override**: `<projectRoot>/.pi/jev-config.jsonc`

```jsonc
{
  // TypeSafe Jev System One endpoint & model
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "model": "jev-latest",

  // Core feature toggles
  "enableTailInjection": true,        // Inject HUD navigation card at prompt tail
  "enableSubsystems": true,            // Locate codebase implementation subsystems
  "enableSkills": true,                // Dynamically activate SOP skills from catalog
  "enableMemories": true,              // Pre-inject Hermes [correction] & [preference] guards
  "enableSystemPromptPruning": true,   // Prune unactivated skills from System Prompt

  // Pipeline & resilience
  "executionMode": "auto",             // "auto" (parallel >28k) | "parallel" (64K) | "unified" (32K)
  "timeoutMs": 1500,                   // Millisecond timeout; fails open immediately on jitter

  // Capacity quotas
  "maxMemoryGuards": 50,               // Top memory guards evaluated per turn
  "cacheTtlDays": 7,                   // CodeGraph Trie DSL cache TTL
  "logDecisions": true                 // Partition telemetry logs to ~/.pi/agent/jev-sessions/
}
```

---

## 🎮 Interactive Commands

| Slash Command | Description |
| :--- | :--- |
| `/jev-status` | Inspect Jev engine status, worktree info, feature switches, and CodeGraph size |
| `/jev-config` | View full merged JSONC configuration in the terminal |
| `/jev-toggle <target>` | Toggle feature live (`/jev-toggle skills`, `mem`, `subsystems`, `pruning`, `mode`) and persist to `.pi/jev-config.json` |
| `/jev-refresh` | Force re-index and re-generate codebase Trie-Folded DSL |
| `/jev-eval <query>` | Manually run Jev decision on a custom prompt |

---

## 🛡️ Diagnostics & Failure Alerts

`pi-jev-navigator` provides non-blocking, transparent status diagnostics:

1. **Missing API Key**: Status footer shows `⚠️ Jev (No API Key)` and hints to `~/.pi/agent/secrets/jev.key`.
2. **Malformed JSONC Config**: Emits terminal notification: `⚠️ Failed to parse global config [path]: Expected '}'. Using fallback defaults.`
3. **Timeout / Network Jitter**: Automatically bypasses in 0ms (`Fail-Open`) and logs `bypassed: true` into the session telemetry file, ensuring the agent never hangs.

---

## 📊 Benchmark & Economics (CPA Codebase: 579 Files, 133 Skills)

| Metric | Traditional Agent (System Prompt stuffing) | `pi-jev-navigator` (Dual-Pipeline System One) | Improvement |
| :--- | :--- | :--- | :--- |
| **System Prompt Size** | ~18,000 Tokens (133+ skills) | **~2,000 Tokens (Core instructions only)** | **88.9% Reduction** |
| **Prefix Cache Hit Rate** | Frequently broken by dynamic skill/mem edits | **100% Guaranteed Cache Hits** | **Rock Solid** |
| **Memory Recall Rate** | Low (depends on LLM actively calling tools) | **100% Speculative Pre-Injection** | **Zero Regressions** |
| **Decision Latency** | 2,000ms – 5,000ms (Generative LLMs) | **380ms – 460ms (Jev System One Parallel)** | **5x – 10x Faster** |
| **Decision Cost** | ~$0.015 – $0.05 / turn | **$0.0009 / turn** | **95% Cheaper** |

---

## 🧪 Testing

Run the automated test suite (10 unit tests covering AST parsing, JSONC stripping, memory guards, and toggles):

```bash
bun test
```

---

## 📄 License

MIT © sususu
