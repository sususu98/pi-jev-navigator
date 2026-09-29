import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { CodeGraphExtractor } from './graph/codegraph.js';
import { GitNexusAdapter } from './graph/gitnexus-adapter.js';
import { SkillCollector } from './skills/collector.js';
import { TTLStore } from './cache/ttl-store.js';
import { JevClient } from './jev/client.js';
import { JevPrompter } from './jev/prompter.js';
import { TailInjector } from './injector/tail-injector.js';
import { JevNavigatorConfig, DispatchDecision } from './types.js';

export class JevNavigator {
  private config: JevNavigatorConfig;
  private extractor: CodeGraphExtractor;
  private gitnexus: GitNexusAdapter;
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
    this.gitnexus = new GitNexusAdapter();
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
    const gitnexusStatus = this.gitnexus.checkStatus(this.projectRoot);
    const hasKey = !!this.client.getApiKey();

    return {
      projectRoot: this.projectRoot,
      apiKeyConfigured: hasKey,
      gitnexusIndexed: gitnexusStatus.isIndexed,
      gitnexusCommit: gitnexusStatus.commitSha || 'N/A',
      codebaseFilesIndexed: graph.totalFiles,
      estimatedTokens: graph.estimatedTokens,
      skillsCollected: skills.length,
      cached: graph.fromCache,
    };
  }
}

/**
 * Pi Extension Entrypoint for pi-coding-agent
 * Conforms 100% to Pi Extension Development Specification
 */
export default function registerJevNavigatorExtension(pi: ExtensionAPI) {
  let navigator: JevNavigator | null = null;

  const getNavigator = (cwd: string) => {
    if (!navigator) {
      navigator = new JevNavigator(cwd);
    }
    return navigator;
  };

  // 1. Session start: display status indicator in UI footer
  pi.on('session_start', async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const nav = getNavigator(ctx.cwd);
    const status = nav.getStatus();
    if (status.apiKeyConfigured) {
      ctx.ui.setStatus('jev', `⚡ Jev Active (${status.codebaseFilesIndexed} files)`);
    } else {
      ctx.ui.setStatus('jev', '⚠️ Jev (No API Key)');
    }
  });

  // 2. Intercept user input: inject tail navigation context before dispatching to LLM
  pi.on('input', async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
    // Skip extension-injected or internal commands
    if (event.source === 'extension' || !event.text || event.text.startsWith('/')) {
      return { action: 'continue' };
    }

    const nav = getNavigator(ctx.cwd);
    try {
      ctx.ui.setWorkingMessage('⚡ Jev System One routing...');
      const result = await nav.processUserPrompt(event.text);
      ctx.ui.setWorkingMessage(); // Clear working message

      if (result.decision) {
        ctx.ui.notify(
          `⚡ Jev Routed: ${result.decision.targetSubsystems?.join(', ') || 'General'} (${result.decision.latencyMs?.toFixed(0)}ms)`,
          'info'
        );
        return {
          action: 'transform',
          text: result.enrichedPrompt,
          images: event.images,
        };
      }
    } catch {
      ctx.ui.setWorkingMessage();
    }

    return { action: 'continue' };
  });

  // 3. Register Slash Command: /jev-status
  pi.registerCommand('jev-status', {
    description: 'Display Jev System One engine and CodeGraph index status',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const nav = getNavigator(ctx.cwd);
      const status = nav.getStatus();
      const statusStr = [
        '⚡ [TypeSafe Jev Navigator Status]',
        `• Project Root: ${status.projectRoot}`,
        `• API Key Bound: ${status.apiKeyConfigured ? '✅ YES' : '❌ NO (Set TYPESAFE_API_KEY or ~/.pi/agent/secrets/jev.key)'}`,
        `• Indexed Business Files: ${status.codebaseFilesIndexed} files`,
        `• CodeGraph Tokens: ~${Number(status.estimatedTokens).toLocaleString()} tokens`,
        `• Cached: ${status.cached ? '✅ 7-Day TTL Active' : '🔄 Freshly Generated'}`,
        `• Skills Catalog: ${status.skillsCollected} available skills`,
      ].join('\n');

      ctx.ui.notify(statusStr, 'info');
    },
  });

  // 4. Register Slash Command: /jev-refresh
  pi.registerCommand('jev-refresh', {
    description: 'Force refresh the codebase Trie-Folded DSL graph',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const nav = getNavigator(ctx.cwd);
      ctx.ui.setWorkingMessage('🔄 Re-indexing codebase AST graph...');
      const result = nav.getOrGenerateCodeGraph(true);
      ctx.ui.setWorkingMessage();

      ctx.ui.notify(
        `✅ CodeGraph refreshed: Indexed ${result.totalFiles} files (~${result.estimatedTokens.toLocaleString()} tokens).`,
        'info'
      );
    },
  });

  // 5. Register Slash Command: /jev-eval <query>
  pi.registerCommand('jev-eval', {
    description: 'Manually test Jev evaluation on a query: /jev-eval <query>',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!args.trim()) {
        ctx.ui.notify('Usage: /jev-eval <your query>', 'warning');
        return;
      }

      const nav = getNavigator(ctx.cwd);
      ctx.ui.setWorkingMessage('⚡ Jev evaluating query...');
      const decision = await nav.evaluatePrompt(args);
      ctx.ui.setWorkingMessage();

      if (!decision) {
        ctx.ui.notify('❌ Jev evaluation failed or API key missing', 'error');
        return;
      }

      const summary = [
        '🎯 [Jev Decision Result]',
        `• Target: ${decision.targetSubsystems?.join(', ') || 'N/A'} (Conf: ${decision.confidence ?? '1.0'})`,
        `• Skill: ${decision.activatedSkill || 'None'}`,
        `• Safety: ${decision.safetyRules?.join('; ') || 'Standard'}`,
        `• Risk Level: ${decision.riskScore ?? 0}`,
        `• Latency: ${decision.latencyMs?.toFixed(1)}ms | Tokens: ${decision.inputTokens?.toLocaleString()}`,
      ].join('\n');

      ctx.ui.notify(summary, 'info');
    },
  });
}

export * from './types.js';
export { CodeGraphExtractor } from './graph/codegraph.js';
export { SkillCollector } from './skills/collector.js';
export { TTLStore } from './cache/ttl-store.js';
export { JevClient } from './jev/client.js';
export { JevPrompter } from './jev/prompter.js';
export { TailInjector } from './injector/tail-injector.js';
