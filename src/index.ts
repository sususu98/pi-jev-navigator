import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { CodeGraphExtractor, isSystemRootOrHome } from './graph/codegraph.js';
import { GitNexusAdapter } from './graph/gitnexus-adapter.js';
import { SkillCollector } from './skills/collector.js';
import { HermesMemoryRetriever } from './memory/hermes-retriever.js';
import { TTLStore } from './cache/ttl-store.js';
import { JevClient } from './jev/client.js';
import { JevPrompter } from './jev/prompter.js';
import { TailInjector } from './injector/tail-injector.js';
import { JevConfigStore } from './config/config-store.js';
import { redactSensitive, sensitiveValues } from './config/redact.js';
import { JevDualPipeline } from './jev/pipeline.js';
import { formatRoutingStats, formatMemoryRetrieval } from './jev/stats.js';
import { resolveGitContext } from './graph/git.js';
import { registerRuntimeHooks } from './runtime.js';
import type { JevNavigatorConfig, DispatchDecision, SkillSummary, MemoryRetrievalStats } from './types.js';

interface SessionMeta { sessionFile?: string; sessionId?: string }
interface EvaluationOptions { skills?: SkillSummary[]; signal?: AbortSignal }

export class JevNavigator {
  private configStore: JevConfigStore;
  private extractor = new CodeGraphExtractor();
  private gitnexus = new GitNexusAdapter();
  private collector: SkillCollector;
  private memoryRetriever: HermesMemoryRetriever;
  private lastMemoryRetrieval?: MemoryRetrievalStats;
  private ttlStore: TTLStore;
  private client: JevClient;
  private pipeline: JevDualPipeline;
  private injector = new TailInjector();
  private projectRoot: string;
  private lastDecision?: DispatchDecision;

  constructor(projectRoot: string = process.cwd(), config: JevNavigatorConfig = {}, private homeDir: string = os.homedir(), transport: typeof fetch = globalThis.fetch) {
    this.projectRoot = path.resolve(projectRoot);
    this.configStore = new JevConfigStore(this.projectRoot, config, homeDir);
    const active = this.configStore.get();
    this.collector = new SkillCollector(homeDir);
    this.memoryRetriever = new HermesMemoryRetriever(homeDir);
    this.ttlStore = new TTLStore(this.projectRoot, active.cacheTtlDays);
    this.client = new JevClient(active.endpoint, active.model, active.apiKey, active.keyFilePath, homeDir, transport);
    this.pipeline = new JevDualPipeline(this.client, new JevPrompter());
  }

  public getConfigStore(): JevConfigStore { return this.configStore; }
  public getConfig(): JevNavigatorConfig { return this.configStore.get(); }
  public getConfigForDisplay(): unknown {
    return redactSensitive(this.getConfig(), [this.client.getApiKey() ?? '']);
  }
  public hasApiKey(): boolean { return !!this.client.getApiKey(); }

  public getOrGenerateCodeGraph(forceRefresh: boolean = false): {
    dsl: string; totalFiles: number; totalSymbols: number; estimatedTokens: number; fromCache: boolean;
  } {
    if (isSystemRootOrHome(this.projectRoot, this.homeDir)) {
      return {
        dsl: '[~]\n',
        totalFiles: 0,
        totalSymbols: 0,
        estimatedTokens: 0,
        fromCache: false,
      };
    }
    const cachedDSL = !forceRefresh ? this.ttlStore.getRawFile('cpa-macro-map.dsl') : null;
    if (cachedDSL !== null) {
      const records = cachedDSL.split('\n').filter((line) => /\.(?:go|tsx?|jsx?|rs|py)->/.test(line));
      return {
        dsl: cachedDSL,
        totalFiles: records.length,
        totalSymbols: records.reduce((sum, line) => sum + line.split('->')[1].trim().split(/\s+/).length, 0),
        estimatedTokens: Math.ceil(Buffer.byteLength(cachedDSL, 'utf-8') / 3.8),
        fromCache: true,
      };
    }
    const config = this.configStore.get();
    const generated = this.extractor.generateTrieDSL({
      rootDir: this.projectRoot,
      excludeTests: true,
      ignoreDirs: config.ignoreDirs,
      maxFiles: config.maxFilesIndexed,
      maxDepth: config.maxScanDepth,
    });
    try { this.ttlStore.setRawFile('cpa-macro-map.dsl', generated.dsl); } catch { /* read-only checkout: use in-memory result */ }
    return { ...generated, fromCache: false };
  }

