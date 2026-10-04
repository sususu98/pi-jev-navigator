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
import { GeminiKeywordExtractor } from '../src/memory/gemini-keyword-extractor.ts';
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

  it('recalls late identifiers, compound filenames and acronym boundaries without aliases', () => {
    makeHermesDatabase(home, [
      { content: 'signature safety isolation', project: 'CPA' },
      { content: 'Response payload contract', project: 'CPA' },
      { content: 'thought signature must remain bound', project: 'CPA' },
    ]);
    const retriever = new HermesMemoryRetriever(home);
    const tasks = [
      '请在 worktree 阅读 AGENTS.md 然后使用 CPA 修复 signature',
      '/Users/example/workspace/project/.worktrees/branch docs/long-design-file.md internal/cache/thought_signature.go',
      'Please inspect HTTPResponseSignature',
      'Please inspect thought-signature',
      `${Array.from({ length: 80 }, (_, i) => `prefix${i}`).join(' ')} thought_signature`,
      `只读审查 ${'工程验证运行测试 '.repeat(1500)} thought_signature`,
    ];
    for (const task of tasks) {
      const result = retriever.retrieve(task, root);
      expect(result.memories.some(memory => memory.rule.includes('signature'))).toBe(true);
      expect(buildMemoryQueries(task).length).toBeLessThanOrEqual(32);
    }
    expect(retriever.retrieve('HTTPResponseSignature', root).memories.some(memory => memory.rule.includes('Response'))).toBe(true);
  });

  it('retains late Chinese lexical evidence in bounded distributed windows', () => {
    makeHermesDatabase(home, [{ content: '磁盘队列刷新必须原样回放', project: 'CPA' }]);
    const task = `只读 ${'工程验证运行测试 '.repeat(1500)} 修复磁盘队列刷新`;
    expect(new HermesMemoryRetriever(home).retrieve(task, root).memories).toHaveLength(1);
  });

  it('plans view coverage before long boilerplate spends the serialized budget', () => {
    makeHermesDatabase(home, [
      { content: `worktree guard ${'whole generic rule '.repeat(300)}`, category: 'correction' },
      { content: `worktree general ${'whole generic rule '.repeat(300)}` },
      { content: 'Quasar capsule binding must not cross tenants', project: 'CPA' },
      { content: 'Quasar capsule FIFO refresh does not expire', project: 'CPA', category: 'correction' },
    ]);
    const result = new HermesMemoryRetriever(home).retrieve('worktree AGENTS.md internal/cache/Quasar_capsule.go', root, { maxTokens: 1800 });
    expect(result.memories.some(memory => memory.rule.includes('binding'))).toBe(true);
    expect(result.memories.some(memory => memory.rule.includes('FIFO'))).toBe(true);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(1800);
    expect(result.stats.budgetLimited).toBe(true);
  });

  it('keeps keyword and baseline sources bounded and records candidate index identities', () => {
    makeHermesDatabase(home, [
      { content: 'Orchid capsule storage', project: 'CPA' },
      { content: 'worktree boundary', category: 'correction' },
      { content: 'Orchid capsule FOREIGN_SECRET', project: 'other' },
    ]);
    const result = new HermesMemoryRetriever(home).retrieve('worktree', root, { extraTerms: ['Orchid_capsule'] });
    expect(result.memories.some(memory => memory.rule.includes('storage'))).toBe(true);
    expect(result.memories.some(memory => memory.rule.includes('boundary'))).toBe(true);
    expect(result.stats.candidateIds).toEqual(result.memories.map(memory => memory.id));
    expect(JSON.stringify(result)).not.toContain('FOREIGN_SECRET');
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(8000);
  });

  it('leaves recalled memory uninjected when Jev rejects all applicability signals', async () => {
    makeHermesDatabase(home, [{ content: 'Quasar capsule complete constraint', project: 'CPA' }]);
    const nav = new JevNavigator(root, { apiKey: 'FAKE', enableSkills: false, enableSubsystems: false,
      enableKeywordExpansion: false, logDecisions: false }, home, (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const response = responseFor(request);
      for (const id of Object.keys(request.questions).filter(id => id.startsWith('q5_memory_'))) {
        response.answers[id] = { type: 'noul', noul: 0.1 };
      }
      return Response.json(response);
    }) as typeof fetch);
    const result = await nav.processUserPrompt('Quasar_capsule.go');
    expect(result.decision?.memoryRetrieval?.candidates).toBe(1);
    expect(result.decision?.activatedMemoryGuards).toEqual([]);
    expect(result.enrichedPrompt).not.toContain('complete constraint');
  });

  it('does not let a full keyword query catalog replace the baseline task', () => {
    makeHermesDatabase(home, [{ content: 'Quasar must preserve capsule binding', project: 'CPA' }]);
    const extras = Array.from({ length: 6 }, (_, i) => `alpha${i}_beta${i}_gamma${i}_delta${i}`);
    const result = new HermesMemoryRetriever(home).retrieve('Quasar', root, { extraTerms: extras });
    expect(result.memories).toHaveLength(1);
    expect(result.stats.queries).toBeLessThanOrEqual(384);
  });

  it('keeps directory identifiers and non-Latin Unicode words searchable', () => {
    makeHermesDatabase(home, [
      { content: 'WebSocket reconnect scope must be isolated', project: 'CPA' },
      { content: 'авторизация сохраняет область клиента', project: 'CPA' },
    ]);
    const retriever = new HermesMemoryRetriever(home);
    expect(retriever.retrieve('internal/WebSocket/config.go', root).memories.some(memory => memory.rule.includes('WebSocket'))).toBe(true);
    expect(retriever.retrieve('авторизация', root).memories.some(memory => memory.rule.includes('авторизация'))).toBe(true);
  });

  it('recalls a later correction beyond a crowded lexical top-20 view', () => {
    makeHermesDatabase(home, [
      ...Array.from({ length: 30 }, (_, i) => ({ content: `Orchid capsule old constraint ${i}`,
        project: 'CPA', category: 'correction', created: '2020-01-01' })),
      { content: `Orchid capsule latest correction ${'complete later constraint '.repeat(30)}`,
        project: 'CPA', category: 'correction', created: '2026-10-02' },
    ]);
    const result = new HermesMemoryRetriever(home).retrieve('Orchid_capsule', root);
    expect(result.memories.some(memory => memory.rule.includes('latest correction'))).toBe(true);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(8000);
  });

  it('uses model-derived conjunctions without broadening misses or explicit empty groups', () => {
    makeHermesDatabase(home, [
      { content: 'Orchid capsule tenant isolation', project: 'CPA' },
      { content: 'Orchid unrelated authentication', project: 'CPA' },
      { content: 'capsule deployment on unrelated project', project: 'other' },
      { content: 'capsule unrelated deploy', project: 'CPA' },
    ]);
    const retriever = new HermesMemoryRetriever(home);
    const result = retriever.retrieve('continue', root, { extraTerms: ['Orchid', 'capsule'], queryGroups: [['Orchid', 'capsule']] });
    expect(result.memories.map(memory => memory.rule)).toEqual(['Orchid capsule tenant isolation']);
    // A plan with zero hits falls back to the task's own lexical evidence; Jev still judges applicability.
    const zeroHit = retriever.retrieve('Orchid', root, { queryGroups: [['Orchid', 'absent']] });
    expect(zeroHit.stats.keywordFallback).toBe('zero-hit');
    expect(zeroHit.memories.length).toBeGreaterThan(0);
    expect(retriever.retrieve('continue', root, { queryGroups: [['Orchid', 'absent']] }).memories).toEqual([]);
    expect(retriever.retrieve('Orchid', root, { extraTerms: ['Orchid'], queryGroups: [] }).memories).toEqual([]);
    expect(retriever.retrieve('Orchid', root).memories.length).toBeGreaterThan(0);
    const compound = retriever.retrieve('continue', root, { queryGroups: [['cross-protocol-Orchid_capsule']] });
    expect(compound.memories.some(memory => memory.rule.includes('tenant isolation'))).toBe(true);
    expect(compound.memories.some(memory => memory.rule.includes('unrelated'))).toBe(false);
  });

  it('supports model-planned activity constraints whose memory omits the component name', async () => {
    makeHermesDatabase(home, [
      { content: 'Orchid capsule 缓存需要保持历史前缀', target: 'memory', project: 'CPA' },
      { content: '日志取证必须关联会话标识、请求标识与日志正文', target: 'failure', category: 'preference' },
      { content: '日志取证无关项目秘密', target: 'failure', project: 'other' },
      { content: '数据库维护与当前任务无关', target: 'memory', project: 'CPA' },
      { content: '日志取证工作偏好：每次分析都需附带证据路径', target: 'user', category: 'preference' },
    ]);
    const extractor = new GeminiKeywordExtractor(home, (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const data = JSON.parse(request.contents[0].parts[0].text);
      expect(data.current_request).toBe('改了思考等级，又掉缓存'.normalize('NFKC'));
      expect(data.recent_context[0].text).toContain('Orchid capsule');
      expect(JSON.stringify(request)).not.toContain('日志取证必须关联');
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        needsMemory: true, subject: 'Orchid capsule', terms: ['Orchid capsule', '日志取证'],
        queryGroups: [['Orchid capsule'], ['日志取证']], memoryTargets: ['memory', 'failure', 'user'],
      }) }] } }] });
    }) as typeof fetch, { baseUrl: 'http://example.invalid', apiKey: 'FAKE' });
    const plan = await extractor.extract('改了思考等级，又掉缓存', {
      recentContext: [{ role: 'user', text: '继续分析 Orchid capsule 的请求日志，排查缓存异常' }],
    });
    expect(plan.status).toBe('ready');
    const result = new HermesMemoryRetriever(home).retrieve('改了思考等级，又掉缓存', root, {
      queryGroups: plan.queryGroups, targets: plan.memoryTargets,
    });
    expect(result.stats.candidateIds?.sort()).toEqual(['hermes_1', 'hermes_2', 'hermes_5']);
    expect(result.memories.find(memory => memory.id === 'hermes_5')?.sourceTarget).toBe('user');
    expect(result.memories.find(memory => memory.id === 'hermes_2')?.sourceTarget).toBe('failure');
    expect(JSON.stringify(result)).not.toContain('无关项目秘密');
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(8000);
  });

  it('uses prior user requests only for the mechanical fallback', () => {
    makeHermesDatabase(home, [
      { content: 'Orchid capsule tenant isolation', target: 'memory', project: 'CPA' },
      { content: 'unrelated database note', target: 'memory', project: 'CPA' },
    ]);
    const retriever = new HermesMemoryRetriever(home);
    expect(retriever.retrieve('continue', root).memories).toEqual([]);
    const fallback = retriever.retrieve('continue', root, { contextText: 'Implement Orchid capsule' });
    expect(fallback.memories.map(memory => memory.rule)).toEqual(['Orchid capsule tenant isolation']);
    const zeroHit = retriever.retrieve('continue', root, { queryGroups: [['absent subject']], contextText: 'Implement Orchid capsule' });
    expect(zeroHit.stats.keywordFallback).toBe('zero-hit');
    expect(zeroHit.memories.map(memory => memory.rule)).toEqual(['Orchid capsule tenant isolation']);
    // A successful model plan stays authoritative; an empty plan never broadens through context.
    expect(retriever.retrieve('continue', root, { queryGroups: [], contextText: 'Implement Orchid capsule' }).memories).toEqual([]);
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
