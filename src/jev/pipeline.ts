import {
  DispatchDecision,
  JevNavigatorConfig,
  JevQuestion,
  JevState,
  SkillSummary,
  MemoryGuard,
} from '../types.js';
import { JevClient } from './client.js';
import { JevPrompter } from './prompter.js';

export interface PipelineInputs {
  userPrompt: string;
  dsl: string;
  estimatedTokens: number;
  skills: SkillSummary[];
  memories: MemoryGuard[];
  safetyRules: string[];
}

export class JevDualPipeline {
  private client: JevClient;
  private prompter: JevPrompter;

  constructor(client: JevClient, prompter: JevPrompter) {
    this.client = client;
    this.prompter = prompter;
  }

  /**
   * Execute intelligent single-round or parallel dual-pipeline evaluation
   */
  public async execute(
    inputs: PipelineInputs,
    config: JevNavigatorConfig
  ): Promise<DispatchDecision | null> {
    const { userPrompt, dsl, estimatedTokens, skills, memories, safetyRules } = inputs;
    const timeoutMs = config.timeoutMs || 1500;
    const mode = config.executionMode || 'auto';

    // Estimate total tokens across graph + skills + memories
    const skillTokens = skills.length * 45;
    const memTokens = (config.enableMemories !== false ? memories.length : 0) * 45;
    const totalEstimatedTokens = estimatedTokens + skillTokens + memTokens;

    const shouldUseParallel =
      mode === 'parallel' ||
      (mode === 'auto' && totalEstimatedTokens > 22000 && config.enableMemories !== false && memories.length > 0);

    const t0 = Date.now();

    if (shouldUseParallel) {
      return this.executeParallel(inputs, config, timeoutMs, t0);
    } else {
      return this.executeUnified(inputs, config, timeoutMs, t0);
    }
  }

  /**
   * Unified Single Request Pipeline (Under 22k tokens)
   */
  private async executeUnified(
    inputs: PipelineInputs,
    config: JevNavigatorConfig,
    timeoutMs: number,
    t0: number
  ): Promise<DispatchDecision | null> {
    const { userPrompt, dsl, skills, memories, safetyRules } = inputs;

    const activeSkills = config.enableSkills !== false ? skills : [];
    const activeMemories = config.enableMemories !== false ? memories : [];

    const { questions, dirCriteriaMap } = this.prompter.buildQuestions(
      dsl,
      activeSkills,
      safetyRules,
      activeMemories,
      userPrompt
    );

    // Apply feature toggles to questions
    if (config.enableSubsystems === false) {
      delete questions.q1_target_subsystem;
    }
    if (config.enableSkills === false) {
      delete questions.q2_active_skill;
    }
    if (config.enableMemories === false) {
      delete questions.q5_memory_guard;
    }

    const state: JevState = {
      user_task: userPrompt,
      codebase_trie_map: dsl,
      safety_rules: safetyRules,
    };

    try {
      const result = await this.client.evaluate({ state, questions }, timeoutMs);
      const decision = this.prompter.parseAnswers(
        result.response.answers,
        activeSkills,
        dirCriteriaMap,
        result.latencyMs,
        result.response.usage.input_tokens,
        activeMemories
      );

      decision.pipelineMode = 'unified';
      return decision;
    } catch (err) {
      if (config.logDecisions) {
        console.warn(`[pi-jev-navigator] Jev unified execution bypassed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }

  /**
   * Parallel Dual Request Pipeline (Over 22k tokens or forced parallel mode)
   * Req 1: CodeGraph + Subsystems + Skills (32K capacity)
   * Req 2: Memory Guards & Corrections (32K capacity)
   * Promise.all executes both concurrently within ~500ms
   */
  private async executeParallel(
    inputs: PipelineInputs,
    config: JevNavigatorConfig,
    timeoutMs: number,
    t0: number
  ): Promise<DispatchDecision | null> {
    const { userPrompt, dsl, skills, memories, safetyRules } = inputs;

    const activeSkills = config.enableSkills !== false ? skills : [];
    const activeMemories = config.enableMemories !== false ? memories : [];

    // 1. Build Req 1 (CodeGraph & Skills)
    const { questions: q1Questions, dirCriteriaMap } = this.prompter.buildQuestions(
      dsl,
      activeSkills,
      safetyRules,
      [], // omit memories in req 1
      userPrompt
    );
    delete q1Questions.q5_memory_guard;

    if (config.enableSubsystems === false) {
      delete q1Questions.q1_target_subsystem;
    }
    if (config.enableSkills === false) {
      delete q1Questions.q2_active_skill;
    }

    const req1State: JevState = {
      user_task: userPrompt,
      codebase_trie_map: dsl,
      safety_rules: safetyRules,
    };

    // 2. Build Req 2 (Memory Guards)
    const memoryCriteria: Record<string, string> = {};
    for (const m of activeMemories) {
      memoryCriteria[m.id] = `[${m.category}] ${m.summary.slice(0, 100)}`;
    }
    memoryCriteria['none'] = 'No specific memory constraint or past correction applies to this task';

    const req2Questions: Record<string, JevQuestion> = {
      q5_memory_guard: {
        type: 'choice',
        instructions:
          'If a past correction, user preference, or operational constraint in `memory_guards` applies to `user_task`, which guard must be enforced?',
        criteria: memoryCriteria,
      },
    };

    const req2State: JevState = {
      user_task: userPrompt,
    };

    try {
      const [res1, res2] = await Promise.all([
        this.client.evaluate({ state: req1State, questions: q1Questions }, timeoutMs),
        this.client.evaluate({ state: req2State, questions: req2Questions }, timeoutMs),
      ]);

      const mergedAnswers = {
        ...res1.response.answers,
        ...res2.response.answers,
      };

      const totalTokens = res1.response.usage.input_tokens + res2.response.usage.input_tokens;
      const totalLatency = Date.now() - t0;

      const decision = this.prompter.parseAnswers(
        mergedAnswers,
        activeSkills,
        dirCriteriaMap,
        totalLatency,
        totalTokens,
        activeMemories
      );

      decision.pipelineMode = 'parallel';
      return decision;
    } catch (err) {
      if (config.logDecisions) {
        console.warn(`[pi-jev-navigator] Jev parallel execution bypassed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }
}