  public async evaluatePrompt(
    userPrompt: string,
    safetyRules: string[] = [],
    sessionMeta?: SessionMeta,
    options: EvaluationOptions = {}
  ): Promise<DispatchDecision | null> {
    const config = this.configStore.get();
    const started = Date.now();
    this.lastDecision = undefined;
    this.lastMemoryRetrieval = undefined;
    try {
      if (!this.hasApiKey() || options.signal?.aborted) return null;
      const graph = config.enableSubsystems !== false ? this.getOrGenerateCodeGraph() : { dsl: '', estimatedTokens: 0 };
      const skills: SkillSummary[] = [];
      if (config.enableSkills !== false) {
        const candidates = options.skills === undefined ? this.collector.collectSkills(this.projectRoot)
          : [...options.skills, ...this.collector.collectLearnedSkills(this.projectRoot)];
        const names = new Set<string>();
        for (const skill of candidates) {
          if (!names.has(skill.name)) { skills.push(skill); names.add(skill.name); }
        }
      }
      const retrieval = config.enableMemories !== false
        ? this.memoryRetriever.retrieve(userPrompt, this.projectRoot, {
          maxCandidates: config.memoryCandidateLimit, maxTokens: config.memoryCandidateTokens, signal: options.signal,
        }) : undefined;
      this.lastMemoryRetrieval = retrieval?.stats;
      const memories = retrieval?.memories ?? [];
      const decision = await this.pipeline.execute({
        userPrompt, dsl: graph.dsl, estimatedTokens: graph.estimatedTokens, skills, memories, safetyRules,
      }, config, options.signal);
      if (decision && retrieval) {
        retrieval.stats.selected = decision.activatedMemoryGuards?.length ?? (decision.activatedMemoryGuard ? 1 : 0);
        decision.memoryRetrieval = retrieval.stats;
      }
      if (!decision || decision.bypassed) {
        this.writeTelemetry(userPrompt, { bypassed: true, bypass_reason: decision?.bypassReason ?? 'timeout_or_error', latency_ms: Date.now() - started, memory_retrieval: retrieval?.stats }, sessionMeta);
        return null;
      }
      decision.latencyMs = Date.now() - started; // include local catalog/graph collection
      this.lastDecision = decision;
      this.logDecisionToFile(userPrompt, decision, sessionMeta);
      return decision;
    } catch (error) {
      this.writeTelemetry(userPrompt, { bypassed: true, bypass_reason: error instanceof Error ? error.message : 'error' }, sessionMeta);
      return null;
    }
  }

  /** Best-effort telemetry in private directories/files; never copy API configuration into logs. */
  private writeTelemetry(userPrompt: string, fields: Record<string, unknown>, sessionMeta?: SessionMeta): void {
    if (!this.getConfig().logDecisions) return;
    try {
      const baseDir = path.join(this.homeDir, '.pi', 'agent', 'jev-sessions');
      const normalized = this.projectRoot.replace(/\\/g, '/');
      const slug = `--${normalized.replace(/^\/+/, '').replace(/\/+/g, '-')}--`;
      const directory = path.join(baseDir, slug);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(baseDir, 0o700);
      fs.chmodSync(directory, 0o700);
      const filename = sessionMeta?.sessionFile ? path.basename(sessionMeta.sessionFile)
        : sessionMeta?.sessionId ? `${path.basename(sessionMeta.sessionId)}.jsonl`
        : `jev-${new Date().toISOString().slice(0, 10)}.jsonl`;
      const entry = {
        ts: Date.now(), iso: new Date().toISOString(), project: this.projectRoot,
        session_id: sessionMeta?.sessionId ?? null, session_file: sessionMeta?.sessionFile ?? null,
        prompt: userPrompt, ...fields,
      };
      const fd = fs.openSync(path.join(directory, filename), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        const safeEntry = redactSensitive(entry, [...sensitiveValues(this.getConfig()), this.client.getApiKey() ?? '']);
        fs.writeFileSync(fd, JSON.stringify(safeEntry) + '\n', 'utf-8');
      } finally { fs.closeSync(fd); }
    } catch { /* logging must never block the agent */ }
  }

