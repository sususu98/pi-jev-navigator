import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JevNavigator } from '../src/index.ts';
import { MemoryCollector } from '../src/memory/collector.ts';
import { JevPrompter } from '../src/jev/prompter.ts';
import type { JevSystemOneRequest, MemoryGuard } from '../src/types.ts';
import { put, responseFor } from './support.ts';
import { makeHermesDatabase } from './memory-support.ts';

let temporary: string;
let home: string;
let root: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-memory-routing-'));
  home = path.join(temporary, 'home'); root = path.join(temporary, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

const file = () => path.join(home, '.pi/agent/pi-hermes-memory/failures.md');
const block = (title: string, project = 'global') =>
  `[correction] ${title}\nEnforce ${title}\n<!-- project64=${Buffer.from(project).toString('base64')} last=2026-09-30 -->`;

describe('memory file freshness', () => {
  it('observes appended, edited, deleted and newly created rules without waiting for TTL', () => {
    const collector = new MemoryCollector(home);
    expect(collector.collectMemories(root)).toEqual([]);
    put(file(), block('before'));
    expect(collector.collectMemories(root).map((guard) => guard.title)).toEqual(['before']);
    fs.appendFileSync(file(), '\n§\n' + block('appended'));
    expect(collector.collectMemories(root).map((guard) => guard.title).sort()).toEqual(['appended', 'before']);
    put(file(), block('edited'));
    expect(collector.collectMemories(root).map((guard) => guard.title)).toEqual(['edited']);
    fs.unlinkSync(file());
    expect(collector.collectMemories(root)).toEqual([]);
    put(path.join(home, '.pi/agent/pi-hermes-memory/USER.md'), block('new-preference'));
    expect(collector.collectMemories(root).map((guard) => guard.title)).toEqual(['new-preference']);
  });

  it('detects equal-size edits even with restored mtime, and atomic inode replacements', () => {
    put(file(), block('before'));
    const collector = new MemoryCollector(home);
    expect(collector.collectMemories(root)[0].title).toBe('before');
    const stat = fs.statSync(file());
    // Same byte count and old mtime do not hide the changed ctime.
    put(file(), block('edited'));
    fs.utimesSync(file(), stat.atime, stat.mtime);
    expect(collector.collectMemories(root)[0].title).toBe('edited');
    const temporaryFile = file() + '.replacement';
    put(temporaryFile, block('atomic'));
    fs.utimesSync(temporaryFile, stat.atime, stat.mtime);
    fs.renameSync(temporaryFile, file());
    expect(collector.collectMemories(root)[0].title).toBe('atomic');
  });

  it('reuses parsed blocks from unchanged files when only one source changes', () => {
    const user = path.join(home, '.pi/agent/pi-hermes-memory/USER.md');
    put(file(), block('first')); put(user, block('preference'));
    const read = spyOn(fs, 'readFileSync');
    try {
      const collector = new MemoryCollector(home);
      collector.collectMemories(root); collector.collectMemories(root);
      const count = (target: string) => read.mock.calls.filter((args) => args[0] === target).length;
      expect(count(file())).toBe(1); expect(count(user)).toBe(1);
      fs.appendFileSync(file(), '\n§\n' + block('new-correction'));
      expect(collector.collectMemories(root).some((guard) => guard.title === 'new-correction')).toBe(true);
      expect(count(file())).toBe(2); expect(count(user)).toBe(1);
    } finally { read.mockRestore(); }
  });
});

describe('task-relevant memory routing', () => {
  it('retrieves an old relevant rule beyond the legacy cutoff without sending unrelated memory', async () => {
    makeHermesDatabase(home, [
      ...Array.from({ length: 100 }, (_, i) => ({ content: `unrelated-${i}` })),
      { content: 'old-relevant-procedure\nPrecisely follow this old SOP', category: 'insight', created: '2020-01-01' },
      { content: 'FOREIGN_PROJECT_SECRET relevant procedure', project: 'another-project' },
    ]);
    let observed = 0;
    const transport = (async (_url, init) => {
      const request: JevSystemOneRequest = JSON.parse(String(init?.body));
      const ids = Object.keys(request.questions).filter(id => id.startsWith('q5_memory_'));
      observed = ids.length;
      expect(JSON.stringify(request)).not.toContain('FOREIGN_PROJECT_SECRET');
      const selected = ids.find(id => JSON.stringify(request.questions[id]).includes('old-relevant-procedure'))!;
      expect(selected).toBeDefined();
      const response = responseFor(request);
      response.answers[selected] = { type: 'noul', noul: 0.95 };
      return Response.json(response);
    }) as typeof fetch;
    const nav = new JevNavigator(root, {
      apiKey: 'FAKE', logDecisions: false, enableSubsystems: false, enableSkills: false,
      maxMemoryGuards: 1, maxInjectedMemoryGuards: 1,
    }, home, transport);
    const result = await nav.processUserPrompt('Use the old relevant procedure');
    expect(observed).toBe(1);
    expect(result.enrichedPrompt).toContain('Precisely follow this old SOP');
    expect(result.enrichedPrompt).not.toContain('unrelated-');
    expect(result.decision?.activatedMemoryGuards).toHaveLength(1);
    expect(nav.getConfigStore().getDiagnostics().join(' ')).toContain('no longer limits routing candidates');
  });

  it('routes follow-ups with redacted background and anchored lexical recall, then clears memory on a new topic', async () => {
    makeHermesDatabase(home, [
      { content: 'Orchid capsule must retain tenant isolation', target: 'memory', project: 'repo' },
      { content: 'Orchid capsule GLOBAL_FACT', target: 'memory' },
      { content: 'Orchid capsule FAILURE_RECORD', target: 'failure', project: 'repo' },
      { content: 'Orchid unrelated credential workflow' },
      { content: 'general testing workflow unrelated to capsule' },
    ]);
    put(path.join(home, '.pi/agent/cliproxyapi.json'), JSON.stringify({ baseUrl: 'https://cpa.fixture.invalid', apiKey: 'CPA_CONTEXT_SECRET' }));
    const requests: any[] = [];
    let needsMemory = true;
    const transport = (async (url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      expect(JSON.stringify(request)).not.toContain('CPA_CONTEXT_SECRET');
      expect(JSON.stringify(request)).not.toContain('JEV_CONTEXT_SECRET');
      if (String(url).includes(':generateContent')) {
        expect(requests[0].contents[0].parts[0].text).toContain('Orchid capsule');
        const input = JSON.parse(request.contents[0].parts[0].text);
        expect(input.memory_range).toEqual({ project: 'repo', scopes: ['global', 'current-project'], targets: ['memory', 'user', 'failure', 'project'] });
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ needsMemory,
          subject: needsMemory ? 'Orchid capsule' : '', terms: needsMemory ? ['Orchid capsule'] : [],
          queryGroups: needsMemory ? [['Orchid', 'capsule']] : [], memoryTargets: needsMemory ? ['project'] : [] }) }] } }] });
      }
      expect(request.state.user_task).toContain('current_request');
      expect(request.state.user_task).toContain('recent_context');
      expect(JSON.stringify(request.questions)).not.toContain('unrelated');
      expect(JSON.stringify(request.questions)).not.toContain('GLOBAL_FACT');
      expect(JSON.stringify(request.questions)).not.toContain('FAILURE_RECORD');
      const response = responseFor(request);
      for (const id of Object.keys(request.questions).filter(id => id.startsWith('q5_memory_'))) response.answers[id] = { type: 'noul', noul: 0.95 };
      return Response.json(response);
    }) as typeof fetch;
    const nav = new JevNavigator(root, { apiKey: 'JEV_CONTEXT_SECRET', enableSkills: false, enableSubsystems: false, logDecisions: false }, home, transport);
    const recentContext = [{ role: 'user' as const, text: 'Implement Orchid capsule CPA_CONTEXT_SECRET JEV_CONTEXT_SECRET' }];
    const original = JSON.stringify(recentContext);
    const first = await nav.evaluatePrompt('continue', [], undefined, { recentContext });
    expect(first?.activatedMemoryGuards?.[0].rule).toContain('tenant isolation');
    expect(first?.memoryRetrieval?.candidates).toBe(1);
    expect(first?.memoryRetrieval?.project).toBe('repo');
    expect(first?.memoryRetrieval?.targets).toEqual(['project']);
    expect(first?.activatedMemoryGuards?.[0].sourceTarget).toBe('project');
    expect(first?.memoryRetrieval?.keywordQueryGroups?.[0]).toEqual(['Orchid capsule']);
    needsMemory = false;
    const second = await nav.evaluatePrompt('New topic: documentation typos only', [], undefined, { recentContext });
    expect(second?.activatedMemoryGuards).toEqual([]);
    expect(second?.memoryRetrieval?.candidates).toBe(0);
    expect(JSON.stringify(recentContext)).toBe(original);
  });

  it('uses baseline lexical recall after a malformed model query group rather than suppressing all memory', async () => {
    makeHermesDatabase(home, [{ content: 'Orchid capsule critical rule' }]);
    put(path.join(home, '.pi/agent/cliproxyapi.json'), JSON.stringify({ baseUrl: 'https://cpa.fixture.invalid', apiKey: 'FAKE_CPA' }));
    const nav = new JevNavigator(root, { apiKey: 'FAKE_JEV', enableSkills: false, enableSubsystems: false, logDecisions: false }, home, (async (url, init) => {
      if (String(url).includes(':generateContent')) return Response.json({ candidates: [{ content: { parts: [{ text: '{"terms":["Orchid"],"queryGroups":[["ab"]]}' }] } }] });
      return Response.json(responseFor(JSON.parse(String(init?.body))));
    }) as typeof fetch);
    const result = await nav.evaluatePrompt('Orchid capsule');
    expect(result?.memoryRetrieval?.keywordStatus).toBe('error');
    expect(result?.memoryRetrieval?.candidates).toBe(1);
  });

  it('redacts configured CPA credentials from default telemetry as well as routing requests', async () => {
    put(path.join(home, '.pi/agent/cliproxyapi.json'), JSON.stringify({ baseUrl: 'https://cpa.fixture.invalid', apiKey: 'CPA_LOG_SECRET' }));
    const nav = new JevNavigator(root, { apiKey: 'JEV_LOG_SECRET', enableKeywordExpansion: false,
      enableSkills: false, enableSubsystems: false, logDecisions: true }, home, (async (_url, init) =>
      Response.json(responseFor(JSON.parse(String(init?.body))))) as typeof fetch);
    await nav.evaluatePrompt('Check CPA_LOG_SECRET and JEV_LOG_SECRET', [], { sessionId: 'context-redaction' });
    const slug = `--${root.replace(/^\/+/, '').replace(/\/+/g, '-')}--`;
    const log = fs.readFileSync(path.join(home, '.pi/agent/jev-sessions', slug, 'context-redaction.jsonl'), 'utf8');
    expect(log).not.toContain('CPA_LOG_SECRET');
    expect(log).not.toContain('JEV_LOG_SECRET');
    expect(log).toContain('[REDACTED]');
  });

  it('uses Hermes defaults for corrupt configuration without disabling Skills/Overview', async () => {
    put(path.join(home, '.pi/agent/hermes-memory-config.json'), '{broken');
    put(path.join(root, 'index.ts'), 'export function FixtureSymbol() {}');
    const transport = (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.questions.q2_skill_0).toBeDefined();
      expect(request.state.codebase_trie_map).toContain('FixtureSymbol');
      return Response.json(responseFor(request));
    }) as typeof fetch;
    const nav = new JevNavigator(root, { apiKey: 'FAKE', enableMemories: false, logDecisions: false }, home, transport);
    const result = await nav.evaluatePrompt('Inspect the fixture', [], undefined, { skills: [{ name: 'fixture', description: 'Fixture SOP', path: '/fixture/SKILL.md' }] });
    expect(result).not.toBeNull();
    expect(result?.bypassed).not.toBe(true);
  });

  it('defaults to all scoped candidates while preserving explicit standalone collection limits', () => {
    put(file(), Array.from({ length: 120 }, (_, i) => block(`rule-${i}`)).join('\n§\n'));
    const collector = new MemoryCollector(home);
    expect(collector.collectMemories(root)).toHaveLength(120);
    expect(collector.collectMemories(root, 1)).toHaveLength(1);
  });

  it('caps independently applicable guards in stable identity order', () => {
    const memories: MemoryGuard[] = Array.from({ length: 4 }, (_, i) => ({
      id: `mem_${i}`, category: 'correction', title: `rule-${i}`, summary: `rule-${i}`, rule: `rule-${i}`,
    }));
    const answers = Object.fromEntries(memories.map((_memory, i) => [`q5_memory_${i}`, {
      type: 'noul' as const, noul: i === 2 ? 0.05 : 0.95,
    }]));
    const parse = (limit: number) => new JevPrompter().parseAnswers(answers, [], {}, 0, 0, memories, [], limit);
    expect(parse(2).activatedMemoryGuards?.map((guard) => guard.id)).toEqual(['mem_0', 'mem_1']);
    expect(parse(0).activatedMemoryGuards).toEqual([]);
    expect(memories).toHaveLength(4);
  });
});
