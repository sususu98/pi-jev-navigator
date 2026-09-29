import {
  JevQuestion,
  JevState,
  JevAnswer,
  DispatchDecision,
  SkillSummary,
} from '../types.js';

export class JevPrompter {
  /**
   * Build the complete Jev System One questions payload for a user prompt
   */
  public buildQuestions(
    trieDsl: string,
    skills: SkillSummary[],
    safetyRules: string[]
  ): Record<string, JevQuestion> {
    // 1. Extract candidate top-level directories from trieDsl
    const dirMatches = trieDsl.match(/^\[([^\]]+)\]/gm) || [];
    const topDirs = Array.from(new Set(dirMatches.map((m) => m.replace(/^\[|\]$/g, '')))).slice(0, 15);

    const dirCriteria: Record<string, string> = {};
    for (let i = 0; i < Math.min(topDirs.length, 10); i++) {
      const d = topDirs[i];
      const key = `dir_${d.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      dirCriteria[key] = d;
    }
    if (Object.keys(dirCriteria).length === 0) {
      dirCriteria['core_module'] = 'Core architecture files';
    }

    // 2. Build skill criteria
    const skillCriteria: Record<string, string> = {};
    for (let i = 0; i < Math.min(skills.length, 12); i++) {
      const s = skills[i];
      const key = `skill_${s.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      skillCriteria[key] = `${s.name}: ${s.description.slice(0, 60)}`;
    }
    skillCriteria['none'] = 'No specialized skill needed, use general coding';

    // 3. Build safety rule criteria
    const ruleCriteria: Record<string, string> = {};
    for (let i = 0; i < Math.min(safetyRules.length, 6); i++) {
      const r = safetyRules[i];
      const key = `rule_${i}`;
      ruleCriteria[key] = r;
    }
    ruleCriteria['standard_safe'] = 'Standard safety guidelines apply';

    const questions: Record<string, JevQuestion> = {
      q1_target_subsystem: {
        type: 'choice',
        instructions: 'Which codebase directory or subsystem in codebase_trie_map is the primary target for this task?',
        criteria: dirCriteria,
      },
      q2_active_skill: {
        type: 'choice',
        instructions: 'From skills_catalog, which specialized SOP skill best matches this task requirement?',
        criteria: skillCriteria,
      },
      q3_safety_guard: {
        type: 'choice',
        instructions: 'Which safety rule or project constraint must be strictly enforced during this task?',
        criteria: ruleCriteria,
      },
      q4_complexity_risk: {
        type: 'score',
        instructions: 'Rate the architectural complexity and regression risk of this requested change.',
        criteria: [
          '0: Purely informational or trivial cosmetic fix',
          '1: Localized change within a single isolated file',
          '2: Multi-module or cross-protocol change requiring careful regression validation',
          '3: High-risk architectural change that could break critical core paths',
        ],
      },
    };

    return questions;
  }

  /**
   * Parse Jev answers into a structured DispatchDecision
   */
  public parseAnswers(
    answers: Record<string, JevAnswer>,
    skills: SkillSummary[],
    latencyMs: number,
    inputTokens: number
  ): DispatchDecision {
    const decision: DispatchDecision = {
      latencyMs,
      inputTokens,
      rawAnswers: answers,
    };

    // Parse target subsystem
    const q1 = answers['q1_target_subsystem'];
    if (q1 && q1.type === 'choice') {
      decision.targetSubsystems = [q1.choice];
      decision.confidence = q1.confidence;
    }

    // Parse active skill
    const q2 = answers['q2_active_skill'];
    if (q2 && q2.type === 'choice' && q2.choice !== 'none') {
      const skillKey = q2.choice.replace(/^skill_/, '');
      const matched = skills.find((s) => s.name.replace(/[^a-zA-Z0-9_]/g, '_') === skillKey || s.name === skillKey);
      if (matched) {
        decision.activatedSkill = matched.name;
        decision.activatedSkillPath = matched.path;
      }
    }

    // Parse safety rule
    const q3 = answers['q3_safety_guard'];
    if (q3 && q3.type === 'choice' && q3.choice !== 'standard_safe') {
      decision.safetyRules = [q3.choice];
    }

    // Parse risk score
    const q4 = answers['q4_complexity_risk'];
    if (q4 && q4.type === 'score') {
      decision.riskScore = q4.score;
    }

    return decision;
  }
}
