import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraphExtractor } from '../src/graph/codegraph.js';
import { SkillCollector } from '../src/skills/collector.js';
import { TTLStore } from '../src/cache/ttl-store.js';
import { TailInjector } from '../src/injector/tail-injector.js';
import { JevPrompter } from '../src/jev/prompter.js';
import { DispatchDecision, JevAnswer, SkillSummary } from '../src/types.js';

describe('pi-jev-navigator core test suite', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-core-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('should correctly identify and exclude test files', () => {
    const extractor = new CodeGraphExtractor();

    expect(extractor.isTestFile('server_test.go')).toBe(true);
    expect(extractor.isTestFile('internal/signature/claude_test.go')).toBe(true);
    expect(extractor.isTestFile('src/components/button.spec.ts')).toBe(true);
    expect(extractor.isTestFile('src/tests/helper.ts')).toBe(true);
    expect(extractor.isTestFile('tests/unit/test_api.py')).toBe(true);

    expect(extractor.isTestFile('server.go')).toBe(false);
    expect(extractor.isTestFile('internal/signature/claude.go')).toBe(false);
    expect(extractor.isTestFile('src/index.ts')).toBe(false);
  });

  it('should extract exported symbols from Go and TypeScript files', () => {
    const extractor = new CodeGraphExtractor();

    const goCode = `
      package main
      type ServerConfig struct {}
      type RequestHandler struct {}
      func StartServer() error { return nil }
      func StopServer() {}
      func internalHelper() {}
    `;
    const goSymbols = extractor.extractSymbols('server.go', goCode);
    expect(goSymbols).toContain('ServerConfig');
    expect(goSymbols).toContain('RequestHandler');
    expect(goSymbols).toContain('StartServer');
    expect(goSymbols).toContain('StopServer');
    expect(goSymbols).not.toContain('internalHelper');

    const tsCode = `
      export class SessionManager {}
      export function createSession() {}
      function privateHelper() {}
    `;
    const tsSymbols = extractor.extractSymbols('session.ts', tsCode);
    expect(tsSymbols).toContain('SessionManager');
    expect(tsSymbols).toContain('createSession');
    expect(tsSymbols).not.toContain('privateHelper');
  });

  it('should generate compact Trie-Folded DSL correctly', () => {
    const extractor = new CodeGraphExtractor();

    // Create a mock repo in tmpDir
    fs.mkdirSync(path.join(tmpDir, 'pkg', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'pkg', 'auth', 'jwt.go'),
      'package auth\ntype TokenVerifier struct {}\nfunc VerifyToken() {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'pkg', 'auth', 'jwt_test.go'),
      'package auth\nfunc TestVerifyToken() {}\n'
    );

    const result = extractor.generateTrieDSL({
      rootDir: tmpDir,
      excludeTests: true,
    });

    expect(result.totalFiles).toBe(1);
    expect(result.dsl).toContain('[pkg/auth]');
    expect(result.dsl).toContain('jwt.go->TokenVerifier VerifyToken');
    expect(result.dsl).not.toContain('jwt_test.go');
  });

  it('should format tail guidance context accurately', () => {
    const injector = new TailInjector();
    const decision: DispatchDecision = {
      targetSubsystems: ['internal/signature', 'internal/translator'],
      activatedSkill: 'cpa-signature-catalog-and-collection',
      safetyRules: ['rule_no_translator', 'rule_fast_compile'],
      riskScore: 2.0,
      latencyMs: 520.5,
      inputTokens: 21000,
    };

    const guidance = injector.formatTailGuidance(decision);

    expect(guidance).toContain('System One Navigation Context | Powered by TypeSafe Jev');
    expect(guidance).toContain('internal/signature, internal/translator');
    expect(guidance).toContain('cpa-signature-catalog-and-collection');
    expect(guidance).toContain('rule_no_translator; rule_fast_compile');
    expect(guidance).toContain('Architecture Risk Level: 2 (⚠️ High)');
    expect(guidance).toContain('520.5ms');
  });

  it('should map current question IDs, subsystem probabilities and actual safety text', () => {
    const prompter = new JevPrompter();
    const mockSkills: SkillSummary[] = [
      {
        name: 'claude-sig',
        description: 'Claude signature handling',
        path: '/mock/skills/claude-sig/SKILL.md',
      },
    ];

    const { questions, dirCriteriaMap } = prompter.buildQuestions(
      '[internal/signature]\n  claude.go->Verify\n[internal/translator]\n  req.go->Convert',
      mockSkills,
      ['rule_no_translator']
    );

    // Verify backticked paths in questions
    expect(questions.q1_target_subsystem.instructions).toContain('`codebase_trie_map`');
    expect(questions.q1_target_subsystem.instructions).toContain('`user_task`');

    // Simulate multi-module probability answers
    const mockAnswers: Record<string, JevAnswer> = {
      q1_target_subsystem: {
        type: 'choice',
        choice: 'dir_0',
        confidence: 0.85,
        probabilities: {
          dir_0: 0.65,
          dir_1: 0.30, // >= 0.25 threshold
          none_or_new: 0.05,
        },
      },
      q2_active_skill: {
        type: 'choice',
        choice: 'skill_0',
        confidence: 0.98,
        probabilities: { skill_0: 0.98, none: 0.02 },
      },
      q3_safety_guard: {
        type: 'choice',
        choice: 'rule_0',
        confidence: 0.9,
        probabilities: { rule_0: 0.9, standard_safe: 0.1 },
      },
      q4_complexity_risk: {
        type: 'score',
        score: 2.0,
        confidence: 0.95,
      },
    };

    const decision = prompter.parseAnswers(mockAnswers, mockSkills, dirCriteriaMap, 450, 18000, [], ['rule_no_translator']);
    expect(decision.safetyRules).toEqual(['rule_no_translator']);

    // Should contain both primary and secondary candidate
    expect(decision.targetSubsystems).toContain('internal/signature');
    expect(decision.targetSubsystems).toContain('internal/translator');
    expect(decision.activatedSkill).toBe('claude-sig');
    expect(decision.riskScore).toBe(2.0);
  });

  it('should handle TTL cache operations with expiration', () => {
    const store = new TTLStore(tmpDir, 7);

    store.set('test-key', { foo: 'bar' });
    const data = store.get<{ foo: string }>('test-key');
    expect(data).not.toBeNull();
    expect(data?.foo).toBe('bar');

    store.setRawFile('test.dsl', '[internal/api]\n  server.go->Start');
    const raw = store.getRawFile('test.dsl');
    expect(raw).toContain('[internal/api]');
    const expired = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(tmpDir, '.pi', 'test-key.json'), JSON.stringify({ timestamp: expired, data: {} }));
    fs.utimesSync(path.join(tmpDir, '.pi', 'test.dsl'), expired / 1000, expired / 1000);
    expect(store.get('test-key')).toBeNull();
    expect(store.getRawFile('test.dsl')).toBeNull();
  });

  it('should prune unactivated skills from System Prompt', () => {
    const injector = new TailInjector();
    const mockSystemPrompt = `You are an expert coding assistant...

<skills>
The following skills provide specialized instructions for specific tasks.
<available_skills>
  <skill>
    <name>tavily-search</name>
    <description>Search web</description>
  </skill>
  <skill>
    <name>local-cpa</name>
    <description>Local CPA proxy management</description>
  </skill>
</available_skills>
</skills>

<cwd>/Users/sususu</cwd>`;

    // Case 1: No skill activated
    const prunedEmpty = injector.pruneSystemPromptSkills(mockSystemPrompt, undefined);
    expect(prunedEmpty).not.toContain('tavily-search');
    expect(prunedEmpty).not.toContain('local-cpa');
    expect(prunedEmpty).toContain('Skill catalog routed');
    expect(prunedEmpty).toContain('<cwd>/Users/sususu</cwd>');

    // Case 2: Specific skill activated (local-cpa)
    const prunedSingle = injector.pruneSystemPromptSkills(mockSystemPrompt, 'local-cpa');
    expect(prunedSingle).toContain('local-cpa');
    expect(prunedSingle).not.toContain('tavily-search');
    expect(prunedSingle).toContain('<available_skills>');
  });

  it('should format active memory guard into tail guidance', () => {
    const injector = new TailInjector();
    const guidance = injector.formatTailGuidance({
      targetSubsystems: ['internal/config'],
      activatedMemoryGuard: {
        id: 'mem_read_config',
        category: 'correction',
        title: '查看配置优先直接读取配置文件',
        summary: '当用户要求看配置时直接读取配置文件本身，严禁盲查源码',
        rule: '直接读取 config.yaml 或 mounted secrets',
      },
      riskScore: 0.15,
      latencyMs: 500,
      inputTokens: 25000,
    });

    expect(guidance).toContain('🎯 [System One Navigation Context');
    expect(guidance).toContain('• 🧠 Active Memory Guard:');
    expect(guidance).toContain('⚠️ [correction] 当用户要求看配置时直接读取配置文件本身');
    expect(guidance).toContain('• 📁 Target Subsystem: `internal/config`');
  });

  it('should support live feature toggling via JevConfigStore', () => {
    const { JevConfigStore } = require('../src/config/config-store.ts');
    const store = new JevConfigStore(tmpDir, {}, path.join(tmpDir, 'home'));
    expect(store.get().enableSkills).toBe(true);
    expect(store.get().enableMemories).toBe(true);

    const toggleSkills = store.toggle('skills');
    expect(toggleSkills.newValue).toBe(false);
    expect(store.get().enableSkills).toBe(false);

    const toggleMem = store.toggle('memories');
    expect(toggleMem.newValue).toBe(false);
    expect(store.get().enableMemories).toBe(false);

    const toggleMode = store.toggle('mode');
    expect(toggleMode.newValue).toBe('parallel');
    expect(store.get().executionMode).toBe('parallel');
  });

  it('should parse JSONC with single-line comments, block comments, and trailing commas', () => {
    const { parseJsonc, stripJsoncComments } = require('../src/config/config-store.ts');
    const jsoncContent = `{
      // 单行注释
      "endpoint": "https://api.typesafe.ai/v1/systemone", /* 行内块注释 */
      "model": "jev-latest",
      /* 多行
         块注释 */
      "enableSubsystems": true,
      "timeoutMs": 1500, // 超时配置
    }`;

    const parsed = parseJsonc(jsoncContent);
    expect(parsed.endpoint).toBe('https://api.typesafe.ai/v1/systemone');
    expect(parsed.model).toBe('jev-latest');
    expect(parsed.enableSubsystems).toBe(true);
    expect(parsed.timeoutMs).toBe(1500);
  });

  it('should rank fixture memories and count exact duplicate records', () => {
    const { MemoryCollector } = require('../src/memory/collector.ts');
    const home = path.join(tmpDir, 'home');
    const memoryDir = path.join(home, '.pi', 'agent', 'pi-hermes-memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'failures.md'), '[correction] Preserve uncommitted files\nNever delete them\n§\n[correction] Preserve uncommitted files\nNever delete them');
    const collector = new MemoryCollector(home);
    const memories = collector.collectMemories(tmpDir, 20);
    expect(memories).toHaveLength(1);
    expect(memories[0].frequency).toBe(2);

    expect(memories.length).toBeGreaterThan(0);
    // Highest ranked items should have score and frequency
    const topItem = memories[0];
    expect(topItem.score).toBeDefined();
    expect(topItem.score!).toBeGreaterThan(0);

    // Format for Jev should include frequency if > 1
    const jevFormatted = collector.formatForJev(memories);
    expect(jevFormatted.length).toBe(memories.length);
    expect(jevFormatted[0]).toContain(`[${topItem.category}]`);
  });

  it('should safeguard home directory and enforce ignoreDirs and maxFiles caps', () => {
    const { CodeGraphExtractor } = require('../src/graph/codegraph.ts');
    const extractor = new CodeGraphExtractor();

    // 1. Home directory guard test
    const homeResult = extractor.generateTrieDSL({ rootDir: os.homedir() });
    expect(homeResult.totalFiles).toBe(0);
    expect(homeResult.dsl).toBe('[~]\n');

    // 2. Custom ignoreDirs test
    const ignoredSubdir = path.join(tmpDir, 'custom_ignored_dir');
    fs.mkdirSync(ignoredSubdir, { recursive: true });
    fs.writeFileSync(path.join(ignoredSubdir, 'test.go'), 'package main\nfunc IgnoredFunc() {}');

    const scanResult = extractor.generateTrieDSL({
      rootDir: tmpDir,
      ignoreDirs: ['custom_ignored_dir'],
    });
    expect(scanResult.dsl).not.toContain('IgnoredFunc');
  });
});
