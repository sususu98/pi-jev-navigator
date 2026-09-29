import * as fs from 'fs';
import * as path from 'path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  ContextWithSystemEvent,
  ContextEventResult,
  SessionStartEvent,
  TurnEndEvent,
  AgentEndEvent,
} from '@earendil-works/pi-coding-agent';
import { CodeGraphExtractor } from './graph/codegraph.js';
import { GitNexusAdapter } from './graph/gitnexus-adapter.js';
import { SkillCollector } from './skills/collector.js';
import { MemoryCollector } from './memory/collector.js';
import { TTLStore } from './cache/ttl-store.js';
import { JevClient } from './jev/client.js';
import { JevPrompter } from './jev/prompter.js';
import { TailInjector } from './injector/tail-injector.js';
import { resolveGitContext, GitContext } from './graph/git.js';
import { JevNavigatorConfig, DispatchDecision } from './types.js';

export class JevNavigator {
  private config: JevNavigatorConfig;
  private extractor: CodeGraphExtractor;
  private gitnexus: GitNexusAdapter;
  private collector: SkillCollector;
  private memoryCollector: MemoryCollector;
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
    this.memoryCollector = new MemoryCollector();
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
    safetyRules: string[] = [],
    sessionMeta?: { sessionFile?: string; sessionId?: string }
  ): Promise<DispatchDecision | null> {
    try {
      const graph = this.getOrGenerateCodeGraph();
      const skills = this.collector.collectSkills(this.projectRoot);
      const memories = this.memoryCollector.collectMemories(this.projectRoot);
      const { questions, dirCriteriaMap } = this.prompter.buildQuestions(
        graph.dsl,
        skills,
        safetyRules,
        memories,
        userPrompt
      );

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
        dirCriteriaMap,
        result.latencyMs,
        result.response.usage.input_tokens,
        memories
      );

      this.logDecisionToFile(userPrompt, decision, sessionMeta);

      return decision;
    } catch (err) {
      if (this.config.logDecisions) {
        console.error('[pi-jev-navigator] Jev evaluation failed:', err);
      }
      return null;
    }
  }

  /**
   * Persist structured decision telemetry matching Pi's per-project per-session structure:
   * ~/.pi/agent/jev-sessions/<project-slug>/<session-filename>.jsonl
   */
  public logDecisionToFile(
    userPrompt: string,
    decision: DispatchDecision,
    sessionMeta?: { sessionFile?: string; sessionId?: string }
  ): void {
    if (!this.config.logDecisions) return;
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const baseJevDir = path.join(homeDir, '.pi', 'agent', 'jev-sessions');

      const normalizedCwd = path.resolve(this.projectRoot).replace(/\\/g, '/');
      const projectSlug = `--${normalizedCwd.replace(/^\/+/, '').replace(/\/+/g, '-')}--`;
      const projectDir = path.join(baseJevDir, projectSlug);

      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }

      let logFile: string;
      if (sessionMeta?.sessionFile) {
        logFile = path.join(projectDir, path.basename(sessionMeta.sessionFile));
      } else if (sessionMeta?.sessionId) {
        logFile = path.join(projectDir, `${sessionMeta.sessionId}.jsonl`);
      } else {
        const today = new Date().toISOString().slice(0, 10);
        logFile = path.join(projectDir, `jev-${today}.jsonl`);
      }

      const entry = {
        ts: Date.now(),
        iso: new Date().toISOString(),
        project: this.projectRoot,
        session_id: sessionMeta?.sessionId || null,
        session_file: sessionMeta?.sessionFile || null,
        prompt: userPrompt,
        latency_ms: decision.latencyMs,
        input_tokens: decision.inputTokens,
        target_subsystems: decision.targetSubsystems,
        activated_skill: decision.activatedSkill || null,
        activated_memory_guard: decision.activatedMemoryGuard
          ? {
              category: decision.activatedMemoryGuard.category,
              title: decision.activatedMemoryGuard.title,
              summary: decision.activatedMemoryGuard.summary,
            }
          : null,
        risk_score: decision.riskScore,
        confidence: decision.confidence,
        raw_answers: decision.rawAnswers,
      };
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Best-effort logging
    }
  }

  /**
   * Prune System Prompt skills according to Jev activation decision
   */
  public pruneSystemPrompt(systemPrompt: string, activatedSkill?: string): string {
    return this.injector.pruneSystemPromptSkills(systemPrompt, activatedSkill);
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
   * Get status summary with full Git Worktree metadata
   */
  public getStatus(): Record<string, unknown> {
    const gitCtx = resolveGitContext(this.projectRoot);
    const graph = this.getOrGenerateCodeGraph();
    const skills = this.collector.collectSkills(this.projectRoot);
    const memories = this.memoryCollector.collectMemories(this.projectRoot);
    const gitnexusStatus = this.gitnexus.checkStatus(this.projectRoot);
    const hasKey = !!this.client.getApiKey();

    return {
      projectRoot: this.projectRoot,
      isWorktree: gitCtx.isWorktree,
      worktreeRoot: gitCtx.worktreeRoot,
      mainRepoRoot: gitCtx.mainRepoRoot,
      branch: gitCtx.branch || 'N/A',
      apiKeyConfigured: hasKey,
      gitnexusIndexed: gitnexusStatus.isIndexed,
      gitnexusCommit: gitnexusStatus.commitSha || 'N/A',
      codebaseFilesIndexed: graph.totalFiles,
      estimatedTokens: graph.estimatedTokens,
      skillsCollected: skills.length,
      memoriesCollected: memories.length,
      cached: graph.fromCache,
    };
  }
}

