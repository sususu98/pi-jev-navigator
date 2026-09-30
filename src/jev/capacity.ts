import type { JevQuestion, JevSystemOneRequest } from '../types.js';

export const BYTES_PER_TOKEN = 2.85;
export const AUTO_SPLIT_TOKENS = 28000;
export const MAX_REQUEST_TOKENS = 32000;
export const MAX_CHOICE_OPTIONS = 255; // includes the none/standard sentinel
export type RoutingRequest = Omit<JevSystemOneRequest, 'model'>;

export function estimateRequestTokens(request: RoutingRequest, model: string): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ model, ...request }), 'utf8') / BYTES_PER_TOKEN);
}

export function fitsRequest(request: RoutingRequest, model: string): boolean {
  return estimateRequestTokens(request, model) <= MAX_REQUEST_TOKENS &&
    Object.values(request.questions).every((q) => q.type !== 'choice' || Object.keys(q.criteria).length <= MAX_CHOICE_OPTIONS);
}

export function assertRequestCapacity(request: RoutingRequest, model: string): void {
  if (!fitsRequest(request, model)) throw new Error('Jev request exceeds estimated 32K context or 255-choice capacity');
}

const sentinels: Record<string, string> = {
  q1_target_subsystem: 'none_or_new', q2_active_skill: 'none',
  q3_safety_guard: 'standard_safe', q5_memory_guard: 'none',
};

interface Candidate { question: string; key: string; value: string }

/** Capacity partitioning only: stable IDs and complete metadata survive every batch. */
export function partitionCatalog(request: RoutingRequest, model: string): RoutingRequest[] {
  if (fitsRequest(request, model)) return [request];
  const candidates: Candidate[] = [];
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== 'choice') continue;
    for (const [key, value] of Object.entries(question.criteria)) {
      if (key !== sentinels[id]) candidates.push({ question: id, key, value });
    }
  }
  const make = (items: Candidate[]): RoutingRequest => {
    const questions: Record<string, JevQuestion> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type !== 'choice') { questions[id] = question; continue; }
      const entries = items.filter((item) => item.question === id);
      const originallyEmpty = Object.keys(question.criteria).length === 1;
      if (!entries.length && !originallyEmpty) continue;
      const none = sentinels[id];
      questions[id] = { ...question, criteria: Object.fromEntries([
        ...entries.map((item) => [item.key, item.value]), [none, question.criteria[none]],
      ]) };
    }
    return { state: request.state, questions };
  };
  const split = (items: Candidate[]): RoutingRequest[] => {
    const chunk = make(items);
    if (fitsRequest(chunk, model)) return [chunk];
    if (items.length <= 1) throw new Error('Jev task or individual catalog candidate exceeds request capacity');
    const mid = Math.ceil(items.length / 2);
    return [...split(items.slice(0, mid)), ...split(items.slice(mid))];
  };
  return split(candidates);
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
