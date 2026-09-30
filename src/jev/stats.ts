import type { DispatchDecision, MemoryRetrievalStats } from '../types.js';

export function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M` : `${(tokens / 1000).toFixed(1)}K`;
}

export function formatMemoryRetrieval(stats: MemoryRetrievalStats): string {
  return `Memory: ${stats.eligible.toLocaleString()} eligible → ${stats.candidates} candidates → ${stats.selected} selected | Retrieval: ${stats.latencyMs.toFixed(1)}ms (${stats.status}${stats.budgetLimited ? ', budget-limited' : ''}) | ${formatTokens(stats.estimatedTokens)} estimated`;
}

/** Actual API usage only. Estimates are separate fields, never mixed into these labels. */
export function formatRoutingStats(decision: DispatchDecision): string {
  const latency = decision.latencyMs === undefined ? '?' : decision.latencyMs.toFixed(1);
  const usage = decision.tokenBreakdown;
  if (decision.pipelineMode === 'parallel') {
    const a = usage?.overviewTokens ?? usage?.codeTokens ?? 0;
    const b = usage?.catalogTokens ?? usage?.memoryTokens ?? 0;
    const count = (n?: number) => n && n > 1 ? ` (aggregate, ${n} requests)` : '';
    return `${latency}ms | Track A (Overview): ${formatTokens(a)}${count(usage?.overviewRequests)} | Track B (Skills + Mem): ${formatTokens(b)}${count(usage?.catalogRequests)} (Parallel)`;
  }
  const requests = usage?.totalRequests ?? 1;
  return `${latency}ms | ${formatTokens(decision.inputTokens ?? usage?.totalTokens ?? 0)} Input Tokens (Unified${requests > 1 ? `; aggregate across ${requests} requests` : ''})`;
}
