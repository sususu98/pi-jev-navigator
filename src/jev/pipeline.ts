import type {
  DispatchDecision, JevNavigatorConfig, SkillSummary, MemoryGuard, JevAnswer,
} from '../types.js';
import { JevClient } from './client.js';
import { JevPrompter } from './prompter.js';
import {
  AUTO_SPLIT_TOKENS, assertRequestCapacity, estimateRequestTokens, fitsRequest,
  partitionCatalog, partitionOverview, type RoutingRequest,
} from './capacity.js';

export interface PipelineInputs {
  userPrompt: string;
  dsl: string;
  estimatedTokens: number;
  skills: SkillSummary[];
  memories: MemoryGuard[];
  safetyRules: string[];
}

interface TrackResult {
  answers: Record<string, JevAnswer>;
  tokens: number;
  requests: number;
}
type Dispatch = (request: RoutingRequest) => Promise<TrackResult>;

/** Merge independently evaluated overview coverage; never compare batch-local skill confidence. */
function mergeOverview(results: TrackResult[]): TrackResult {
  const answers: Record<string, JevAnswer> = {};
  const directories = new Set<string>();
  let confidence = 0;
  for (const result of results) {
    for (const [id, answer] of Object.entries(result.answers)) {
      if (id === 'q1_target_subsystem' && answer.type === 'choice') {
        if (answer.choice !== 'none_or_new') directories.add(answer.choice);
        for (const [key, probability] of Object.entries(answer.probabilities ?? {})) {
          if (key !== 'none_or_new' && probability >= 0.25) directories.add(key);
        }
        confidence = Math.max(confidence, answer.confidence);
      } else if (answer.type !== 'score' || answers[id]?.type !== 'score' || answer.score > answers[id].score) {
        answers[id] = answer;
      }
    }
  }
  if (results.some((result) => result.answers.q1_target_subsystem)) {
    // These are merged coverage flags, not a claimed global probability distribution.
    answers.q1_target_subsystem = {
      type: 'choice', choice: directories.values().next().value ?? 'none_or_new', confidence,
      probabilities: directories.size ? Object.fromEntries([...directories].map((key) => [key, 1])) : { none_or_new: 1 },
    };
  }
  return { answers, tokens: results.reduce((n, result) => n + result.tokens, 0), requests: results.length };
}

export class JevDualPipeline {
  constructor(private client: JevClient, private prompter: JevPrompter) {}

