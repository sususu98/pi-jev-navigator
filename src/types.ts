/**
 * Core type definitions for pi-jev-navigator
 */

/** API descriptions may carry structured JSON with directly referenced fields. */
export type JevDescription = string | number | boolean | null
  | JevDescription[] | { [key: string]: JevDescription };

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export interface JevNoulQuestion {
  type: 'noul';
  instructions: JevDescription;
  criteria?: { true: JevDescription; false: JevDescription };
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export interface JevState {
  user_task: string;
  codebase_trie_map?: string;
  /** Constant independent Skill applicability rubric, shared once per request. */
  skill_policy?: string;
  skills_catalog?: string[];
  memory_guards?: string[];
  safety_rules?: string[];
  context_metadata?: Record<string, unknown>;
}

export interface JevSystemOneRequest {
  model: string;
  state: JevState;
  questions: Record<string, JevQuestion>;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  probabilities?: Record<string, number>;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export interface JevSystemOneResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface CodeGraphExportOptions {
  rootDir: string;
  excludeTests?: boolean;
  maxSymbolsPerFile?: number;
  ignoreDirs?: string[];
  maxFiles?: number;
  maxDepth?: number;
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export interface MemoryGuard {
  id: string;
  category: 'correction' | 'preference' | 'failure' | 'convention' | 'tool-quirk' | 'insight' | 'memory';
  title: string;
  summary: string;
  rule: string;
  project?: string;
  sourceTarget?: 'memory' | 'user' | 'failure' | 'project';
}

export type ExecutionMode = 'auto' | 'parallel' | 'unified';

export interface MemoryRetrievalStats {
  source: 'hermes-sqlite';
  status: 'ready' | 'empty' | 'disabled' | 'unavailable' | 'unsupported' | 'cancelled';
  eligible: number; retrieved: number; candidates: number; selected: number;
  latencyMs: number; estimatedTokens: number; queries: number; budgetLimited: boolean;
  /** Ordered manifest: q5_memory_<index> maps to this stable Hermes ID. */
  candidateIds?: string[];
  keywordTerms?: string[];
  keywordQueryGroups?: string[][];
  /** Hermes-eligible scope versus the optional target-filtered search pool. */
  project?: string | null;
  targets?: Array<'memory' | 'user' | 'failure' | 'project'>;
  searchable?: number;
  keywordLatencyMs?: number;
  keywordStatus?: 'ready' | 'bypassed' | 'timeout' | 'error';
}

export interface DispatchDecision {
  memoryRetrieval?: MemoryRetrievalStats;
  targetSubsystems?: string[];
  targetFiles?: string[];
  activatedSkills?: SkillSummary[];
  activatedSkill?: string;
  activatedSkillPath?: string;
  activatedMemoryGuard?: MemoryGuard | null;
  activatedMemoryGuards?: MemoryGuard[];
  safetyRules?: string[];
  riskScore?: number;
  confidence?: number;
  rawAnswers?: Record<string, JevAnswer>;
  latencyMs?: number;
  inputTokens?: number;
  tokenBreakdown?: {
    codeTokens?: number;
    memoryTokens?: number;
    overviewTokens?: number;
    catalogTokens?: number;
    overviewRequests?: number;
    catalogRequests?: number;
    totalTokens?: number;
    totalRequests?: number;
  };
  /** Per-request calibration manifest; never includes credentials or candidate bodies. */
  requestUsage?: Array<{
    track: 'overview' | 'catalog' | 'unified'; model: string;
    inputTokens: number; outputTokens: number; latencyMs: number;
    totalTokens: number; windowTokens: number; stateTokens: number; longestQuestionTokens: number;
    wireBytes: number; questionCount: number;
  }>;
  estimatedCapacity?: {
    totalTokens: number; windowTokens: number; stateTokens: number; longestQuestionTokens: number;
    wireBytes: number; questionCount: number;
  };
  estimatedPayloadTokens?: number;
  estimatedTrackTokens?: { unified?: number; overview?: number; catalog?: number };
  pipelineMode?: ExecutionMode;
  bypassed?: boolean;
  bypassReason?: string;
}

export interface JevNavigatorConfig {
  apiKey?: string;
  keyFilePath?: string;
  endpoint?: string;
  model?: string;
  enableTailInjection?: boolean;
  enableSubsystems?: boolean;
  enableSkills?: boolean;
  enableMemories?: boolean;
  executionMode?: ExecutionMode;
  timeoutMs?: number;
  /** @deprecated Use memoryCandidateLimit for retrieval and maxInjectedMemoryGuards for output. */
  maxMemoryGuards?: number;
  /** Maximum Jev-selected constraints appended to the user prompt. */
  maxInjectedMemoryGuards?: number;
  /** Maximum independently applicable SOP skills in tail guidance (default 3). */
  maxInjectedSkills?: number;
  /** Minimum Noul applicability signal for SOP output; (0.5, 1], default 0.75. */
  skillApplicabilityThreshold?: number;
  /** Minimum Noul applicability signal for memory output; (0.5, 1], default 0.75. */
  memoryApplicabilityThreshold?: number;
  /** Maximum locally retrieved memory candidates sent to Jev (default 64). */
  memoryCandidateLimit?: number;
  /** Serialized independent Noul memory-question budget, estimated tokens (default 8000). */
  memoryCandidateTokens?: number;
  /** Whether to use fast Gemini upstream to expand memory search queries (default true). */
  enableKeywordExpansion?: boolean;
  /** Upstream model for memory keyword expansion (default 'gemini-3.5-flash-lite'). */
  keywordModel?: string;
  /** Maximum time budget for memory keyword extraction before fallback (default 1200ms). */
  keywordTimeoutMs?: number;
  cacheTtlDays?: number;
  logDecisions?: boolean;
  ignoreDirs?: string[];
  maxFilesIndexed?: number;
  maxScanDepth?: number;
  projects?: Record<string, Partial<Omit<JevNavigatorConfig, 'projects'>>> | Array<Partial<Omit<JevNavigatorConfig, 'projects'>> & { path: string }>;
}
