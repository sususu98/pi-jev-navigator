import type { DispatchDecision } from '../types.js';

/** Actual API usage only. Estimates are separate fields, never mixed into these labels. */
export function formatRoutingStats(decision: DispatchDecision): string {
  const latency = decision.latencyMs === undefined ? '?' : decision.latencyMs.toFixed(1);
  const usage = decision.tokenBreakdown;
  if (decision.pipelineMode === 'parallel') {
    const a = usage?.overviewTokens ?? usage?.codeTokens ?? 0;
    const b = usage?.catalogTokens ?? usage?.memoryTokens ?? 0;
    const count = (n?: number) => n && n > 1 ? ` (aggregate, ${n} requests)` : '';
    return `${latency}ms | Track A (Overview): ${(a / 1000).toFixed(1)}k${count(usage?.overviewRequests)} | Track B (Skills + Mem): ${(b / 1000).toFixed(1)}k${count(usage?.catalogRequests)} (Parallel)`;
  }
  const requests = usage?.totalRequests ?? 1;
  return `${latency}ms | ${(decision.inputTokens ?? usage?.totalTokens ?? 0).toLocaleString()} Input Tokens (Unified${requests > 1 ? `; aggregate across ${requests} requests` : ''})`;
}