  public logDecisionToFile(userPrompt: string, decision: DispatchDecision, sessionMeta?: SessionMeta): void {
    if (decision.bypassed) {
      this.writeTelemetry(userPrompt, { bypassed: true, bypass_reason: decision.bypassReason }, sessionMeta);
      return;
    }
    const guards = decision.activatedMemoryGuards ?? (decision.activatedMemoryGuard ? [decision.activatedMemoryGuard] : []);
    this.writeTelemetry(userPrompt, {
      latency_ms: decision.latencyMs, input_tokens: decision.inputTokens,
      pipeline_mode: decision.pipelineMode, token_breakdown: decision.tokenBreakdown,
      memory_retrieval: decision.memoryRetrieval,
      estimated_payload_tokens: decision.estimatedPayloadTokens, estimated_track_tokens: decision.estimatedTrackTokens,
      target_subsystems: decision.targetSubsystems,
      activated_skill: decision.activatedSkills === undefined ? decision.activatedSkill ?? null
        : decision.activatedSkills[0]?.name ?? null,
      activated_skills: decision.activatedSkills ?? (decision.activatedSkill
        ? [{ name: decision.activatedSkill, path: decision.activatedSkillPath }] : []),
      activated_memory_guard: guards[0] ?? null, activated_memory_guards: guards,
      risk_score: decision.riskScore, confidence: decision.confidence, raw_answers: decision.rawAnswers,
    }, sessionMeta);
  }

  public pruneSystemPrompt(systemPrompt: string, _activatedSkill?: string): string {
    return systemPrompt;
  }

  public async processUserPrompt(userPrompt: string, safetyRules: string[] = []): Promise<{ enrichedPrompt: string; decision: DispatchDecision | null }> {
    if (this.getConfig().enableTailInjection === false || !this.hasApiKey()) return { enrichedPrompt: userPrompt, decision: null };
    const decision = await this.evaluatePrompt(userPrompt, safetyRules);
    return { enrichedPrompt: decision ? this.injector.injectToPrompt(userPrompt, decision) : userPrompt, decision };
  }

  /** Explicit status command only: expensive filesystem/process discovery is not run on every hook. */
  public getStatus(): Record<string, unknown> {
    const git = resolveGitContext(this.projectRoot);
    const graph = this.getOrGenerateCodeGraph();
    const gitnexus = this.gitnexus.checkStatus(this.projectRoot);
    return {
      projectRoot: this.projectRoot, isWorktree: git.isWorktree, worktreeRoot: git.worktreeRoot,
      mainRepoRoot: git.mainRepoRoot, branch: git.branch || 'N/A', apiKeyConfigured: this.hasApiKey(),
      gitnexusIndexed: gitnexus.isIndexed, gitnexusCommit: gitnexus.commitSha || 'N/A',
      codebaseFilesIndexed: graph.totalFiles, estimatedTokens: graph.estimatedTokens,
      skillsCollected: this.collector.collectSkills(this.projectRoot).length,
      memoriesCollected: this.lastMemoryRetrieval?.eligible ??
        (this.getConfig().enableMemories !== false ? this.memoryRetriever.retrieve('', this.projectRoot).stats.eligible : 0),
      memoryRetrieval: this.lastMemoryRetrieval,
      cached: graph.fromCache,
      lastRoutingStats: this.lastDecision ? formatRoutingStats(this.lastDecision) : 'No successful routing in this session',
    };
  }
}

