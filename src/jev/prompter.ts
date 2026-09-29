import {
  JevQuestion,
  JevState,
  JevAnswer,
  DispatchDecision,
  SkillSummary,
  MemoryGuard,
} from '../types.js';

export class JevPrompter {
  /**
   * Build the complete Jev System One questions payload for a user prompt,
   * incorporating best practices from aaddrick/building-with-typesafe-jev:
   * 1. Backticked state paths
   * 2. Choice + Noul pairing for absolute gating
   * 3. Situational score rubrics
   * 4. Explicit catch-all options
   */
  public buildQuestions(
    trieDsl: string,
    skills: SkillSummary[],
    safetyRules: string[],
    memories: MemoryGuard[] = [],
    _userPrompt: string = ''
  ): { questions: Record<string, JevQuestion>; dirCriteriaMap: Record<string, string> } {
    // 1. All codebase directories from trieDsl directly to Jev (No fragile client-side filtering)
    const dirMatches = trieDsl.match(/^\[([^\]]+)\]/gm) || [];
    const allDirs = Array.from(new Set(dirMatches.map((m) => m.replace(/^\[|\]$/g, ''))));

    const dirCriteria: Record<string, string> = {};
    const dirCriteriaMap: Record<string, string> = {};

    for (const d of allDirs) {
      const key = `dir_${d.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      dirCriteria[key] = d;
      dirCriteriaMap[key] = d;
    }
    dirCriteria['none_or_new'] = 'General / New Modules / No specific directory';
    dirCriteriaMap['none_or_new'] = 'General / New Modules';

    // 2. All skills directly to Jev (Zero client-side drop, let Jev System One evaluate 100% of skills)
    const skillCriteria: Record<string, string> = {};
    for (const s of skills) {
      const key = `skill_${s.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      skillCriteria[key] = `${s.name}: ${s.description.slice(0, 100)}`;
    }
    skillCriteria['none'] = 'No specialized SOP skill needed, standard general coding';

    // 3. All active memory guards directly to Jev
    const memoryCriteria: Record<string, string> = {};
    for (const m of memories) {
      memoryCriteria[m.id] = `[${m.category}] ${m.summary.slice(0, 100)}`;
    }
    memoryCriteria['none'] = 'No specific memory constraint or past correction applies to this task';

    // 4. Build safety rule criteria
    const ruleCriteria: Record<string, string> = {};
    for (let i = 0; i < safetyRules.length; i++) {
      const r = safetyRules[i];
      const key = `rule_${i}`;
      ruleCriteria[key] = r;
    }
    ruleCriteria['standard_safe'] = 'Standard safety practices and clean code guidelines';

    const questions: Record<string, JevQuestion> = {
      // Q1: Target Subsystem Choice
      q1_target_subsystem: {
        type: 'choice',
        instructions:
          'Looking at `codebase_trie_map`, which directory is the primary implementation target for `user_task`?',
        criteria: dirCriteria,
      },
      // Q2: Active Skill Choice
      q2_active_skill: {
        type: 'choice',
        instructions:
          'If a specialized SOP is needed, which skill in `skills_catalog` best matches `user_task`?',
        criteria: skillCriteria,
      },
      // Q3: Safety Guard Choice
      q3_safety_guard: {
        type: 'choice',
        instructions:
          'Given the potential risks in `user_task`, which rule in `safety_rules` must be strictly enforced?',
        criteria: ruleCriteria,
      },
      // Q4: Situational Risk Score
      q4_complexity_risk: {
        type: 'score',
        instructions:
          'Given the implementation scope across `codebase_trie_map`, what is the regression and blast radius risk of `user_task`?',
        criteria: [
          '0: Purely informational query, documentation read, or cosmetic text edit',
          '1: Localized change contained within a single isolated file with existing test coverage',
          '2: Multi-module or cross-protocol change with upstream 400/403 or network regression risk',
          '3: High-risk architectural change, database schema migration, or breaking API modification',
        ],
      },
      // Q5: Active Memory Guard Choice
      q5_memory_guard: {
        type: 'choice',
        instructions:
          'If a past correction, user preference, or operational constraint in `memory_guards` applies to `user_task`, which guard must be enforced?',
        criteria: memoryCriteria,
      },
    };

    return { questions, dirCriteriaMap };
  }