  /** Two logical tracks; overflow batches preserve candidates and are explicitly accounted for. */
  public async execute(inputs: PipelineInputs, config: JevNavigatorConfig, signal?: AbortSignal): Promise<DispatchDecision | null> {
    const t0 = Date.now();
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const budget = Math.min(config.timeoutMs ?? 1500, 5000);
    const deadline = t0 + budget;
    const timer = setTimeout(() => controller.abort(new Error('Jev routing deadline exceeded')), budget);
    // Shared across both tracks and all capacity batches, not four workers per track.
    let active = 0;
    const waiters: Array<() => void> = [];
    const dispatch: Dispatch = async (request) => {
      if (active < 4) active++;
      else await new Promise<void>((resolve) => waiters.push(resolve));
      try {
        requestSignal.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Jev routing deadline exceeded');
        assertRequestCapacity(request, this.client.getModel());
        const result = await this.client.evaluate(request, remaining, requestSignal);
        return { answers: result.response.answers, tokens: result.response.usage.input_tokens, requests: 1 };
      } finally {
        const next = waiters.shift();
        if (next) next(); else active--;
      }
    };
    try {
      requestSignal.throwIfAborted();
      const skills = config.enableSkills !== false ? inputs.skills : [];
      const memories = config.enableMemories !== false ? inputs.memories : [];
      const dsl = config.enableSubsystems !== false ? inputs.dsl : '';
      const { questions, dirCriteriaMap } = this.prompter.buildQuestions(dsl, skills, inputs.safetyRules, memories, inputs.userPrompt);
      const hasOverview = Object.keys(dirCriteriaMap).length > 0;
      if (!hasOverview) delete questions.q1_target_subsystem;
      const model = this.client.getModel();
      const unified: RoutingRequest = {
        state: { user_task: inputs.userPrompt, ...(hasOverview ? { codebase_trie_map: dsl } : {}) }, questions,
      };
      const estimatedPayloadTokens = estimateRequestTokens(unified, model);
      const hasCatalog = skills.length > 0 || memories.length > 0 || inputs.safetyRules.length > 0;
      const mode = config.executionMode ?? 'auto';
      const parallel = hasOverview && hasCatalog && (mode === 'parallel' ||
        (mode === 'auto' && (estimatedPayloadTokens > AUTO_SPLIT_TOKENS || !fitsRequest(unified, model))));
      let overview: TrackResult | undefined;
      let catalog: TrackResult | undefined;
      let combined: TrackResult | undefined;
      let estimatedTrackTokens: DispatchDecision['estimatedTrackTokens'];
      if (parallel) {
        const a: RoutingRequest = {
          state: { user_task: inputs.userPrompt, codebase_trie_map: dsl },
          questions: { q1_target_subsystem: questions.q1_target_subsystem, q4_complexity_risk: questions.q4_complexity_risk },
        };
        const b: RoutingRequest = {
          state: { user_task: inputs.userPrompt },
          questions: Object.fromEntries(Object.entries(questions).filter(([id]) => id !== 'q1_target_subsystem' && id !== 'q4_complexity_risk')),
        };
        const aBatches = partitionOverview(a, model);
        const bBatches = partitionCatalog(b, model); // preflight both tracks before dispatching either
        estimatedTrackTokens = { overview: estimateRequestTokens(a, model), catalog: estimateRequestTokens(b, model) };
        [overview, catalog] = await Promise.all([
          this.evaluateOverview(aBatches, dispatch), this.evaluateCatalog(bBatches, dispatch),
        ]);
      } else if (fitsRequest(unified, model)) {
        combined = await dispatch(unified);
        estimatedTrackTokens = { unified: estimatedPayloadTokens };
      } else {
        if (hasOverview && hasCatalog) throw new Error('Forced Unified request exceeds capacity; use auto or parallel');
        estimatedTrackTokens = { unified: estimatedPayloadTokens };
        combined = hasOverview
          ? await this.evaluateOverview(partitionOverview(unified, model), dispatch)
          : await this.evaluateCatalog(partitionCatalog(unified, model), dispatch);
      }
      const tokens = combined?.tokens ?? overview!.tokens + catalog!.tokens;
      const decision = this.prompter.parseAnswers(
        combined?.answers ?? { ...overview!.answers, ...catalog!.answers }, skills, dirCriteriaMap,
        Date.now() - t0, tokens, memories, inputs.safetyRules, config.maxInjectedMemoryGuards ?? 3, config.maxInjectedSkills ?? 3,
        config.skillApplicabilityThreshold, config.memoryApplicabilityThreshold,
      );
      decision.pipelineMode = parallel ? 'parallel' : 'unified';
      decision.estimatedPayloadTokens = estimatedPayloadTokens;
      decision.estimatedTrackTokens = estimatedTrackTokens;
      decision.tokenBreakdown = parallel ? {
        overviewTokens: overview!.tokens, catalogTokens: catalog!.tokens, totalTokens: tokens,
        overviewRequests: overview!.requests, catalogRequests: catalog!.requests,
        totalRequests: overview!.requests + catalog!.requests,
      } : { totalTokens: tokens, totalRequests: combined!.requests };
      return decision;
    } catch (error) {
      return { bypassed: true, bypassReason: error instanceof Error ? error.message : 'Jev evaluation failed', latencyMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
      controller.abort(); // cancel siblings and queued work on any failure
    }
  }

  private async evaluateOverview(requests: RoutingRequest[], dispatch: Dispatch): Promise<TrackResult> {
    return mergeOverview(await Promise.all(requests.map(dispatch)));
  }

  private async evaluateCatalog(batches: RoutingRequest[], dispatch: Dispatch): Promise<TrackResult> {
    const results = await Promise.all(batches.map(dispatch));
    const answers: Record<string, JevAnswer> = {};
    const rules = new Set<string>();
    for (const result of results) {
      for (const [id, answer] of Object.entries(result.answers)) {
        if (id === 'q3_safety_guard' && answer.type === 'choice') {
          if (answer.choice !== 'standard_safe') rules.add(answer.choice);
          for (const [key, probability] of Object.entries(answer.probabilities ?? {})) {
            if (key !== 'standard_safe' && probability >= 0.3) rules.add(key);
          }
        } else {
          if (answers[id]) throw new Error('Duplicate independent catalog answer');
          answers[id] = answer;
        }
      }
    }
    if (results.some(r => r.answers.q3_safety_guard)) answers.q3_safety_guard = {
      type: 'choice', choice: rules.values().next().value ?? 'standard_safe', confidence: 1,
      probabilities: Object.fromEntries([...rules].map(key => [key, 1])),
    };
    return { answers, tokens: results.reduce((sum, r) => sum + r.tokens, 0), requests: results.length };
  }
}
