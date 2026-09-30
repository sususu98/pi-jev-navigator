import { describe, expect, it } from 'bun:test';
import { JevClient } from '../src/jev/client.ts';
import { JevDualPipeline } from '../src/jev/pipeline.ts';
import { JevPrompter } from '../src/jev/prompter.ts';
import { estimateRequestTokens, MAX_REQUEST_TOKENS } from '../src/jev/capacity.ts';
import { formatRoutingStats } from '../src/jev/stats.ts';
import type { JevSystemOneRequest, MemoryGuard, SkillSummary } from '../src/types.ts';
import { responseFor } from './support.ts';

const inputs = { userPrompt: 'task', dsl: '[src]\n a.ts->A', estimatedTokens: 1, skills: [] as SkillSummary[], memories: [] as MemoryGuard[], safetyRules: [] as string[] };
const memory = (i: number): MemoryGuard => ({ id: `mem_${i}`, category: 'correction', title: `rule-${i}`, summary: `rule-${i}`, rule: `rule-${i}` });
const pipeline = (transport: typeof fetch) => new JevDualPipeline(new JevClient('https://fixture.invalid', 'test', 'FAKE', undefined, '/unused', transport), new JevPrompter());
const parse = (init?: RequestInit): JevSystemOneRequest => JSON.parse(String(init?.body));
function assertBounded(request: JevSystemOneRequest) {
  expect(estimateRequestTokens(request, request.model)).toBeLessThanOrEqual(MAX_REQUEST_TOKENS);
  for (const q of Object.values(request.questions)) {
    if (q.type === 'choice') expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(255);
  }
}

