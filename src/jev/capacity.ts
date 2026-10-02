import type { JevQuestion, JevSystemOneRequest } from '../types.js';

export const BYTES_PER_TOKEN = 2.85;
// Jev 1.13: 64K state + all questions; 32K state + the longest question.
// Retain 12.5% headroom on both dimensions; estimates are not an exact tokenizer.
export const MAX_REQUEST_TOKENS = 56000;
export const MAX_WINDOW_TOKENS = 28000;
export const MAX_CHOICE_OPTIONS = 255; // includes the none/standard sentinel
export type RoutingRequest = Omit<JevSystemOneRequest, 'model'>;

export interface RequestCapacityEstimate {
  totalTokens: number; windowTokens: number; stateTokens: number; longestQuestionTokens: number;
  wireBytes: number; questionCount: number;
}

/** Two independent dimensions, not one concatenated 32K context.
 * Official API docs exclude question IDs from inference. Keep model/envelope bytes
 * conservatively, but question-map keys must not cause arbitrary capacity changes.
 */
export function estimateRequestCapacity(request: RoutingRequest, model: string): RequestCapacityEstimate {
  const questions = Object.values(request.questions);
  const stateBytes = Buffer.byteLength(JSON.stringify(request.state), 'utf8');
  const questionBytes = questions.map(question => Buffer.byteLength(JSON.stringify(question), 'utf8'));
  const longest = Math.max(0, ...questionBytes);
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ model, state: request.state, questions: [] }), 'utf8');
  const totalBytes = envelopeBytes + questionBytes.reduce((sum, bytes) => sum + bytes, 0)
    + Math.max(0, questions.length - 1);
  return {
    totalTokens: Math.ceil(totalBytes / BYTES_PER_TOKEN),
    windowTokens: Math.ceil((envelopeBytes + longest) / BYTES_PER_TOKEN),
    stateTokens: Math.ceil(stateBytes / BYTES_PER_TOKEN),
    longestQuestionTokens: Math.ceil(longest / BYTES_PER_TOKEN),
    wireBytes: Buffer.byteLength(JSON.stringify({ model, ...request }), 'utf8'),
    questionCount: questions.length,
  };
}

export function estimateRequestTokens(request: RoutingRequest, model: string): number {
  return estimateRequestCapacity(request, model).totalTokens;
}

export function fitsRequest(request: RoutingRequest, model: string): boolean {
  const estimate = estimateRequestCapacity(request, model);
  return estimate.totalTokens <= MAX_REQUEST_TOKENS && estimate.windowTokens <= MAX_WINDOW_TOKENS &&
    Object.values(request.questions).every((q) => q.type !== 'choice' || Object.keys(q.criteria).length <= MAX_CHOICE_OPTIONS);
}

export function assertRequestCapacity(request: RoutingRequest, model: string): void {
  if (!fitsRequest(request, model)) throw new Error('Jev request exceeds capacity: 56K total / 28K state + longest question safe budgets, or 255-choice limit');
}

/** Split complete independent questions; only the legacy safety choice needs option partitioning. */
export function partitionCatalog(request: RoutingRequest, model: string): RoutingRequest[] {
  if (fitsRequest(request, model)) return [request];
  const units: Array<{ id: string; question: JevQuestion }> = [];
  for (const [id, question] of Object.entries(request.questions)) {
    if (id === 'q3_safety_guard' && question.type === 'choice') {
      const entries = Object.entries(question.criteria).filter(([key]) => key !== 'standard_safe');
      if (!entries.length) units.push({ id, question });
      for (const [key, value] of entries) units.push({ id, question: {
        ...question, criteria: { [key]: value, standard_safe: question.criteria.standard_safe },
      } });
    } else units.push({ id, question });
  }
  const make = (items: typeof units): RoutingRequest => {
    const questions: Record<string, JevQuestion> = {};
    for (const { id, question } of items) {
      const previous = questions[id];
      questions[id] = previous?.type === 'choice' && question.type === 'choice'
        ? { ...question, criteria: { ...previous.criteria, ...question.criteria } } : question;
    }
    const state = { ...request.state };
    if (!items.some(item => item.id.startsWith('q2_skill_'))) delete state.skill_policy;
    return { state, questions };
  };
  const split = (items: typeof units): RoutingRequest[] => {
    const chunk = make(items);
    if (fitsRequest(chunk, model)) return [chunk];
    if (items.length <= 1) throw new Error('Jev task or individual catalog candidate exceeds request capacity');
    const mid = Math.ceil(items.length / 2);
    return [...split(items.slice(0, mid)), ...split(items.slice(mid))];
  };
  return split(units);
}

/** Keep every overview line; repeat directory headers when a block crosses batch boundaries. */
export function partitionOverview(request: RoutingRequest, model: string): RoutingRequest[] {
  if (fitsRequest(request, model)) return [request];
  const target = request.questions.q1_target_subsystem;
  if (target?.type !== 'choice') throw new Error('Jev task exceeds request capacity');
  const ids = new Map(Object.entries(target.criteria).map(([key, directory]) => [directory, key]));
  const records: Array<{ directory: string; line: string }> = [];
  let directory: string | undefined;
  for (const line of (request.state.codebase_trie_map ?? '').split('\n')) {
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      directory = header[1];
      records.push({ directory, line: '' });
    } else if (directory !== undefined && line) {
      records.push({ directory, line });
    }
  }
  const make = (items: typeof records): RoutingRequest => {
    const lines: string[] = [];
    const criteria: Record<string, string> = {};
    let previous: string | undefined;
    for (const item of items) {
      const id = ids.get(item.directory);
      if (!id || id === 'none_or_new') throw new Error('Unmapped overview directory');
      criteria[id] = item.directory;
      if (item.directory !== previous) lines.push(`[${item.directory}]`);
      if (item.line) lines.push(item.line);
      previous = item.directory;
    }
    criteria.none_or_new = target.criteria.none_or_new;
    return {
      state: { ...request.state, codebase_trie_map: lines.join('\n') },
      questions: { ...request.questions, q1_target_subsystem: { ...target, criteria } },
    };
  };
  const split = (items: typeof records): RoutingRequest[] => {
    const chunk = make(items);
    if (fitsRequest(chunk, model)) return [chunk];
    if (items.length <= 1) throw new Error('Jev task or individual overview record exceeds request capacity');
    const mid = Math.ceil(items.length / 2);
    return [...split(items.slice(0, mid)), ...split(items.slice(mid))];
  };
  return split(records);
}
