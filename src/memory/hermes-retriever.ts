import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'jsonc-parser/lib/esm/main.js';
import { resolveGitContext } from '../graph/git.js';
import { buildMemoryQuestions } from '../jev/prompter.js';
import type { MemoryGuard, MemoryRetrievalStats } from '../types.js';

interface Row {
  id: number; project: string | null; target: string; category: string | null;
  content: string; created: string; last_referenced: string;
}
export interface RetrievalOptions { maxCandidates?: number; maxTokens?: number; signal?: AbortSignal }
export interface RetrievalResult { memories: MemoryGuard[]; stats: MemoryRetrievalStats }
const categories = new Set(['correction', 'preference', 'failure', 'convention', 'tool-quirk', 'insight', 'memory']);

/** Lexical query construction only: no topic dictionary, synonyms or semantic relevance guesses. */
export function buildMemoryQueries(task: string): string[] {
  const text = task.normalize('NFKC').slice(0, 8192);
  const atoms = [...new Set(text.match(/[\p{L}\p{N}_./-]+/gu) ?? [])]
    .filter((term) => [...term].length >= 3).slice(0, 48);
  const quote = (term: string) => `"${term.replace(/"/g, '""')}"`;
  // Match the store's trigram tokenizer mechanically. Unsegmented Chinese clauses must
  // not require an entire user sentence to occur verbatim in a memory. No topic lexicon.
  const grams = new Set<string>();
  for (const span of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...span];
    for (let i = 0; i + 2 < chars.length && grams.size < 96; i++) grams.add(chars.slice(i, i + 3).join(''));
  }
  const gramQuery = [...grams].map(quote).join(' OR ');
  const identifiers = atoms.filter(term => /^[\p{Script=Latin}\p{N}_./-]+$/u.test(term));
  const queries = [
    ...(gramQuery && identifiers.length ? [identifiers.slice(0, 3).map(quote).join(' AND ')] : []),
    // Conjunction binds lexical identifiers to the surrounding task language rather than
    // letting a common provider name alone dominate all result lists. Still no synonyms.
    ...(gramQuery ? identifiers.slice(0, 3).map(term => `(${gramQuery}) AND ${quote(term)}`) : []),
    ...(gramQuery ? [gramQuery] : []),
    ...(!gramQuery && atoms.length ? [atoms.map(quote).join(' OR '), ...identifiers.slice(0, 3).map(quote)] : []),
  ];
  return [...new Set(queries)].slice(0, 8);
}

export function memoryFromRow(row: Row): MemoryGuard {
  const category = categories.has(row.category ?? '') ? row.category as MemoryGuard['category']
    : row.target === 'user' ? 'preference' : row.target === 'failure' ? 'failure' : 'memory';
  return {
    id: `hermes_${row.id}`, category, project: row.project ?? 'global',
    title: row.content.split('\n')[0], rule: row.content,
    // Dates are selection inputs, not evidence of relevance. Do not send duplicate full bodies.
    summary: `${row.content}\n[Hermes scope=${row.project ?? 'global'}; created=${row.created}; last=${row.last_referenced}]`,
  };
}

/** Budget includes every structured Noul question and its complete memory text. */
export function boundMemoryCandidates(rows: Row[][], maxCandidates: number, maxTokens: number): {
  memories: MemoryGuard[]; retrieved: number; budgetLimited: boolean; estimatedTokens: number;
} {
  const unique = new Set<number>();
  const memories: MemoryGuard[] = [];
  const bytes = () => Buffer.byteLength(JSON.stringify(buildMemoryQuestions(memories)), 'utf8');
  let limited = false;
  const retrieved = new Set(rows.flat().map((r) => r.id)).size;
  // Round-robin preserves representation from both scopes and guard/general channels.
  for (let rank = 0; rank < Math.max(0, ...rows.map((r) => r.length)); rank++) {
    for (const channel of rows) {
      const row = channel[rank];
      if (!row || unique.has(row.id)) continue;
      unique.add(row.id);
      const memory = memoryFromRow(row);
      if (memories.length >= maxCandidates) { limited = true; continue; }
      memories.push(memory);
      if (Math.ceil(bytes() / 2.85) > maxTokens) {
        memories.pop(); limited = true; continue; // skip whole record, never slice a rule
      }
    }
  }
  return { memories, retrieved, budgetLimited: limited, estimatedTokens: memories.length ? Math.ceil(bytes() / 2.85) : 0 };
}

/** Versioned read-only adapter for Hermes' memories + trigram FTS5 schema.
 * Hermes currently exports no stable extension-to-extension retrieval API. Do not import
 * private TS modules, instantiate its migration manager, or fall back to whole Markdown files.
 */
export class HermesMemoryRetriever {
  constructor(private homeDir = os.homedir()) {}

