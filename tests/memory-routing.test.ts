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
