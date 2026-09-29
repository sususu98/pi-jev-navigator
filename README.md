# ⚡ pi-jev-navigator

> **Ultra-Low-Token System One Context Governance & Intent Navigator for Pi Coding Agent**  
> Powered by [TypeSafe Jev](https://typesafe.ai) (`jev-1.13.0`) and Trie-Folded CodeGraphs.

---

## 🌟 Overview

`pi-jev-navigator` is a high-precision, low-token context governance extension for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). It solves the fundamental **Token Bloat** and **Attention Dilution** problems in modern AI coding agents when working with massive codebases (e.g. 1,000+ files, 100+ skills).

Instead of stuffing dozens of SOP skills and giant symbol indexes into the **System Prompt** (which ruins LLM Prefix Caching and wastes tens of thousands of tokens per turn), `pi-jev-navigator` uses **TypeSafe Jev (System One API)** as an upstream millisecond-level decision engine:

1. **🌳 Trie-Folded CodeGraph**: Automatically compresses full repository AST symbols (Go, TS, Rust, Python) into an ultra-compact Trie-Folded DSL (~15k tokens for 700+ Go files, 0 test files).
2. **⚡ Single-Round Speculative Fan-Out**: Evaluates target subsystems, exact implementation files, active SOP skills, and safety guardrails in a single parallel Jev HTTP request (~500–800ms, <$0.0009 USD).
3. **🎯 100% Prefix-Cache Friendly**: Keeps the System Prompt 100% static. Dynamically appends the Jev-selected navigation packet strictly to the **tail** of the user prompt (`event.prompt`).

---

## 🏗️ Architecture Pipeline

```text
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 1. User Prompt: "Fix thoughtSignature carry for Antigravity in Claude Messages"        │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 2. Local CodeGraph & Skill Collector (7-Day TTL Cache)                                 │
 │    • Trie-Folded DSL (.pi/cpa-macro-map.dsl) - 731 files, 0 tests (14k tokens)         │
 │    • 100+ Skills Catalog (~3k tokens)                                                  │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 3. TypeSafe Jev System One Model (jev-latest / jev-1.13.0)                             │
 │    Single HTTP Request (570ms | $0.0009 USD | 100% Free Output Tokens)                 │
 │    ├── q1_target_subsystems: internal/signature & internal/translator (Conf: 1.0)       │
 │    ├── q2_active_skill: claude-code-fingerprint-implementation (Conf: 1.0)             │
 │    ├── q3_safety_guard: rule_no_translator & rule_fast_compile                        │
 │    └── q4_risk_score: 2.0 (High cross-protocol regression danger)                      │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 4. Tail Context Injection (Appended to event.prompt)                                   │
 │    • System Prompt remains STATIC (100% Prefix Cache Hit)                              │
 │    • Main LLM receives exact file targets and SOP Checklist without distraction        │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Installation & Setup

### 1. Build and Link

```bash
cd ~/workspace/pi-jev-navigator
bun install
bun run build
```

### 2. Configure TypeSafe API Key

The extension automatically searches for your API key in the following locations (with fallback):

1. Environment variable: `export TYPESAFE_API_KEY="apikey_xxx"`
2. Secure credential file (`0600` permissions): `~/.pi/agent/secrets/jev.key`

```bash
mkdir -p ~/.pi/agent/secrets
echo "your_typesafe_api_key_here" > ~/.pi/agent/secrets/jev.key
chmod 0600 ~/.pi/agent/secrets/jev.key
```

### 3. Register in Pi Agent

Add the extension path to your `~/.pi/agent/settings.json` or load directly in your session:

```json
{
  "extensions": [
    "~/workspace/pi-jev-navigator/dist/index.js"
  ]
}
```

---

## 🎮 Interactive Commands

| Slash Command | Description |
| :--- | :--- |
| `/jev-status` | Inspect Jev engine status, API key binding, and CodeGraph index statistics |
| `/jev-refresh` | Force re-index and re-generate the Trie-Folded DSL CodeGraph |
| `/jev-eval <query>` | Manually test Jev decision output on a specific prompt |

---

## 📊 Benchmark & Economics

| Metric | Traditional Agent (System Prompt stuffing) | `pi-jev-navigator` (System One Flow) | Improvement |
| :--- | :--- | :--- | :--- |
| **System Prompt Size** | ~18,000 Tokens (124+ skills) | **~2,000 Tokens (Core instructions)** | **88.9% Reduction** |
| **Prefix Cache Hit Rate** | Often broken by dynamic skill updates | **100% Guaranteed Cache Hits** | **Rock Solid** |
| **Decision Latency** | 2,000ms – 5,000ms (Generative LLMs) | **500ms – 800ms (Jev System One)** | **4x – 6x Faster** |
| **Decision Cost** | ~$0.015 – $0.05 / request | **$0.0008 – $0.0009 / request** | **95% Cheaper** |

---

## 🧪 Testing

Run the full automated test suite:

```bash
bun test
```

---

## 📄 License

MIT © [sususu](https://github.com/sususu)
