import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { HermesMemoryRetriever, buildMemoryQueries } from '../src/memory/hermes-retriever.ts';
import { JevPrompter } from '../src/jev/prompter.ts';
import { JevNavigator } from '../src/index.ts';
import { formatMemoryRetrieval, formatTokens } from '../src/jev/stats.ts';
import { makeHermesDatabase } from './memory-support.ts';
import { put, responseFor } from './support.ts';

let base: string, home: string, root: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-hermes-retrieve-'));
  home = path.join(base, 'home'); root = path.join(base, 'CPA');
  fs.mkdirSync(home); fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('read-only Hermes retrieval', () => {
  it('queries global and canonical project separately and excludes unrelated projects', () => {
    const file = makeHermesDatabase(home, [
      { content: 'WebSocket global constraint' },
      { content: 'WebSocket project constraint', project: 'CPA' },
      { content: 'WebSocket FOREIGN_SECRET', project: 'foreign' },
    ]);
    const before = fs.readFileSync(file);
    const result = new HermesMemoryRetriever(home).retrieve('WebSocket', root);
    expect(result.stats.eligible).toBe(2);
    expect(result.memories).toHaveLength(2);
    expect(result.memories.map(m => m.project).sort()).toEqual(['CPA', 'global']);
    expect(JSON.stringify(result)).not.toContain('FOREIGN_SECRET');
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('inherits the main repository identity for linked worktrees', () => {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
    const worktree = path.join(base, 'different-worktree-name');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'test', worktree]);
    makeHermesDatabase(home, [{ content: 'WebSocket CPA rule', project: 'CPA' }, { content: 'WebSocket wrong rule', project: 'different-worktree-name' }]);
    const r = new HermesMemoryRetriever(home).retrieve('WebSocket', worktree);
    expect(r.stats.eligible).toBe(1);
    expect(r.memories[0].project).toBe('CPA');
  });

  it('respects configured Hermes memoryDir and its legacy alias', () => {
    const custom = path.join(home, 'custom-store');
    makeHermesDatabase(home, [{ content: 'WebSocket custom rule' }], custom);
    put(path.join(home, '.pi/agent/hermes-memory-config.json'), JSON.stringify({ memoryDir: custom }));
    expect(new HermesMemoryRetriever(home).retrieve('WebSocket', root).memories[0].rule).toContain('custom');
    makeHermesDatabase(home, [{ content: 'WebSocket modern rule' }]);
    put(path.join(home, '.pi/agent/hermes-memory-config.json'), JSON.stringify({ memoryDir: path.join(home, '.pi/agent/memory') }));
    expect(new HermesMemoryRetriever(home).retrieve('WebSocket', root).memories[0].rule).toContain('modern');
  });

  it('finds matching old constraints regardless of archive recency or corpus size', () => {
    makeHermesDatabase(home, [
      ...Array.from({ length: 1800 }, (_, i) => ({ content: `Unrelated maintenance ${i}` })),
      { content: 'WebSocket critical old correction', created: '2020-01-01' },
    ]);
    const r = new HermesMemoryRetriever(home).retrieve('WebSocket', root);
    expect(r.stats.eligible).toBe(1801);
    expect(r.stats.candidates).toBe(1);
    expect(r.memories[0].rule).toContain('critical old');
  });

  it('bounds actual serialized memory question and candidate counts without clipping rules', () => {
    makeHermesDatabase(home, Array.from({ length: 100 }, (_, i) => ({ content: `WebSocket constraint ${i}: ${'Whole rule '.repeat(100)}`, project: i % 2 ? 'CPA' : null })));
    const r = new HermesMemoryRetriever(home).retrieve('WebSocket', root, { maxCandidates: 8, maxTokens: 1500 });
    const questions = Object.fromEntries(Object.entries(new JevPrompter().buildQuestions('', [], [], r.memories).questions).filter(([id]) => id.startsWith('q5_memory_')));
    expect(r.memories.length).toBeGreaterThan(0);
    expect(r.memories.length).toBeLessThanOrEqual(8);
    expect(Math.ceil(Buffer.byteLength(JSON.stringify(questions)) / 2.85)).toBeLessThanOrEqual(1500);
    expect(r.stats.budgetLimited).toBe(true);
    expect(new Set(r.memories.map(m => m.project)).size).toBe(2);
    expect(r.memories.every(m => m.rule.endsWith('Whole rule '))).toBe(true);
  });

  it('recalls mixed Chinese/identifier tasks without topic aliases and splits Unicode colons', () => {
    makeHermesDatabase(home, [
      { content: 'Orchid Atlas Messages baseUrl 配置必须使用根地址，不要重复拼接路径', target: 'memory', category: 'convention' },
      { content: 'Orchid 公共调度器冷却上限风险，禁止统一截断周限额等待', category: 'insight', target: 'failure', project: 'CPA' },
      ...Array.from({ length: 40 }, (_, i) => ({ content: `Orchid unrelated convention ${i}`, category: 'insight', target: 'memory' })),
    ]);
    const retriever = new HermesMemoryRetriever(home);
    const first = retriever.retrieve('只读分析 Orchid Atlas Messages：baseUrl 配置有何约束？', root);
    expect(first.memories.some(m => m.id === 'hermes_1')).toBe(true);
    expect(buildMemoryQueries('Orchid Atlas Messages：baseUrl')).not.toContain('"Orchid" AND "Atlas" AND "Messages:baseUrl"');
    const second = retriever.retrieve('Orchid 公共调度器统一加冷却上限，有何风险？', root);
    expect(second.memories.some(m => m.id === 'hermes_2')).toBe(true);
  });

  it('protects correction/preference candidate representation from ordinary memories', () => {
    makeHermesDatabase(home, [
      ...Array.from({ length: 60 }, (_, i) => ({ content: `WebSocket ordinary ${i}`, target: 'memory', category: 'insight' })),
      { content: 'WebSocket safety correction long rule', category: 'correction' },
    ]);
    const r = new HermesMemoryRetriever(home).retrieve('WebSocket', root, { maxCandidates: 2 });
    expect(r.memories.some(m => m.category === 'correction')).toBe(true);
  });

  it('refreshes live SQLite records immediately without a five-minute cache', () => {
    const file = makeHermesDatabase(home, [{ content: 'WebSocket initial' }]);
    const retriever = new HermesMemoryRetriever(home);
    expect(retriever.retrieve('WebSocket', root).memories).toHaveLength(1);
    const db = new DatabaseSync(file);
    db.exec("INSERT INTO memories VALUES(2,NULL,'failure','correction','WebSocket added','2026-09-30','2026-09-30'); INSERT INTO memory_fts(rowid,content) VALUES(2,'WebSocket added')"); db.close();
    expect(retriever.retrieve('WebSocket', root).memories).toHaveLength(2);
  });

  it('never falls back to all Markdown on empty/missing/corrupt/unsupported SQLite', () => {
    put(path.join(home, '.pi/agent/pi-hermes-memory/failures.md'), '[correction] SECRET_FALLBACK');
    const retriever = new HermesMemoryRetriever(home);
    expect(retriever.retrieve('WebSocket', root).stats.status).toBe('unavailable');
    const file = makeHermesDatabase(home, [{ content: 'Unrelated memory' }]);
    expect(retriever.retrieve('WebSocket', root).stats.status).toBe('empty');
    const db = new DatabaseSync(file); db.exec('DROP TABLE memory_fts'); db.close();
    expect(retriever.retrieve('WebSocket', root).stats.status).toBe('unsupported');
    fs.writeFileSync(file, 'invalid SQLite');
    expect(retriever.retrieve('WebSocket', root).memories).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('invalid SQLite');
  });

  it('quotes lexical queries, bounds input and honors cancellation/zero budgets', () => {
    expect(buildMemoryQueries('CPA " OR NOT ; DROP TABLE memories --')).not.toEqual([]);
    expect(buildMemoryQueries('汉字')).toEqual([]); // trigram cannot index two-character terms
    expect(buildMemoryQueries('term '.repeat(100000)).length).toBeLessThanOrEqual(7);
    const retriever = new HermesMemoryRetriever(home);
    expect(retriever.retrieve('WebSocket', root, { maxCandidates: 0 }).stats.status).toBe('disabled');
    expect(retriever.retrieve('WebSocket', root, { signal: AbortSignal.abort() }).stats.status).toBe('cancelled');
  });

  it('does not send the corpus to Jev and reports retrieval/selection separately', async () => {
    makeHermesDatabase(home, [...Array.from({ length: 1800 }, (_, i) => ({ content: `Irrelevant note ${i}` })), { content: 'WebSocket must preserve deadlines' }]);
    let requests = 0;
    const transport = (async (_url, init) => {
      requests++;
      const req = JSON.parse(String(init?.body));
      expect(JSON.stringify(req)).not.toContain('Irrelevant note');
      const ids = Object.keys(req.questions).filter(id => id.startsWith('q5_memory_'));
      expect(ids).toHaveLength(1);
      const response = responseFor(req);
      response.answers[ids[0]] = { type: 'noul', noul: 0.95 };
      return Response.json(response);
    }) as typeof fetch;
    const nav = new JevNavigator(root, { apiKey: 'FAKE', enableSkills: false, enableSubsystems: false, logDecisions: false }, home, transport);
    const r = await nav.processUserPrompt('WebSocket');
    expect(requests).toBe(1);
    expect(r.decision?.memoryRetrieval?.eligible).toBe(1801);
    expect(r.decision?.memoryRetrieval?.candidates).toBe(1);
    expect(r.decision?.memoryRetrieval?.selected).toBe(1);
    expect(formatMemoryRetrieval(r.decision!.memoryRetrieval!)).toContain('1,801 eligible → 1 candidates → 1 selected');
    expect(formatMemoryRetrieval(r.decision!.memoryRetrieval!)).toContain('Retrieval:');
    expect(formatMemoryRetrieval(r.decision!.memoryRetrieval!)).toContain('estimated');
    expect(formatTokens(403051)).toBe('403.1K'); expect(formatTokens(1419609)).toBe('1.42M');
  });
});
