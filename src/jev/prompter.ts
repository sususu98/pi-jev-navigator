import {
  JevQuestion, JevAnswer, JevChoiceAnswer, DispatchDecision, SkillSummary, MemoryGuard,
} from '../types.js';

/** Request-local opaque IDs avoid lossy path/name normalization. No candidate pre-scoring. */
export class JevPrompter {
  public buildQuestions(
    trieDsl: string,
    skills: SkillSummary[],
    safetyRules: string[],
    memories: MemoryGuard[] = [],
    _userPrompt: string = ''
  ): { questions: Record<string, JevQuestion>; dirCriteriaMap: Record<string, string> } {
    const allDirs = Array.from(new Set(Array.from(trieDsl.matchAll(/^\[([^\]]+)\]/gm), (m) => m[1])))
      .filter((dir) => dir !== '~');
    const dirCriteriaMap: Record<string, string> = Object.fromEntries(allDirs.map((dir, i) => [`dir_${i}`, dir]));
    const dirCriteria = { ...dirCriteriaMap, none_or_new: 'General / New Modules / No specific directory' };
    const skillCriteria = Object.fromEntries(skills.map((skill, i) => [`skill_${i}`, `${skill.name}: ${skill.description}\nLocation: ${JSON.stringify(skill.path)}`]));
    skillCriteria.none = 'No specialized SOP skill needed, standard general coding';
    const memoryCriteria = Object.fromEntries(memories.map((memory) => [memory.id, `[${memory.category}] ${memory.summary}`]));
    if (new Set(memories.map((m) => m.id)).size !== memories.length) {
      throw new Error('Duplicate memory candidate IDs');
    }
    memoryCriteria.none = 'No specific memory constraint or past correction applies to this task';
    const ruleCriteria = Object.fromEntries(safetyRules.map((rule, i) => [`rule_${i}`, rule]));
    ruleCriteria.standard_safe = 'Standard safety practices and clean code guidelines';
    return {
      dirCriteriaMap,
      questions: {
        q1_target_subsystem: {
          type: 'choice',
          instructions: 'Looking at `codebase_trie_map`, which directory is the primary implementation target for `user_task`?',
          criteria: dirCriteria,
        },
        q2_active_skill: {
          type: 'choice',
          instructions: 'If a specialized SOP is needed, which skill in the criteria best matches `user_task`?',
          criteria: skillCriteria,
        },
        q3_safety_guard: {
          type: 'choice',
          instructions: 'Given the potential risks in `user_task`, which rule in the criteria must be strictly enforced?',
          criteria: ruleCriteria,
        },
        q4_complexity_risk: {
          type: 'score',
          instructions: trieDsl
            ? 'Given the implementation scope across `codebase_trie_map`, what is the regression and blast radius risk of `user_task`?'
            : 'What is the regression and blast radius risk of `user_task`?',
          criteria: [
            '0: Purely informational query, documentation read, or cosmetic text edit',
            '1: Localized change contained within a single isolated file with existing test coverage',
            '2: Multi-module or cross-protocol change with upstream 400/403 or network regression risk',
            '3: High-risk architectural change, database schema migration, or breaking API modification',
          ],
        },
        q5_memory_guard: {
          type: 'choice',
          instructions: 'Which past correction, user preference, or operational constraint in the criteria applies to `user_task` and must be enforced?',
          criteria: memoryCriteria,
        },
      },
    };
  }

  public parseAnswers(
    answers: Record<string, JevAnswer>,
    skills: SkillSummary[],
    dirCriteriaMap: Record<string, string>,
    latencyMs: number,
    inputTokens: number,
    memories: MemoryGuard[] = [],
    safetyRules: string[] = [],
    maxInjectedMemoryGuards: number = 3
  ): DispatchDecision {
    const decision: DispatchDecision = { latencyMs, inputTokens, rawAnswers: answers, targetSubsystems: [], safetyRules: [] };
    const selectedKeys = (answer: JevChoiceAnswer, validKeys: string[], none: string, threshold: number): string[] => {
      const allowed = new Set([...validKeys, none]);
      if (!allowed.has(answer.choice)) throw new Error('Unknown Jev choice');
      for (const [key, probability] of Object.entries(answer.probabilities || {})) {
        if (!allowed.has(key) || !Number.isFinite(probability) || probability < 0 || probability > 1) {
          throw new Error('Invalid Jev probability');
        }
      }
      const keys = answer.choice === none ? [] : [answer.choice];
      for (const [key, probability] of Object.entries(answer.probabilities || {})) {
        if (key !== answer.choice && key !== none && probability >= threshold) keys.push(key);
      }
      return keys;
    };
    const q1 = answers.q1_target_subsystem;
    if (q1?.type === 'choice') {
      decision.targetSubsystems = selectedKeys(q1, Object.keys(dirCriteriaMap), 'none_or_new', 0.25)
        .map((key) => dirCriteriaMap[key]);
      decision.confidence = q1.confidence;
    }
    const skillMap = Object.fromEntries(skills.map((skill, i) => [`skill_${i}`, skill]));
    const q2 = answers.q2_active_skill || answers.q3_active_skill;
    if (q2?.type === 'choice') {
      selectedKeys(q2, Object.keys(skillMap), 'none', 1);
      const skill = skillMap[q2.choice];
      if (skill && q2.confidence >= 0.35) {
        decision.activatedSkill = skill.name;
        decision.activatedSkillPath = skill.path;
      }
    }
    const ruleMap = Object.fromEntries(safetyRules.map((rule, i) => [`rule_${i}`, rule]));
    const q3 = answers.q3_safety_guard || answers.q4_safety_guard;
    if (q3?.type === 'choice') {
      decision.safetyRules = selectedKeys(q3, Object.keys(ruleMap), 'standard_safe', 0.3).map((key) => ruleMap[key]);
    }
    const q4 = answers.q4_complexity_risk || answers.q5_complexity_risk;
    if (q4?.type === 'score') {
      if (!Number.isFinite(q4.score) || q4.score < 0 || q4.score > 3) throw new Error('Invalid Jev risk score');
      decision.riskScore = q4.score;
    }
    const q5 = answers.q5_memory_guard || answers.q6_memory_guard || answers.q7_memory_guard;
    if (q5?.type === 'choice') {
      const memoryMap = new Map(memories.map((memory) => [memory.id, memory]));
      const guards = selectedKeys(q5, [...memoryMap.keys()], 'none', 0.25)
        .filter((key) => key !== q5.choice || q5.confidence >= 0.35)
        .sort((a, b) => a === q5.choice ? -1 : b === q5.choice ? 1
          : (q5.probabilities?.[b] ?? 0) - (q5.probabilities?.[a] ?? 0))
        .slice(0, maxInjectedMemoryGuards)
        .map((key) => memoryMap.get(key)!);
      if (guards.length) {
        decision.activatedMemoryGuards = guards;
        decision.activatedMemoryGuard = guards[0];
      }
    }
    return decision;
  }
}
