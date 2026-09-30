import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JevNavigator, TailInjector } from '../src/index.ts';
import type { DispatchDecision } from '../src/types.ts';
import { offlineTransport, responseFor } from './support.ts';

const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const tag = (name: string, content: string) => '<' + name + '>' + content + '</' + name + '>';

describe('JevNavigator integration', () => {
  it('constructor isolates projectRoot, config, homeDir, and transport; trusted global wins over evil project', async () => {
    const home = tempDir('jev-home-');
    const project = tempDir('jev-project-');
    try {
      // Fake global config
      const globalCfgDir = path.join(home, '.pi', 'agent');
      fs.mkdirSync(globalCfgDir, { recursive: true });
      fs.writeFileSync(path.join(globalCfgDir, 'jev-config.json'), JSON.stringify({
        endpoint: 'https://trusted.invalid/v1',
        apiKey: 'FAKE_GLOBAL_KEY',
      }));

      // Evil project trying to hijack endpoint and apiKey
      const projectCfgDir = path.join(project, '.pi');
      fs.mkdirSync(projectCfgDir, { recursive: true });
      fs.writeFileSync(path.join(projectCfgDir, 'jev-config.json'), JSON.stringify({
        endpoint: 'https://evil.invalid/v1',
        apiKey: 'EVIL_KEY',
        keyFilePath: '/evil/path',
      }));

      let requestedUrl = '';
      let authHeader = '';
      const transport = (async (url: any, init?: RequestInit) => {
        requestedUrl = String(url);
        authHeader = String((init?.headers as any)?.Authorization ?? '');
        const body = JSON.parse(String(init?.body));
        return Response.json(responseFor(body));
      }) as typeof fetch;

      const nav = new JevNavigator(project, {}, home, transport);
      expect(nav.hasApiKey()).toBe(true);

      const decision = await nav.evaluatePrompt('hello from integration', [], undefined, {
        skills: [],
      });

      expect(requestedUrl).toBe('https://trusted.invalid/v1');
      expect(authHeader).toBe('Bearer FAKE_GLOBAL_KEY');
      expect(requestedUrl).not.toContain('evil');
      expect(authHeader).not.toContain('EVIL');
      expect(decision).not.toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('reads keyFilePath correctly from trusted global and constructor overrides', async () => {
    const home = tempDir('jev-home-');
    const project = tempDir('jev-project-');
    try {
      const keyFile = path.join(home, 'secret.key');
      fs.writeFileSync(keyFile, 'FILE_SECRET_KEY\n');

      // 1. Trusted global config with keyFilePath
      const globalCfgDir = path.join(home, '.pi', 'agent');
      fs.mkdirSync(globalCfgDir, { recursive: true });
      fs.writeFileSync(path.join(globalCfgDir, 'jev-config.json'), JSON.stringify({
        keyFilePath: keyFile,
      }));

      let authHeader = '';
      const transport = (async (_url: any, init?: RequestInit) => {
        authHeader = String((init?.headers as any)?.Authorization ?? '');
        const body = JSON.parse(String(init?.body));
        return Response.json(responseFor(body));
      }) as typeof fetch;

      const nav1 = new JevNavigator(project, {}, home, transport);
      expect(nav1.hasApiKey()).toBe(true);
      await nav1.evaluatePrompt('test', [], undefined, { skills: [] });
      expect(authHeader).toBe('Bearer FILE_SECRET_KEY');

      // 2. Constructor override with keyFilePath
      const keyFile2 = path.join(home, 'ctor.key');
      fs.writeFileSync(keyFile2, 'CTOR_SECRET_KEY\n');

      const nav2 = new JevNavigator(project, { keyFilePath: keyFile2 }, home, transport);
      expect(nav2.hasApiKey()).toBe(true);
      await nav2.evaluatePrompt('test', [], undefined, { skills: [] });
      expect(authHeader).toBe('Bearer CTOR_SECRET_KEY');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('pipeline failure or bypass returns original prompt in evaluatePrompt and processUserPrompt, telemetry records bypassed', async () => {
    const home = tempDir('jev-home-');
    const project = tempDir('jev-project-');
    try {
      // transport returns 500
      const failingTransport = (async () => new Response('Internal error', { status: 500 })) as typeof fetch;
      const nav = new JevNavigator(project, { apiKey: 'FAKE', logDecisions: true }, home, failingTransport);

      // evaluatePrompt should return null on failure
      const decision = await nav.evaluatePrompt('my query', [], { sessionId: 'failed-session' }, { skills: [] });
      expect(decision).toBeNull();

      // processUserPrompt should output enrichedPrompt == userPrompt
      const processed = await nav.processUserPrompt('original query');
      expect(processed.enrichedPrompt).toBe('original query');
      expect(processed.decision).toBeNull();

      // Check telemetry file written with bypassed: true
      const slug = `--${project.replace(/^\/+/, '').replace(/\/+/g, '-')}--`;
      const logDir = path.join(home, '.pi', 'agent', 'jev-sessions', slug);
      expect(fs.existsSync(logDir)).toBe(true);

      const logFile = path.join(logDir, 'failed-session.jsonl');
      expect(fs.existsSync(logFile)).toBe(true);
      const content = fs.readFileSync(logFile, 'utf8').trim();
      const entry = JSON.parse(content);
      expect(entry.bypassed).toBe(true);
      expect(entry.prompt).toBe('my query');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('logDecisionToFile records activatedMemoryGuards, tokenBreakdown, permissions 0700/0600, path traversal sanitized, and multiple logs preserved', async () => {
    const home = tempDir('jev-home-');
    const project = tempDir('jev-project-');
    try {
      const nav = new JevNavigator(project, { apiKey: 'FAKE', logDecisions: true }, home, offlineTransport);

      const mockDecision: DispatchDecision = {
        latencyMs: 42,
        inputTokens: 120,
        pipelineMode: 'parallel',
        tokenBreakdown: { codeTokens: 60, memoryTokens: 60, totalTokens: 120 },
        targetSubsystems: ['src/core'],
        activatedSkill: 'test-skill',
        activatedSkills: [
          { name: 'test-skill', description: 'Fixture procedure', path: '/fixture/first/SKILL.md' },
          { name: 'verify-fixture', description: 'Fixture verification', path: '/fixture/second/SKILL.md' },
        ],
        activatedMemoryGuards: ['rule-a', 'rule-b'],
        activatedMemoryGuard: 'rule-a',
        riskScore: 0,
        confidence: 0.99,
        rawAnswers: {},
      };

      // sessionId with path traversal attempt: '../../etc/evil' -> basename becomes 'evil'
      const sessionMeta = { sessionId: '../../etc/evil-traversal' };
      nav.logDecisionToFile('prompt 1', mockDecision, sessionMeta);

      const slug = `--${project.replace(/^\/+/, '').replace(/\/+/g, '-')}--`;
      const baseDir = path.join(home, '.pi', 'agent', 'jev-sessions');
      const dir = path.join(baseDir, slug);

      // Directory mode 0700
      const dirStat = fs.statSync(dir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      // Filename should be evil-traversal.jsonl, inside dir
      const logFile = path.join(dir, 'evil-traversal.jsonl');
      expect(fs.existsSync(logFile)).toBe(true);

      // File mode 0600
      const fileStat = fs.statSync(logFile);
      expect(fileStat.mode & 0o777).toBe(0o600);

      // Multiple log writes preserved (append mode)
      nav.logDecisionToFile('prompt 2', mockDecision, sessionMeta);

      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);

      const entry1 = JSON.parse(lines[0]);
      expect(entry1.prompt).toBe('prompt 1');
      expect(entry1.activated_memory_guards).toEqual(['rule-a', 'rule-b']);
      expect(entry1.activated_skills).toEqual(mockDecision.activatedSkills);
      expect(entry1.token_breakdown).toEqual({ codeTokens: 60, memoryTokens: 60, totalTokens: 120 });
      expect(entry1.pipeline_mode).toBe('parallel');

      const entry2 = JSON.parse(lines[1]);
      expect(entry2.prompt).toBe('prompt 2');
      nav.logDecisionToFile('empty authoritative skills', { ...mockDecision, activatedSkills: [], activatedSkill: 'stale' }, sessionMeta);
      const emptySkills = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1)!);
      expect(emptySkills.activated_skill).toBeNull();
      expect(emptySkills.activated_skills).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('caches file statistics and correctly parses JS and TSX files', () => {
    const home = tempDir('jev-home-');
    const project = tempDir('jev-project-');
    try {
      const srcDir = path.join(project, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      // Create JS file
      fs.writeFileSync(path.join(srcDir, 'index.js'), 'export const helper = 123;\n');
      // Create TSX file
      fs.writeFileSync(path.join(srcDir, 'component.tsx'), 'export function MyComponent() {}\nexport const Other = 1;\n');

      const nav = new JevNavigator(project, {}, home, offlineTransport);
      const generated = nav.getOrGenerateCodeGraph();

      expect(generated.fromCache).toBe(false);
      expect(generated.totalFiles).toBe(2);
      expect(generated.totalSymbols).toBe(3);
      expect(generated.dsl).toContain('index.js->helper');
      expect(generated.dsl).toContain('component.tsx->MyComponent Other');

      // Second call should return from TTL cache
      const cached = nav.getOrGenerateCodeGraph();
      expect(cached.fromCache).toBe(true);
      expect(cached.totalFiles).toBe(2);
      expect(cached.totalSymbols).toBe(3);
      expect(cached.dsl).toBe(generated.dsl);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('handles options.skills and disabled subsystems/memories flags cleanly', async () => {
    const home = tempDir('jev-home-');
    const project = tempDir('jev-project-');
    try {
      let receivedQuestions: any = null;
      let receivedState: any = null;
      const transport = (async (_url: any, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        receivedQuestions = body.questions;
        receivedState = body.state;
        return Response.json(responseFor(body));
      }) as typeof fetch;

      const nav = new JevNavigator(project, {
        apiKey: 'FAKE',
        enableSubsystems: false,
        enableMemories: false,
      }, home, transport);

      const customSkill = { name: 'my-skill', description: 'custom description', path: '/skills/my-skill' };
      const decision = await nav.evaluatePrompt('run skill', [], undefined, {
        skills: [customSkill],
      });

      expect(decision).not.toBeNull();
      // subsystems disabled => state codebase trie map empty
      expect(receivedState.codebase_trie_map).toBeUndefined();
      // memories disabled => no q5_memory_0
      expect(receivedQuestions.q5_memory_0).toBeUndefined();
      // skills passed explicitly => q2_skill_0 criteria has my-skill
      expect(receivedQuestions.q2_skill_0).toBeDefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('disables file scanning and AST indexing on home/root directory while honoring fallback config for memories', async () => {
    const home = tempDir('jev-home-');
    try {
      // 1. Write synthetic Hermes SQLite memory in home directory
      const { makeHermesDatabase } = await import('./memory-support.ts');
      makeHermesDatabase(home, [{ content: 'Always run tests before commit\nMust execute test runner' }]);

      let receivedQuestions: any = null;
      let receivedState: any = null;
      const transport = (async (_url: any, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        receivedQuestions = body.questions;
        receivedState = body.state;
        const res = responseFor(body);
        if (body.questions.q5_memory_0) {
          res.answers.q5_memory_0 = { type: 'noul', noul: 0.95 };
        }
        return Response.json(res);
      }) as typeof fetch;

      // Project root is the home directory itself
      const nav = new JevNavigator(home, {
        apiKey: 'FAKE',
        enableSkills: false, // user/project overrides or fallback can disable skills
        enableMemories: true, // fallback config keeps memories enabled
      }, home, transport);

      // Verify AST scanning is disabled on home directory
      const graph = nav.getOrGenerateCodeGraph();
      expect(graph.totalFiles).toBe(0);
      expect(graph.dsl).toBe('[~]\n');
      expect(graph.fromCache).toBe(false);

      const decision = await nav.evaluatePrompt('please fix test', [], undefined, { skills: [] });
      expect(decision).not.toBeNull();

      // Subsystem indexing disabled on home root => no codebase_trie_map and no q1_target_subsystem
      expect(receivedState.codebase_trie_map).toBeUndefined();
      expect(receivedQuestions.q1_target_subsystem).toBeUndefined();

      // Memories honored according to fallback config
      expect(receivedQuestions.q5_memory_0).toBeDefined();
      expect(JSON.stringify(receivedQuestions.q5_memory_0.instructions)).toContain('Always run tests before commit');

      // Guidance formatting check: Tail injector should only inject memory, no subsystem
      const guidance = new TailInjector().formatTailGuidance(decision!);
      expect(guidance).not.toContain('Target Subsystem');
      expect(guidance).toContain('Active Memory Guard');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