describe('bounded Jev tracks and independent catalog routing', () => {
  it('switches at exactly 28K using the complete serialized payload and real model name', async () => {
    const memories = [memory(0)];
    const { questions } = new JevPrompter().buildQuestions(inputs.dsl, [], [], memories);
    const base = { model: 'test', state: { user_task: '', codebase_trie_map: inputs.dsl }, questions };
    const padding = Math.floor(28000 * 2.85) - Buffer.byteLength(JSON.stringify(base));
    const requests: JevSystemOneRequest[] = [];
    const transport = (async (_url, init) => { const r = parse(init); assertBounded(r); requests.push(r); return Response.json(responseFor(r)); }) as typeof fetch;
    const exact = await pipeline(transport).execute({ ...inputs, memories, userPrompt: 'x'.repeat(padding) }, {});
    expect(exact?.estimatedPayloadTokens).toBe(28000);
    expect(exact?.pipelineMode).toBe('unified');
    expect(requests).toHaveLength(1);
    const above = await pipeline(transport).execute({ ...inputs, memories, userPrompt: 'x'.repeat(padding + 1) }, {});
    expect(above?.estimatedPayloadTokens).toBe(28001);
    expect(above?.pipelineMode).toBe('parallel');
    expect(requests).toHaveLength(3);
  });

  it('dispatches Overview separately from Skills + Mem, concurrently, without requiring memories', async () => {
    const skills = [{ name: 'SOP', description: 'metadata only', path: '/fixture/SKILL.md' }];
    const requests: JevSystemOneRequest[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const transport = (async (_url, init) => {
      const r = parse(init); requests.push(r);
      if (requests.length === 2) release();
      await bothStarted;
      assertBounded(r);
      return Response.json(responseFor(r));
    }) as typeof fetch;
    const decision = await pipeline(transport).execute({ ...inputs, skills }, { executionMode: 'parallel' });
    expect(decision?.pipelineMode).toBe('parallel');
    const a = requests.find((r) => r.questions.q1_target_subsystem)!;
    const b = requests.find((r) => r.questions.q2_skill_0)!;
    expect(a.questions.q2_skill_0).toBeUndefined();
    expect(a.questions.q5_memory_0).toBeUndefined();
    expect(a.state.codebase_trie_map).toBe(inputs.dsl);
    expect(b.state.codebase_trie_map).toBeUndefined();
    expect(b.questions.q4_complexity_risk).toBeUndefined();
    expect(a.state.user_task).toBe('task');
    expect(b.state.user_task).toBe('task');
    expect(formatRoutingStats(decision!)).toContain('Track B (Skills + Mem)');
  });

  it('covers 1000 skills and 600 memories in bounded batches and preserves every independent strong Noul signal', async () => {
    const skills = Array.from({ length: 1000 }, (_, i) => ({ name: `skill-${i}`, description: `Metadata ${i} ${'details '.repeat(40)}`, path: `/fixture/${i}/SKILL.md` }));
    const memories = Array.from({ length: 600 }, (_, i) => memory(i));
    const seenSkills = new Set<string>(); const seenMemories = new Set<string>();
    let calls = 0;
    const transport = (async (_url, init) => {
      const r = parse(init); assertBounded(r); calls++;
      const response = responseFor(r);
      for (const [id, q] of Object.entries(r.questions)) {
        if (!id.startsWith('q2_skill_') && !id.startsWith('q5_memory_')) continue;
        expect(q.type).toBe('noul');
        const seen = id.startsWith('q2_skill_') ? seenSkills : seenMemories;
        expect(seen.has(id)).toBe(false); // no rerouting or batch top-1 elimination
        seen.add(id);
        const applicable = ['q2_skill_998', 'q2_skill_999', 'q5_memory_598', 'q5_memory_599'].includes(id);
        response.answers[id] = { type: 'noul', noul: applicable ? 0.95 : 0.05 };
      }
      return Response.json(response);
    }) as typeof fetch;
    const decision = await pipeline(transport).execute({ ...inputs, skills, memories }, {});
    expect(decision?.bypassed).not.toBe(true);
    expect(decision?.pipelineMode).toBe('parallel');
    expect(seenSkills.size).toBe(1000);
    expect(seenMemories.size).toBe(600);
    expect(decision?.activatedSkills?.map(s => s.path)).toEqual(['/fixture/998/SKILL.md', '/fixture/999/SKILL.md']);
    expect(decision?.activatedMemoryGuards?.map(m => m.id)).toEqual(['mem_598', 'mem_599']);
    expect(decision?.tokenBreakdown?.catalogRequests).toBeGreaterThan(2);
    expect(decision?.tokenBreakdown?.totalRequests).toBe(calls);
    expect(decision?.inputTokens).toBe(calls * 100);
    expect(formatRoutingStats(decision!)).toContain('aggregate,');
  });

  it('preserves globally strongest signals across batches and candidate permutations', async () => {
    const skills = Array.from({ length: 350 }, (_, i) => ({ name: `s-${i}`, description: 'metadata '.repeat(40), path: `/s/${i}` }));
    const memories = Array.from({ length: 350 }, (_, i) => ({ ...memory(i), rule: 'Whole memory constraint '.repeat(30) }));
    const probability = (identity: string) => identity.endsWith('349') ? 0.99 : identity.endsWith('175') ? 0.97 : identity.endsWith('1') ? 0.8 : 0.05;
    const transport = (async (_url, init) => {
      const request = parse(init); assertBounded(request);
      const response = responseFor(request);
      for (const [id, question] of Object.entries(request.questions)) {
        if (!id.startsWith('q2_skill_') && !id.startsWith('q5_memory_')) continue;
        expect(question.type).toBe('noul');
        const candidate = (question.instructions as any).candidate;
        expect(JSON.stringify(request.state)).not.toContain(candidate.path ?? candidate.id);
        response.answers[id] = { type: 'noul', noul: probability(candidate.path ?? candidate.id) };
      }
      return Response.json(response);
    }) as typeof fetch;
    for (const reverse of [false, true]) {
      const result = await pipeline(transport).execute({ ...inputs,
        skills: reverse ? [...skills].reverse() : skills,
        memories: reverse ? [...memories].reverse() : memories,
      }, { maxInjectedSkills: 2, maxInjectedMemoryGuards: 2 });
      expect(result?.bypassed).not.toBe(true);
      expect(result?.tokenBreakdown?.catalogRequests).toBeGreaterThan(1);
      expect(result?.activatedSkills?.map(s => s.path)).toEqual(['/s/349', '/s/175']);
      expect(result?.activatedMemoryGuards?.map(m => m.id)).toEqual(['mem_349', 'mem_175']);
    }
  });

  it('partitions a large overview without dropping directories or records and merges coverage', async () => {
    const dsl = Array.from({ length: 600 }, (_, i) => `[dir-${i}]\n file-${i}.ts->Symbol${i}`).join('\n');
    const seen = new Set<string>();
    const transport = (async (_url, init) => {
      const r = parse(init); assertBounded(r);
      const response = responseFor(r);
      const q = r.questions.q1_target_subsystem;
      if (q?.type === 'choice') {
        for (const [key, value] of Object.entries(q.criteria)) if (key !== 'none_or_new') seen.add(value);
        const choice = Object.keys(q.criteria).find((key) => q.criteria[key] === 'dir-599') ?? 'none_or_new';
        response.answers.q1_target_subsystem = { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } };
        for (const value of r.state.codebase_trie_map!.matchAll(/file-(\d+)\.ts->Symbol\d+/g)) expect(q.criteria[`dir_${value[1]}`]).toBe(`dir-${value[1]}`);
      }
      return Response.json(response);
    }) as typeof fetch;
    const decision = await pipeline(transport).execute({ ...inputs, dsl, memories: [memory(0)] }, {});
    expect(decision?.bypassed).not.toBe(true);
    expect(seen.size).toBe(600);
    expect(decision?.targetSubsystems).toEqual(['dir-599']);
    expect(decision?.tokenBreakdown?.overviewRequests).toBeGreaterThan(1);
  });

  it('splits one huge directory across batches while preserving every symbol line', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => ` file-${i}.ts->Symbol${i} ${'Export '.repeat(45)}`);
    const seen = new Set<string>();
    const transport = (async (_url, init) => {
      const r = parse(init); assertBounded(r);
      for (const line of r.state.codebase_trie_map!.split('\n').slice(1)) seen.add(line);
      return Response.json(responseFor(r));
    }) as typeof fetch;
    const decision = await pipeline(transport).execute({ ...inputs, dsl: `[huge]\n${lines.join('\n')}` }, {});
    expect(decision?.bypassed).not.toBe(true);
    expect(seen.size).toBe(1000);
    expect(decision?.tokenBreakdown?.totalRequests).toBeGreaterThan(1);
    expect(formatRoutingStats(decision!)).toContain('aggregate across');
  });

  it('preflights unsplittable tasks/candidates and forced Unified before any network dispatch', async () => {
    let calls = 0;
    const transport = (async (_url, init) => { calls++; return Response.json(responseFor(parse(init))); }) as typeof fetch;
    for (const fixture of [
      { ...inputs, userPrompt: 'x'.repeat(100000), memories: [memory(0)] },
      { ...inputs, skills: [{ name: 'huge', description: 'x'.repeat(100000), path: '/fixture' }] },
    ]) {
      expect((await pipeline(transport).execute(fixture, {}))?.bypassed).toBe(true);
      expect(calls).toBe(0);
    }
    const oversized = { ...inputs, skills: Array.from({ length: 300 }, (_, i) => ({ name: `s-${i}`, description: 'details '.repeat(80), path: `/s/${i}` })) };
    expect((await pipeline(transport).execute(oversized, { executionMode: 'unified' }))?.bypassed).toBe(true);
    expect(calls).toBe(0);
    const client = new JevClient(undefined, undefined, 'FAKE', undefined, '/unused', transport);
    await expect(client.evaluate({ state: { user_task: 'x'.repeat(100000) }, questions: {} })).rejects.toThrow('capacity');
    expect(calls).toBe(0);
  });

  it('uses one deadline across all batches, and cancels outstanding body reads', async () => {
    const skills = Array.from({ length: 2000 }, (_, i) => ({ name: `s-${i}`, description: 'small', path: `/s/${i}` }));
    let cancelled = 0;
    const transport = (async (_url, init) => {
      const r = parse(init); assertBounded(r);
      const response = responseFor(r);
      let timer: ReturnType<typeof setTimeout>;
      return new Response(new ReadableStream({
        start(c) { timer = setTimeout(() => { c.enqueue(new TextEncoder().encode(JSON.stringify(response))); c.close(); }, 40); },
        cancel() { clearTimeout(timer); cancelled++; },
      }));
    }) as typeof fetch;
    const start = Date.now();
    const decision = await pipeline(transport).execute({ ...inputs, dsl: '', skills }, { timeoutMs: 60 });
    expect(decision?.bypassed).toBe(true);
    expect(Date.now() - start).toBeLessThan(200);
    expect(cancelled).toBeGreaterThan(0);
  });

  it('bounds workers globally and never dispatches queued batches after caller cancellation', async () => {
    const skills = Array.from({ length: 2000 }, (_, i) => ({ name: `s-${i}`, description: 'small', path: `/s/${i}` }));
    const controller = new AbortController();
    let calls = 0;
    const transport = (async (_url, init) => {
      calls++;
      if (calls === 4) controller.abort(new Error('cancelled'));
      return await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error('cancelled'));
        else init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    }) as typeof fetch;
    expect((await pipeline(transport).execute({ ...inputs, skills, memories: [memory(0)] }, {}, controller.signal))?.bypassed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(4);
  });

  it('allows all memory candidates to apply without shortlist convergence or top-1 loss', async () => {
    const memories = Array.from({ length: 600 }, (_, i) => memory(i));
    let calls = 0;
    const transport = (async (_url, init) => {
      calls++;
      const r = parse(init); assertBounded(r); const response = responseFor(r);
      for (const id of Object.keys(r.questions).filter(id => id.startsWith('q5_memory_'))) {
        response.answers[id] = { type: 'noul', noul: 0.95 };
      }
      return Response.json(response);
    }) as typeof fetch;
    const decision = await pipeline(transport).execute({ ...inputs, dsl: '', memories }, { maxInjectedMemoryGuards: 600 });
    expect(decision?.bypassed).not.toBe(true);
    expect(decision?.activatedMemoryGuards).toHaveLength(600);
    expect(decision?.tokenBreakdown?.totalRequests).toBe(calls);
  });

  it('shows zero usage per track and distinguishes actual usage from estimates', () => {
    const text = formatRoutingStats({ pipelineMode: 'parallel', latencyMs: 1, estimatedPayloadTokens: 32000, tokenBreakdown: { overviewTokens: 0, catalogTokens: 0 } });
    expect(text).toContain('Track A (Overview): 0.0K');
    expect(text).toContain('Track B (Skills + Mem): 0.0K');
    expect(text).toContain('(Parallel)');
    expect(text).not.toContain('32,000');
  });
});
