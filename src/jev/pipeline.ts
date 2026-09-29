import { DispatchDecision, JevNavigatorConfig, JevState, SkillSummary, MemoryGuard } from '../types.js';
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
  constructor(private client: JevClient, private prompter: JevPrompter) {}

  /** All eligible candidates are sent unchanged; byte estimates select topology, not candidates. */
  public async execute(
    inputs: PipelineInputs,
    config: JevNavigatorConfig,
    signal?: AbortSignal
  ): Promise<DispatchDecision | null> {
    const t0 = Date.now();
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      requestSignal.throwIfAborted();
      const timeoutMs = config.timeoutMs ?? 1500;
      const skills = config.enableSkills !== false ? inputs.skills : [];
      const memories = config.enableMemories !== false ? inputs.memories : [];
      const dsl = config.enableSubsystems !== false ? inputs.dsl : '';
      const { questions, dirCriteriaMap } = this.prompter.buildQuestions(dsl, skills, inputs.safetyRules, memories, inputs.userPrompt);
      if (config.enableSubsystems === false) delete questions.q1_target_subsystem;
      if (!skills.length) delete questions.q2_active_skill;
      if (!memories.length) delete questions.q5_memory_guard;
      const state: JevState = {
        user_task: inputs.userPrompt,
        ...(config.enableSubsystems !== false ? { codebase_trie_map: dsl } : {}),
        safety_rules: inputs.safetyRules,
      };

      // Bytes are exact; tokens are an empirical estimate, NOT a tokenizer or capacity guarantee.
      // Preserve the user's calibrated 2.85 bytes/token and 28K auto-split threshold.
      const serializedBytes = Buffer.byteLength(JSON.stringify({ model: config.model || 'jev-latest', state, questions }), 'utf-8');
      const estimatedPayloadTokens = Math.ceil(serializedBytes / 2.85);
      const parallel = memories.length > 0 &&
        (config.executionMode === 'parallel' || ((config.executionMode || 'auto') === 'auto' && estimatedPayloadTokens > 28000));

      if (!parallel) {
        const result = await this.client.evaluate({ state, questions }, timeoutMs, requestSignal);
        const decision = this.prompter.parseAnswers(result.response.answers, skills, dirCriteriaMap,
          Date.now() - t0, result.response.usage.input_tokens, memories, inputs.safetyRules);
        decision.pipelineMode = 'unified';
        decision.tokenBreakdown = { totalTokens: result.response.usage.input_tokens };
        return decision;
      }

      const { q5_memory_guard, ...codeQuestions } = questions;
      const [codeResult, memoryResult] = await Promise.all([
        this.client.evaluate({ state, questions: codeQuestions }, timeoutMs, requestSignal),
        this.client.evaluate({ state: { user_task: inputs.userPrompt }, questions: { q5_memory_guard } }, timeoutMs, requestSignal),
      ]);
      const totalTokens = codeResult.response.usage.input_tokens + memoryResult.response.usage.input_tokens;
      const decision = this.prompter.parseAnswers(
        { ...codeResult.response.answers, ...memoryResult.response.answers },
        skills, dirCriteriaMap, Date.now() - t0, totalTokens, memories, inputs.safetyRules
      );
      decision.pipelineMode = 'parallel';
      decision.tokenBreakdown = {
        codeTokens: codeResult.response.usage.input_tokens,
        memoryTokens: memoryResult.response.usage.input_tokens,
        totalTokens,
      };
      return decision;
    } catch (error) {
      // A partial decision must never prune native skills. Abort the sibling request on failure.
      return {
        bypassed: true,
        bypassReason: error instanceof Error ? error.message : 'Jev evaluation failed',
        latencyMs: Date.now() - t0,
      };
    } finally {
      controller.abort();
    }
  }
}