  /**
   * Parse Jev answers into a structured DispatchDecision with multi-label probability extraction
   */
  public parseAnswers(
    answers: Record<string, JevAnswer>,
    skills: SkillSummary[],
    dirCriteriaMap: Record<string, string>,
    latencyMs: number,
    inputTokens: number,
    memories: MemoryGuard[] = []
  ): DispatchDecision {
    const decision: DispatchDecision = {
      latencyMs,
      inputTokens,
      rawAnswers: answers,
      targetSubsystems: [],
      safetyRules: [],
    };

    // 1. Multi-candidate Subsystem Extraction (Winner + Secondary probabilities >= 0.25)
    const q1 = answers['q1_target_subsystem'];
    if (q1 && q1.type === 'choice') {
      const targets: string[] = [];
      const primaryTarget = dirCriteriaMap[q1.choice] || q1.choice;
      if (q1.choice !== 'none_or_new') {
        targets.push(primaryTarget);
      }

      // Check secondary probabilities for multi-module tasks
      if (q1.probabilities) {
        for (const [key, prob] of Object.entries(q1.probabilities)) {
          if (key !== q1.choice && key !== 'none_or_new' && prob >= 0.25) {
            const secondaryTarget = dirCriteriaMap[key] || key;
            targets.push(secondaryTarget);
          }
        }
      }

      decision.targetSubsystems = Array.from(new Set(targets));
      decision.confidence = q1.confidence;
    }

    // 2. Skill Activation (Winner choice !== 'none' and confidence >= 0.35)
    const q2 = answers['q2_active_skill'] || answers['q3_active_skill'];
    if (q2 && q2.type === 'choice' && q2.choice !== 'none' && (q2.confidence ?? 1) >= 0.35) {
      const skillKey = q2.choice.replace(/^skill_/, '');
      const matched = skills.find(
        (s) => s.name.replace(/[^a-zA-Z0-9_]/g, '_') === skillKey || s.name === skillKey
      );
      if (matched) {
        decision.activatedSkill = matched.name;
        decision.activatedSkillPath = matched.path;
      }
    }

    // 3. Safety rule extraction (Winner + Probabilities >= 0.3)
    const q3 = answers['q3_safety_guard'] || answers['q4_safety_guard'];
    if (q3 && q3.type === 'choice' && q3.choice !== 'standard_safe') {
      decision.safetyRules = [q3.choice];
      if (q3.probabilities) {
        for (const [key, prob] of Object.entries(q3.probabilities)) {
          if (key !== q3.choice && key !== 'standard_safe' && prob >= 0.3) {
            decision.safetyRules.push(key);
          }
        }
      }
      decision.safetyRules = Array.from(new Set(decision.safetyRules));
    }

    // 4. Complexity Risk Score
    const q4 = answers['q4_complexity_risk'] || answers['q5_complexity_risk'];
    if (q4 && q4.type === 'score') {
      decision.riskScore = q4.score;
    }

    // 5. Memory Guard Extraction (Winner choice !== 'none' and confidence >= 0.35)
    const q5 = answers['q5_memory_guard'] || answers['q6_memory_guard'] || answers['q7_memory_guard'];
    if (q5 && q5.type === 'choice' && q5.choice !== 'none' && (q5.confidence ?? 1) >= 0.35) {
      const matchedMemory = memories.find((m) => m.id === q5.choice);
      if (matchedMemory) {
        decision.activatedMemoryGuard = matchedMemory;
      }
    }

    return decision;
  }
}