  private databasePath(): string {
    const agent = this.homeDir === os.homedir() && process.env.PI_CODING_AGENT_DIR
      ? path.resolve(process.env.PI_CODING_AGENT_DIR) : path.join(this.homeDir, '.pi', 'agent');
    let directory = path.join(agent, 'pi-hermes-memory');
    const configFile = path.join(agent, 'hermes-memory-config.json');
    if (fs.existsSync(configFile)) {
      const errors: any[] = [];
      const config = parse(fs.readFileSync(configFile, 'utf8'), errors, { allowTrailingComma: true });
      if (errors.length || !config || typeof config !== 'object') throw new Error('Invalid Hermes configuration');
      if (typeof config.memoryDir === 'string' && config.memoryDir.trim()) {
        const value = config.memoryDir.trim();
        const expanded = value.startsWith('~/') ? path.join(this.homeDir, value.slice(2)) : value;
        const configured = path.resolve(expanded);
        // Hermes treats its pre-migration memory directory alias as the modern directory.
        if (configured !== path.join(agent, 'memory')) directory = configured;
      }
    }
    return path.join(directory, 'sessions.db');
  }

  public retrieve(task: string, projectRoot: string, options: RetrievalOptions = {}): RetrievalResult {
    const start = performance.now();
    const stats: MemoryRetrievalStats = {
      source: 'hermes-sqlite', status: 'ready', eligible: 0, retrieved: 0, candidates: 0,
      selected: 0, latencyMs: 0, estimatedTokens: 0, queries: 0, budgetLimited: false,
    };
    let db: DatabaseSync | undefined;
    try {
      if (options.signal?.aborted) { stats.status = 'cancelled'; return { memories: [], stats }; }
      const maxCandidates = Math.min(options.maxCandidates ?? 64, 254);
      const maxTokens = Math.min(options.maxTokens ?? 8000, 28000);
      if (maxCandidates <= 0 || maxTokens <= 0) { stats.status = 'disabled'; return { memories: [], stats }; }
      const file = this.databasePath();
      if (!fs.existsSync(file)) { stats.status = 'unavailable'; return { memories: [], stats }; }
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 0; BEGIN');
      // Refuse unknown schemas rather than pretending to support a different memory store.
      const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'").get() as { sql?: string } | undefined;
      if (!fts?.sql || !/fts5/i.test(fts.sql) || !/trigram/i.test(fts.sql)) {
        stats.status = 'unsupported'; return { memories: [], stats };
      }
      const project = resolveGitContext(projectRoot).projectName || 'default';
      const count = db.prepare('SELECT count(*) AS n FROM memories WHERE project IS NULL OR project = ?').get(project) as { n: number };
      stats.eligible = Number(count.n);
      const queries = buildMemoryQueries(task);
      const channels: Row[][] = [];
      for (const channelType of ['guards', 'lessons', 'general']) {
        for (const scope of [project, null]) {
          // Each scope/channel merges all lexical queries before fusion, so a long task
          // cannot gain more candidate quota simply by producing more query fragments.
          const found = new Map<number, Row>();
          const queryResults: Row[][] = [];
          for (const query of queries) {
            if (options.signal?.aborted) { stats.status = 'cancelled'; return { memories: [], stats }; }
            stats.queries++;
            const filter = channelType === 'guards' ? " AND (m.category IN ('correction', 'preference') OR m.target = 'user')"
              : channelType === 'lessons' ? " AND m.target = 'failure'" : '';
            const rows = db.prepare(`SELECT m.id,m.project,m.target,m.category,m.content,m.created,m.last_referenced
              FROM memories m JOIN memory_fts ON memory_fts.rowid=m.id
              WHERE memory_fts MATCH ? AND m.project IS ?${filter}
              ORDER BY bm25(memory_fts), m.last_referenced DESC, m.id ASC LIMIT ?`)
              .all(query, scope, Math.min(maxCandidates, 20)) as unknown as Row[];
            queryResults.push(rows);
          }
          // Reciprocal rank fusion is lexical candidate ordering only, never a claim of
          // semantic applicability or permission to inject without Jev evaluation.
          const scores = new Map<number, number>();
          for (const rows of queryResults) {
            for (const [rank, row] of rows.entries()) {
              if (!found.has(row.id)) found.set(row.id, row);
              scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (60 + rank + 1));
            }
          }
          const leaders = new Map<number, Row>();
          for (const rows of queryResults) if (rows[0]) leaders.set(rows[0].id, rows[0]);
          const rest = [...found.values()].filter(row => !leaders.has(row.id))
            .sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id - b.id);
          // Reserve one leading result per lexical view before fused ranking. This avoids
          // losing a precise identifier-only hit solely because other views lack its wording.
          channels.push([...leaders.values(), ...rest]);
        }
      }
      const bounded = boundMemoryCandidates(channels, maxCandidates, maxTokens);
      Object.assign(stats, { retrieved: bounded.retrieved, candidates: bounded.memories.length,
        budgetLimited: bounded.budgetLimited, estimatedTokens: bounded.estimatedTokens });
      if (!bounded.memories.length) stats.status = 'empty';
      return { memories: bounded.memories, stats };
    } catch {
      stats.status = 'unavailable'; // no credentials, file content or untrusted SQLite error echo
      return { memories: [], stats };
    } finally {
      try { db?.exec('ROLLBACK'); } catch { /* may fail before BEGIN */ }
      try { db?.close(); } catch { /* release even on missing/incompatible schema */ }
      stats.latencyMs = performance.now() - start;
    }
  }
}
