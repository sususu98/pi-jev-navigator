/**
 * Core type definitions for pi-jev-navigator
 */

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
  instructions: string;
  statement: string;
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export interface JevState {
  user_task: string;
  codebase_trie_map?: string;
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
  confidence: number;
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
}

export type ExecutionMode = 'auto' | 'parallel' | 'unified';

export interface DispatchDecision {
  targetSubsystems?: string[];
  targetFiles?: string[];
  activatedSkill?: string;
  activatedSkillPath?: string;
  activatedMemoryGuard?: MemoryGuard | null;
  safetyRules?: string[];
  riskScore?: number;
  confidence?: number;
  rawAnswers?: Record<string, JevAnswer>;
  latencyMs?: number;
  inputTokens?: number;
  tokenBreakdown?: {
    codeTokens?: number;
    memoryTokens?: number;
    totalTokens?: number;
  };
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
  enableSystemPromptPruning?: boolean;
  executionMode?: ExecutionMode;
  timeoutMs?: number;
  maxMemoryGuards?: number;
  cacheTtlDays?: number;
  logDecisions?: boolean;
}