/**
 * Pi Extension Entrypoint for pi-coding-agent
 * Conforms 100% to Pi Extension Development Specification
 */
export default function registerJevNavigatorExtension(pi: ExtensionAPI) {
  const navigators = new Map<string, JevNavigator>();
  let currentTurnDecision: DispatchDecision | null = null;

  const getNavigator = (cwd: string) => {
    const resolved = path.resolve(cwd);
    let nav = navigators.get(resolved);
    if (!nav) {
      nav = new JevNavigator(resolved);
      navigators.set(resolved, nav);
    }
    return nav;
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

  // 2. Before Agent Start: evaluate prompt with Jev, prune System Prompt skills, and prepare navigation
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
    const nav = getNavigator(ctx.cwd);
    currentTurnDecision = null;

    if (!event.prompt || event.prompt.startsWith('/')) {
      return;
    }

    try {
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage('⚡ Jev System One routing...');
      }
      const sessionMeta = {
        sessionFile: ctx.sessionManager?.getSessionFile?.(),
        sessionId: ctx.sessionManager?.getSessionId?.(),
      };
      const decision = await nav.evaluatePrompt(event.prompt, [], sessionMeta);
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage();
      }

      if (decision) {
        currentTurnDecision = decision;
        if (ctx.hasUI) {
          const parts: string[] = [];
          if (decision.targetSubsystems && decision.targetSubsystems.length > 0) {
            parts.push(`Subsystem: ${decision.targetSubsystems.join(', ')}`);
          } else {
            parts.push('Subsystem: General');
          }
          if (decision.activatedSkill) {
            parts.push(`Skill: ${decision.activatedSkill}`);
          }
          if (decision.activatedMemoryGuard) {
            parts.push(`Guard: [${decision.activatedMemoryGuard.category}] ${decision.activatedMemoryGuard.title.slice(0, 30)}`);
          }
          ctx.ui.notify(`⚡ Jev Routed: ${parts.join(' | ')} (${decision.latencyMs?.toFixed(0)}ms)`, 'info');
        }

        // Prune System Prompt: strip unactivated skills to save thousands of tokens
        const prunedSystemPrompt = nav.pruneSystemPrompt(event.systemPrompt, decision.activatedSkill);
        return {
          systemPrompt: prunedSystemPrompt,
        };
      }
    } catch (err) {
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage();
      }
    }
  });

  // 3. Context Hook: dynamically prune System Prompt skills and inject tail navigation to LLM messages without polluting readline history
  pi.on('context_with_system', async (event: ContextWithSystemEvent, _ctx: ExtensionContext): Promise<ContextEventResult | void> => {
    if (!event.messages || event.messages.length === 0) {
      return;
    }

    const injector = new TailInjector();
    const activatedSkill = currentTurnDecision?.activatedSkill;

    // Deep inspect every message in event.messages
    for (const msg of event.messages) {
      const m = msg as Record<string, unknown>;
      if (typeof m.content === 'string') {
        if (m.content.includes('<skills>')) {
          m.content = injector.pruneSystemPromptSkills(m.content, activatedSkill);
        }
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object' && 'text' in part && typeof (part as Record<string, unknown>).text === 'string') {
            const pText = (part as Record<string, unknown>).text as string;
            if (pText.includes('<skills>')) {
              (part as Record<string, unknown>).text = injector.pruneSystemPromptSkills(pText, activatedSkill);
            }
          }
        }
      }
    }

    // B. Inject tail navigation context to the latest user message
    if (currentTurnDecision) {
      const guidance = injector.formatTailGuidance(currentTurnDecision);
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i];
        if (msg.role === 'user') {
          if (typeof msg.content === 'string') {
            if (!msg.content.includes('[System One Navigation Context')) {
              msg.content = `${msg.content}${guidance}`;
            }
          } else if (Array.isArray(msg.content)) {
            const lastPart = msg.content[msg.content.length - 1];
            if (lastPart && 'text' in lastPart && typeof lastPart.text === 'string') {
              if (!lastPart.text.includes('[System One Navigation Context')) {
                lastPart.text = `${lastPart.text}${guidance}`;
              }
            }
          }
          break;
        }
      }
    }

    return { messages: event.messages };
  });

  // 4. Provider Payload Hook: 100% guarantee System Prompt skill pruning before HTTP dispatch across all LLM providers
  pi.on('before_provider_request', async (event: BeforeProviderRequestEvent, _ctx: ExtensionContext) => {
    const payload = event.payload as Record<string, unknown> | null | undefined;
    if (!payload) return;

    try {
      const injector = new TailInjector();
      const activatedSkill = currentTurnDecision?.activatedSkill;

      const traverseAndPrune = (obj: any): void => {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (typeof val === 'string' && val.includes('<skills>')) {
            obj[key] = injector.pruneSystemPromptSkills(val, activatedSkill);
          } else if (typeof val === 'object' && val !== null) {
            traverseAndPrune(val);
          }
        }
      };

      traverseAndPrune(payload);
    } catch {
      // Ignore
    }

    return payload;
  });

  // 5. Cleanup turn state on turn end or agent end
  pi.on('turn_end', async (_event: TurnEndEvent, _ctx: ExtensionContext) => {
    currentTurnDecision = null;
  });

  pi.on('agent_end', async (_event: AgentEndEvent, _ctx: ExtensionContext) => {
    currentTurnDecision = null;
  });

  // 5. Register Slash Command: /jev-status
  pi.registerCommand('jev-status', {
    description: 'Display Jev System One engine and CodeGraph index status',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const nav = getNavigator(ctx.cwd);
      const status = nav.getStatus();
      const statusStr = [
        '⚡ [TypeSafe Jev Navigator Status]',
        `• Project Root: ${status.projectRoot}`,
        ...(status.isWorktree
          ? [`• Git Worktree: Active [${status.branch}] (Main Repo: ${status.mainRepoRoot})`]
          : [`• Git Branch: [${status.branch}]`]),
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
      const sessionMeta = {
        sessionFile: ctx.sessionManager?.getSessionFile?.(),
        sessionId: ctx.sessionManager?.getSessionId?.(),
      };
      const decision = await nav.evaluatePrompt(args, [], sessionMeta);
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
