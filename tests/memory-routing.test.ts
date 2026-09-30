import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JevNavigator } from '../src/index.ts';
import { MemoryCollector } from '../src/memory/collector.ts';
import { JevPrompter } from '../src/jev/prompter.ts';
import type { JevSystemOneRequest, MemoryGuard } from '../src/types.ts';
import { put, responseFor } from './support.ts';

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

describe('task-relevant memory routing', () => {
  it('lets Jev see and select an old relevant rule beyond the legacy cutoff', async () => {
    const records = Array.from({ length: 100 }, (_, i) => block(`unrelated-${i}`));
    records.push('[insight] old-relevant-procedure\nPrecisely follow this old SOP\n<!-- last=2020-01-01 -->');
    records.push(block('FOREIGN_PROJECT_SECRET', 'another-project'));
    put(file(), records.join('\n§\n'));
    let observed = 0;
    const transport = (async (_url, init) => {
      const request: JevSystemOneRequest = JSON.parse(String(init?.body));
      const q = request.questions.q5_memory_guard;
      if (q.type !== 'choice') throw new Error('expected choices');
      observed = Object.keys(q.criteria).length - 1;
      expect(JSON.stringify(request)).not.toContain('FOREIGN_PROJECT_SECRET');
      const selected = Object.keys(q.criteria).find((id) => q.criteria[id].includes('old-relevant-procedure'))!;
      expect(selected).toBeDefined();
      const response = responseFor(request);
      response.answers.q5_memory_guard = { type: 'choice', choice: selected, confidence: 1, probabilities: { [selected]: 1 } };
      return Response.json(response);
    }) as typeof fetch;
    const nav = new JevNavigator(root, {
      apiKey: 'FAKE', logDecisions: false, enableSubsystems: false, enableSkills: false,
      maxMemoryGuards: 1, maxInjectedMemoryGuards: 1,
    }, home, transport);
    const result = await nav.processUserPrompt('Use the old relevant procedure');
    expect(observed).toBe(101);
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

  it('limits only Jev-selected tail guards, ordered by its winning choice and probabilities', () => {
    const memories: MemoryGuard[] = Array.from({ length: 4 }, (_, i) => ({
      id: `mem_${i}`, category: 'correction', title: `rule-${i}`, summary: `rule-${i}`, rule: `rule-${i}`,
    }));
    const answers = { q5_memory_guard: {
      type: 'choice' as const, choice: 'mem_3', confidence: 0.9,
      probabilities: { mem_0: 0.25, mem_1: 0.3, mem_2: 0.05, mem_3: 0.4 },
    } };
    const parse = (limit: number) => new JevPrompter().parseAnswers(answers, [], {}, 0, 0, memories, [], limit);
    expect(parse(2).activatedMemoryGuards?.map((guard) => guard.id)).toEqual(['mem_3', 'mem_1']);
    expect(parse(0).activatedMemoryGuards).toBeUndefined();
    expect(memories).toHaveLength(4);
  });
});
