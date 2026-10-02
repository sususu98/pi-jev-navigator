import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JevPrompter } from '../src/jev/prompter.ts';
import { JevDualPipeline } from '../src/jev/pipeline.ts';
import { JevClient } from '../src/jev/client.ts';
import { JevConfigStore } from '../src/config/config-store.ts';
import { TailInjector } from '../src/injector/tail-injector.ts';
import type { JevNoulAnswer, JevSystemOneRequest, SkillSummary, MemoryGuard } from '../src/types.ts';
import { responseFor, put } from './support.ts';
import { JevNavigator } from '../src/index.ts';
import { makeHermesDatabase } from './memory-support.ts';

const skills: SkillSummary[] = Array.from({ length: 5 }, (_, i) => ({
  name: `neutral-sop-${i}`, description: `Metadata description ${i}`, path: `/fixture/${i}/SKILL.md`,
}));
const memories: MemoryGuard[] = Array.from({ length: 4 }, (_, i) => ({
  id: `memory-${i}`, category: 'correction', title: `Title ${i}`, summary: `Summary ${i}`,
  rule: `Whole operational constraint ${i}\nFINAL_REQUIREMENT_${i}`,
}));
const prompter = new JevPrompter();
const inputs = { userPrompt: 'Perform the documented maintenance task', dsl: '', estimatedTokens: 0, skills, memories, safetyRules: [] };
const noul = (probability = 0.95): JevNoulAnswer => ({ type: 'noul', noul: probability });