export default function registerJevNavigatorExtension(
  pi: ExtensionAPI,
  createNavigator: (cwd: string) => JevNavigator = (cwd) => new JevNavigator(cwd)
) {
  const navigators = new Map<string, JevNavigator>();
  const getNavigator = (cwd: string): JevNavigator => {
    const root = path.resolve(cwd);
    let nav = navigators.get(root);
    if (!nav) { nav = createNavigator(root); navigators.set(root, nav); }
    return nav;
  };
  registerRuntimeHooks(pi, getNavigator);
  pi.on('session_shutdown', async (_event, ctx) => { navigators.delete(path.resolve(ctx.cwd)); });

  pi.registerCommand('jev-status', {
    description: 'Display Jev engine, feature switches and CodeGraph status',
    handler: async (_args, ctx) => {
      const nav = getNavigator(ctx.cwd);
      const status = nav.getStatus();
      const config = nav.getConfig();
      const diagnostics = nav.getConfigStore().getDiagnostics();
      ctx.ui.notify([
        '⚡ [TypeSafe Jev Navigator Status]',
        `• Project Root: ${status.projectRoot}`,
        `• Git Branch: ${status.branch} | Worktree: ${status.isWorktree} | Main: ${status.mainRepoRoot}`,
        `• Execution Mode: ${config.executionMode} (Timeout: ${config.timeoutMs}ms)`,
        `• Subsystems: ${config.enableSubsystems} | Skills: ${config.enableSkills} | Memories: ${config.enableMemories}`,
        `• API Key Bound: ${status.apiKeyConfigured ? 'YES' : 'NO — set TYPESAFE_API_KEY or ~/.pi/agent/secrets/jev.key'}`,
        `• Codebase: ${status.codebaseFilesIndexed} files (~${status.estimatedTokens} estimated tokens)`,
        `• Catalogs: ${status.skillsCollected} standalone skills | ${status.memoriesCollected} eligible memories`,
        `• Cache: ${status.cached ? 'TTL cache' : 'fresh'}`,
        ...(status.memoryRetrieval ? [`• ${formatMemoryRetrieval(status.memoryRetrieval as MemoryRetrievalStats)}`] : []),
        `• Last Routing: ${status.lastRoutingStats}`,
        ...diagnostics,
      ].join('\n'), diagnostics.length ? 'warning' : 'info');
    },
  });
  pi.registerCommand('jev-config', {
    description: 'Inspect merged configuration (API key redacted)',
    handler: async (_args, ctx) => {
      const config = getNavigator(ctx.cwd).getConfigForDisplay();
      ctx.ui.notify(`⚡ [Jev Config]\n${JSON.stringify(config, null, 2)}`, 'info');
    },
  });
  pi.registerCommand('jev-toggle', {
    description: 'Toggle feature: /jev-toggle <skills|mem|subsystems|mode>',
    handler: async (args, ctx) => {
      const aliases: Record<string, 'skills' | 'memories' | 'subsystems' | 'mode'> = {
        skills: 'skills', skill: 'skills', mem: 'memories', memory: 'memories', memories: 'memories',
        subsystems: 'subsystems', subsystem: 'subsystems', dirs: 'subsystems', mode: 'mode',
      };
      const feature = aliases[args.trim().toLowerCase()];
      if (!feature) { ctx.ui.notify('Usage: /jev-toggle <skills | mem | subsystems | mode>', 'warning'); return; }
      const store = getNavigator(ctx.cwd).getConfigStore();
      const result = store.toggle(feature);
      const savedPath = store.saveProjectConfig();
      ctx.ui.notify(`✅ ${result.key} ➔ ${String(result.newValue)} (Saved to ${savedPath})`, 'info');
    },
  });
  pi.registerCommand('jev-refresh', {
    description: 'Force refresh the codebase symbol map',
    handler: async (_args, ctx) => {
      ctx.ui.setWorkingMessage('🔄 Re-indexing codebase...');
      try {
        const result = getNavigator(ctx.cwd).getOrGenerateCodeGraph(true);
        ctx.ui.notify(`✅ Indexed ${result.totalFiles} files (~${result.estimatedTokens} estimated tokens).`, 'info');
      } finally { ctx.ui.setWorkingMessage(); }
    },
  });
  pi.registerCommand('jev-eval', {
    description: 'Manually test Jev evaluation on a query',
    handler: async (args, ctx) => {
      if (!args.trim()) { ctx.ui.notify('Usage: /jev-eval <your query>', 'warning'); return; }
      ctx.ui.setWorkingMessage('⚡ Jev evaluating query...');
      try {
        const decision = await getNavigator(ctx.cwd).evaluatePrompt(args, [], {
          sessionFile: ctx.sessionManager?.getSessionFile?.(), sessionId: ctx.sessionManager?.getSessionId?.(),
        }, { signal: ctx.signal });
        if (!decision) { ctx.ui.notify('Jev bypassed: missing key, timeout or invalid response. Native context is unchanged.', 'warning'); return; }
        ctx.ui.notify([
          '🎯 [Jev Decision Result]',
          `• Target: ${decision.targetSubsystems?.join(', ') || 'General'}`,
          `• Skills: ${(decision.activatedSkills === undefined ? decision.activatedSkill
            : decision.activatedSkills.map(skill => `${skill.name} (${JSON.stringify(skill.path)})`).join(', ')) || 'None'}`,
          `• Safety: ${decision.safetyRules?.join('; ') || 'Standard'}`,
          `• Risk: ${decision.riskScore ?? 0}`,
          `• Stats: ${formatRoutingStats(decision)}`,
        ].join('\n'), 'info');
      } finally { ctx.ui.setWorkingMessage(); }
    },
  });
}

export * from './types.js';
export { CodeGraphExtractor, SkillCollector, TTLStore, JevClient, JevPrompter, TailInjector, HermesMemoryRetriever };
