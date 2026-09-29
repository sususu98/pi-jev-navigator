import * as path from 'path';
import * as fs from 'fs';
import { CodeGraphExtractor } from './graph/codegraph.js';
import { SkillCollector } from './skills/collector.js';
import { TTLStore } from './cache/ttl-store.js';
import { JevClient } from './jev/client.js';
import { JevPrompter } from './jev/prompter.js';
import { TailInjector } from './injector/tail-injector.js';
import { JevNavigatorConfig, DispatchDecision } from './types.js';

export class JevNavigator {
  private config: JevNavigatorConfig;
  private extractor: CodeGraphExtractor;
  private collector: SkillCollector;
  private ttlStore: TTLStore;
  private client: JevClient;
  private prompter: JevPrompter;
  private injector: TailInjector;
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd(), config: JevNavigatorConfig = {}) {
    this.projectRoot = projectRoot;
    this.config = {
      enableTailInjection: true,
      cacheTtlDays: 7,
      logDecisions: true,
      ...config,
    };

    this.extractor = new CodeGraphExtractor();
    this.collector = new SkillCollector();
    this.ttlStore = new TTLStore(this.projectRoot, this.config.cacheTtlDays);
    this.client = new JevClient(this.config.endpoint, this.config.model, this.config.apiKey);
    this.prompter = new JevPrompter();
    this.injector = new TailInjector();
  }

  /**
   * Get or generate Trie-Folded DSL for the project codebase
   */
  public getOrGenerateCodeGraph(forceRefresh: boolean = false): {
    dsl: string;
    totalFiles: number;
    totalSymbols: number;
    estimatedTokens: number;
    fromCache: boolean;
  } {
    const cachedDSL = !forceRefresh ? this.ttlStore.getRawFile('cpa-macro-map.dsl') : null;
    if (cachedDSL) {
      const bytes = Buffer.byteLength(cachedDSL, 'utf-8');
      return {
        dsl: cachedDSL,
        totalFiles: (cachedDSL.match(/\.go->|\.ts->|\.rs->|\.py->/g) || []).length,
        totalSymbols: 0,
        estimatedTokens: Math.ceil(bytes / 3.8),
        fromCache: true,
      };
    }

    const generated = this.extractor.generateTrieDSL({
      rootDir: this.projectRoot,
      excludeTests: true,
    });

    this.ttlStore.setRawFile('cpa-macro-map.dsl', generated.dsl);

    return {
      ...generated,
      fromCache: false,
    };
  }

  /**
   * Evaluate a user prompt and return the structured dispatch decision
   */
  public async evaluatePrompt(
    userPrompt: string,
    safetyRules: string[] = []
  ): Promise<DispatchDecision | null> {
    try {
      const graph = this.getOrGenerateCodeGraph();
      const skills = this.collector.collectSkills(this.projectRoot);
      const questions = this.prompter.buildQuestions(graph.dsl, skills, safetyRules);

      const state = {
        user_task: userPrompt,
        codebase_trie_map: graph.dsl,
        skills_catalog: this.collector.formatForJev(skills),
        safety_rules: safetyRules,
      };

      const result = await this.client.evaluate({ state, questions });
      const decision = this.prompter.parseAnswers(
        result.response.answers,
        skills,
        result.latencyMs,
        result.response.usage.input_tokens
      );

      return decision;
    } catch (err) {
      if (this.config.logDecisions) {
        console.error('[pi-jev-navigator] Jev evaluation failed:', err);
      }
      return null;
    }
  }

  /**
   * Process prompt before dispatching to LLM agent (Tail Injection)
   */
  public async processUserPrompt(
    userPrompt: string,
    safetyRules: string[] = []
  ): Promise<{ enrichedPrompt: string; decision: DispatchDecision | null }> {
    if (!this.config.enableTailInjection || !this.client.getApiKey()) {
      return { enrichedPrompt: userPrompt, decision: null };
    }

    const decision = await this.evaluatePrompt(userPrompt, safetyRules);
    if (!decision) {
      return { enrichedPrompt: userPrompt, decision: null };
    }

    const enrichedPrompt = this.injector.injectToPrompt(userPrompt, decision);
    return { enrichedPrompt, decision };
  }

  /**
   * Get status summary
   */
  public getStatus(): Record<string, unknown> {
    const graph = this.getOrGenerateCodeGraph();
    const skills = this.collector.collectSkills(this.projectRoot);
    const hasKey = !!this.client.getApiKey();

    return {
      projectRoot: this.projectRoot,
      apiKeyConfigured: hasKey,
      codebaseFilesIndexed: graph.totalFiles,
      estimatedTokens: graph.estimatedTokens,
      skillsCollected: skills.length,
      cached: graph.fromCache,
    };
  }
}

/**
 * Pi Extension Entrypoint for pi-coding-agent
 */
export default function registerExtension(pi: any) {
  const navigator = new JevNavigator(process.cwd());

  // Hook into prompt lifecycle
  if (pi.on) {
    pi.on('before_prompt', async (event: { prompt: string }) => {
      if (!event.prompt || event.prompt.startsWith('/')) return;

      const result = await navigator.processUserPrompt(event.prompt);
      if (result.decision) {
        event.prompt = result.enrichedPrompt;
      }
    });
  }

  // Register interactive slash commands
  if (pi.registerCommand) {
    pi.registerCommand({
      name: 'jev-status',
      description: 'Display Jev System One engine and CodeGraph index status',
      handler: async () => {
        const status = navigator.getStatus();
        return `### ⚡ Jev Navigator Status\n\`\`\`json\n${JSON.stringify(status, null, 2)}\n\`\`\``;
      },
    });

    pi.registerCommand({
      name: 'jev-refresh',
      description: 'Force refresh the codebase Trie-Folded DSL graph',
      handler: async () => {
        const result = navigator.getOrGenerateCodeGraph(true);
        return `✅ CodeGraph refreshed: Indexed ${result.totalFiles} files (~${result.estimatedTokens.toLocaleString()} tokens).`;
      },
    });

    pi.registerCommand({
      name: 'jev-eval',
      description: 'Manually test Jev evaluation on a query: /jev-eval <query>',
      handler: async (args: string) => {
        if (!args) return '⚠️ Usage: /jev-eval <your query>';
        const decision = await navigator.evaluatePrompt(args);
        return `### 🎯 Jev Decision Result\n\`\`\`json\n${JSON.stringify(decision, null, 2)}\n\`\`\``;
      },
    });
  }
}

export * from './types.js';
export { CodeGraphExtractor } from './graph/codegraph.js';
export { SkillCollector } from './skills/collector.js';
export { TTLStore } from './cache/ttl-store.js';
export { JevClient } from './jev/client.js';
export { JevPrompter } from './jev/prompter.js';
export { TailInjector } from './injector/tail-injector.js';