describe('independent Skill / Memory applicability', () => {
  it('encodes independent structured Nouls with metadata only and complete memory data', () => {
    const enriched = skills.map(skill => ({ ...skill, body: 'SECRET_SKILL_BODY' }));
    const { questions } = prompter.buildQuestions('', enriched, [], memories);
    expect(questions.q2_active_skill).toBeUndefined();
    expect(questions.q5_memory_guard).toBeUndefined();
    expect(JSON.stringify(questions)).not.toContain('SECRET_SKILL_BODY');
    for (const [id, question] of Object.entries(questions)) {
      if (!id.startsWith('q2_skill_') && !id.startsWith('q5_memory_')) continue;
      expect(question.type).toBe('noul');
      expect(question).not.toHaveProperty('statement');
      const q = question as any;
      expect(Object.keys(q.instructions).sort()).toEqual(id.startsWith('q2_skill_')
        ? ['candidate', 'question'] : ['boundary', 'candidate', 'question']);
      expect(typeof q.instructions.question).toBe('string');
      if (id.startsWith('q5_memory_')) expect(typeof q.instructions.boundary).toBe('string');
      expect(Object.keys(q.criteria).sort()).toEqual(['false', 'true']);
      expect(typeof q.criteria.true).toBe('string');
      expect(typeof q.criteria.false).toBe('string');
      const i = Number(id.split('_').at(-1));
      if (id.startsWith('q2_skill_')) expect(q.instructions.candidate).toEqual(skills[i]);
      else {
        const memory = memories[i];
        expect(q.instructions.candidate).toEqual({ id: memory.id, category: memory.category,
          title: memory.title, scope: memory.project ?? 'global', guidance: `${memory.summary}\n${memory.rule}` });
        expect(q.instructions.candidate.guidance).toContain(memory.summary);
        expect(q.instructions.candidate.guidance).toContain(memory.rule);
      }
      // Criteria and boundaries must not duplicate candidate-specific data.
      expect(JSON.stringify(q.criteria)).not.toContain(id.startsWith('q2_skill_') ? skills[i].path : memories[i].rule);
    }
  });

  it('keeps complete memory guidance without duplicating a title or rule already in the summary', () => {
    const memory: MemoryGuard = { ...memories[0], title: 'A long rule heading',
      rule: 'A long rule heading\nComplete operational constraint',
      summary: 'A long rule heading\nComplete operational constraint\nScope metadata' };
    const question: any = prompter.buildQuestions('', [], [], [memory]).questions.q5_memory_0;
    expect(question.instructions.candidate.guidance).toBe(memory.summary);
    expect(question.instructions.candidate).not.toHaveProperty('title');
    expect(question.instructions.candidate).not.toHaveProperty('rule');
    const selected = prompter.parseAnswers({ q5_memory_0: noul() }, [], {}, 0, 0, [memory]);
    expect(selected.activatedMemoryGuards).toEqual([memory]);
  });

  it('injects no low/medium signals, permits all-zero output, and includes the exact default threshold', () => {
    const response = responseFor(prompter.buildQuestions('', skills, [], memories));
    const parse = () => prompter.parseAnswers(response.answers, skills, {}, 0, 0, memories);
    const empty = parse();
    expect(empty.activatedSkills).toEqual([]);
    expect(empty.activatedMemoryGuards).toEqual([]);
    expect(empty.activatedSkill).toBeUndefined();
    expect(new TailInjector().formatTailGuidance(empty)).not.toContain('Recommended SOP');
    for (const probability of [0.05, 0.5, 0.6, 0.749999]) {
      response.answers.q2_skill_0 = noul(probability);
      response.answers.q5_memory_0 = noul(probability);
      expect(parse().activatedSkills).toEqual([]);
      expect(parse().activatedMemoryGuards).toEqual([]);
    }
    response.answers.q2_skill_0 = noul(0.75);
    response.answers.q5_memory_0 = noul(0.75);
    expect(parse().activatedSkills).toEqual([skills[0]]);
    expect(parse().activatedMemoryGuards).toEqual([memories[0]]);
  });

  it('rejects relative Choice probabilities instead of treating them as absolute Noul applicability', () => {
    const response = responseFor(prompter.buildQuestions('', skills, [], memories));
    for (const id of ['q2_skill_0', 'q5_memory_0']) {
      response.answers[id] = { type: 'choice', choice: 'applicable', confidence: 1, probabilities: { applicable: 0.99 } };
      expect(() => prompter.parseAnswers(response.answers, skills, {}, 0, 0, memories)).toThrow();
      response.answers[id] = noul(0);
    }
    for (const probability of [-0.1, 1.1, NaN, Infinity]) {
      response.answers.q2_skill_0 = noul(probability);
      expect(() => prompter.parseAnswers(response.answers, skills, {}, 0, 0, memories)).toThrow();
    }
  });

  it('sorts by absolute probability before caps rather than injecting the first three candidates', () => {
    const response = responseFor(prompter.buildQuestions('', skills, [], memories));
    [0.8, 0.81, 0.82, 0.99, 0.95].forEach((p, i) => { response.answers[`q2_skill_${i}`] = noul(p); });
    [0.8, 0.81, 0.99, 0.95].forEach((p, i) => { response.answers[`q5_memory_${i}`] = noul(p); });
    const result = prompter.parseAnswers(response.answers, skills, {}, 0, 0, memories);
    expect(result.activatedSkills).toEqual([skills[3], skills[4], skills[2]]);
    expect(result.activatedMemoryGuards).toEqual([memories[2], memories[3], memories[1]]);
    expect(result.activatedSkillPath).toBe(skills[3].path);
    expect(result.activatedMemoryGuard).toEqual(memories[2]);
    const strict = prompter.parseAnswers(response.answers, skills, {}, 0, 0, memories, [], 3, 3, 0.95, 0.99);
    expect(strict.activatedSkills).toEqual([skills[3], skills[4]]);
    expect(strict.activatedMemoryGuards).toEqual([memories[2]]);
  });

  it('breaks exact probability ties by candidate identity, independently of candidate order', () => {
    const tiedSkills = [
      { name: 'z', path: '/z', description: 'same' },
      { name: 'a', path: '/z', description: 'same' },
      { name: 'a', path: '/a', description: 'same' },
    ];
    const tiedMemories = [memories[3], memories[1], memories[0]];
    const expectedSkills = [tiedSkills[2], tiedSkills[1]];
    const expectedMemories = [memories[0], memories[1]];
    for (const [ss, mm] of [[tiedSkills, tiedMemories], [[...tiedSkills].reverse(), [...tiedMemories].reverse()]] as [SkillSummary[], MemoryGuard[]][]) {
      const response = responseFor(prompter.buildQuestions('', ss, [], mm));
      for (const id of Object.keys(response.answers)) {
        if (id.startsWith('q2_skill_') || id.startsWith('q5_memory_')) response.answers[id] = noul();
      }
      const result = prompter.parseAnswers(response.answers, ss, {}, 0, 0, mm, [], 2, 2);
      expect(result.activatedSkills).toEqual(expectedSkills);
      expect(result.activatedMemoryGuards).toEqual(expectedMemories);
    }
  });

  it('routes all positive skills and memories through pipeline into tails with independent configurable caps', async () => {
    let calls = 0;
    const transport = (async (_url, init) => {
      calls++;
      const request: JevSystemOneRequest = JSON.parse(String(init?.body));
      const response = responseFor(request);
      for (const id of Object.keys(request.questions).filter(id => id.startsWith('q2_skill_') || id.startsWith('q5_memory_'))) {
        response.answers[id] = noul();
      }
      return Response.json(response);
    }) as typeof fetch;
    const pipeline = new JevDualPipeline(new JevClient('https://fixture.invalid', 'test', 'FAKE', undefined, '/unused', transport), prompter);
    const defaults = await pipeline.execute(inputs, {});
    expect(defaults?.activatedSkills).toHaveLength(3);
    expect(defaults?.activatedMemoryGuards).toHaveLength(3);
    expect(defaults?.activatedSkill).toBe(skills[0].name);
    const full = await pipeline.execute(inputs, { maxInjectedSkills: 5, maxInjectedMemoryGuards: 4 });
    expect(full?.bypassed).not.toBe(true);
    const injector = new TailInjector();
    const tail = injector.formatTailGuidance(full!);
    for (const skill of skills) { expect(tail).toContain(skill.name); expect(tail).toContain(skill.path); }
    for (const memory of memories) expect(tail).toContain(memory.rule);
    const suppressed = await pipeline.execute(inputs, { maxInjectedSkills: 0, maxInjectedMemoryGuards: 0 });
    expect(suppressed?.activatedSkills).toEqual([]);
    expect(suppressed?.activatedMemoryGuards).toEqual([]);
    expect(calls).toBe(3); // output caps do not prefilter evaluation candidates
    expect(injector.formatTailGuidance({ activatedSkills: [], activatedSkill: 'stale' })).not.toContain('stale');
  });

  it('collects skill metadata and bounded SQLite memories through Navigator into the user tail', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-multiselect-e2e-'));
    try {
      const root = path.join(temporary, 'repo'), home = path.join(temporary, 'home');
      fs.mkdirSync(root); fs.mkdirSync(home);
      for (let i = 0; i < 2; i++) put(path.join(home, `.pi/agent/skills/neutral-sop-${i}/SKILL.md`),
        `---\nname: neutral-sop-${i}\ndescription: Maintenance procedure ${i}\n---\nSECRET_SOP_BODY_${i}`);
      makeHermesDatabase(home, [
        { content: 'Maintenance constraint one\nPreserve complete requirement one' },
        { content: 'Maintenance constraint two\nPreserve complete requirement two' },
        { content: 'Maintenance FOREIGN_SECRET', project: 'foreign' },
      ]);
      let skillQuestions = 0, memoryQuestions = 0;
      const transport = (async (_url, init) => {
        const request: JevSystemOneRequest = JSON.parse(String(init?.body));
        expect(JSON.stringify(request)).not.toContain('SECRET_SOP_BODY');
        expect(JSON.stringify(request)).not.toContain('FOREIGN_SECRET');
        const response = responseFor(request);
        for (const id of Object.keys(request.questions)) {
          if (id.startsWith('q2_skill_')) skillQuestions++;
          else if (id.startsWith('q5_memory_')) memoryQuestions++;
          else continue;
          response.answers[id] = noul();
        }
        return Response.json(response);
      }) as typeof fetch;
      const navigator = new JevNavigator(root, { apiKey: 'FAKE', enableSubsystems: false, logDecisions: false }, home, transport);
      const result = await navigator.processUserPrompt('Perform maintenance');
      expect(skillQuestions).toBe(2); expect(memoryQuestions).toBe(2);
      expect(result.decision?.activatedSkills).toHaveLength(2);
      expect(result.decision?.activatedMemoryGuards).toHaveLength(2);
      for (let i = 0; i < 2; i++) expect(result.enrichedPrompt).toContain(path.join(home, `.pi/agent/skills/neutral-sop-${i}/SKILL.md`));
      expect(result.enrichedPrompt).toContain('Preserve complete requirement one');
      expect(result.enrichedPrompt).toContain('Preserve complete requirement two');
      expect(result.enrichedPrompt.startsWith('Perform maintenance')).toBe(true);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it('reads separate applicability thresholds from pipeline configuration', async () => {
    const transport = (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const response = responseFor(request);
      for (const id of Object.keys(request.questions)) {
        if (id.startsWith('q2_skill_') || id.startsWith('q5_memory_')) response.answers[id] = noul(0.85);
      }
      return Response.json(response);
    }) as typeof fetch;
    const pipeline = new JevDualPipeline(new JevClient('https://fixture.invalid', 'test', 'FAKE', undefined, '/unused', transport), prompter);
    const strictSkills = await pipeline.execute(inputs, { skillApplicabilityThreshold: 0.9, memoryApplicabilityThreshold: 0.85 });
    expect(strictSkills?.bypassed).not.toBe(true);
    expect(strictSkills?.activatedSkills).toEqual([]);
    expect(strictSkills?.activatedMemoryGuards).toHaveLength(3);
    const strictMemory = await pipeline.execute(inputs, { skillApplicabilityThreshold: 0.85, memoryApplicabilityThreshold: 0.9 });
    expect(strictMemory?.activatedSkills).toHaveLength(3);
    expect(strictMemory?.activatedMemoryGuards).toEqual([]);
  });

  it('validates (0.5, 1] thresholds and persists them in isolated configuration fixtures', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-noul-config-'));
    try {
      const root = path.join(temporary, 'repo'), home = path.join(temporary, 'home');
      fs.mkdirSync(root); fs.mkdirSync(home);
      for (const key of ['skillApplicabilityThreshold', 'memoryApplicabilityThreshold'] as const) {
        for (const invalid of [-1, 0, 0.49, 0.5, 1.01, NaN, Infinity, '0.9', null]) {
          const store = new JevConfigStore(root, {}, home);
          expect(store.get()[key]).toBe(0.75);
          store.set({ [key]: invalid } as any);
          expect(store.get()[key]).toBe(0.75);
        }
        for (const valid of [0.500001, 0.75, 1]) {
          const store = new JevConfigStore(root, { [key]: valid }, home);
          expect(store.get()[key]).toBe(valid);
        }
      }
      const store = new JevConfigStore(root, {}, home);
      store.set({ skillApplicabilityThreshold: 0.9, memoryApplicabilityThreshold: 0.8 });
      store.saveProjectConfig();
      const saved = new JevConfigStore(root, {}, home).get();
      expect(saved.skillApplicabilityThreshold).toBe(0.9);
      expect(saved.memoryApplicabilityThreshold).toBe(0.8);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it('validates, overrides and persists maxInjectedSkills only in isolated config fixtures', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-multiselect-config-'));
    try {
      const root = path.join(temporary, 'repo'), home = path.join(temporary, 'home');
      fs.mkdirSync(root); fs.mkdirSync(home);
      const store = new JevConfigStore(root, {}, home);
      expect(store.get().maxInjectedSkills).toBe(3);
      for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '2']) {
        store.set({ maxInjectedSkills: invalid as number });
        expect(store.get().maxInjectedSkills).toBe(3);
      }
      put(path.join(home, '.pi/agent/jev-config.jsonc'), '{ "maxInjectedSkills": 4 }');
      put(path.join(root, '.pi/jev-config.jsonc'), '{ "maxInjectedSkills": 2 }');
      const layered = new JevConfigStore(root, {}, home);
      expect(layered.get().maxInjectedSkills).toBe(2);
      layered.set({ maxInjectedSkills: 0 }); layered.saveProjectConfig();
      expect(new JevConfigStore(root, {}, home).get().maxInjectedSkills).toBe(0);
      expect(new JevConfigStore(root, { maxInjectedSkills: 5 }, home).get().maxInjectedSkills).toBe(5);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
});
