import { describe, it, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraphExtractor } from '../src/graph/codegraph.js';
import { SkillCollector } from '../src/skills/collector.js';
import { TTLStore } from '../src/cache/ttl-store.js';
import { TailInjector } from '../src/injector/tail-injector.js';
import { JevPrompter } from '../src/jev/prompter.js';
import { DispatchDecision } from '../src/types.js';

describe('pi-jev-navigator core test suite', () => {
  const tmpDir = path.join(process.cwd(), '.tmp-test');

  beforeEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });
  });

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

  it('should handle TTL cache operations with expiration', () => {
    const store = new TTLStore(tmpDir, 7);

    store.set('test-key', { foo: 'bar' });
    const data = store.get<{ foo: string }>('test-key');
    expect(data).not.toBeNull();
    expect(data?.foo).toBe('bar');

    store.setRawFile('test.dsl', '[internal/api]\n  server.go->Start');
    const raw = store.getRawFile('test.dsl');
    expect(raw).toContain('[internal/api]');
  });
});
