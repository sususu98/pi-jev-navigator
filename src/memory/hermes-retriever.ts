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
export interface RetrievalOptions {
  maxCandidates?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  extraTerms?: string[];
  keywordStats?: {
    terms?: string[];
    latencyMs?: number;
    status?: 'ready' | 'bypassed' | 'timeout' | 'error';
  };
}
export interface RetrievalResult { memories: MemoryGuard[]; stats: MemoryRetrievalStats }
const categories = new Set(['correction', 'preference', 'failure', 'convention', 'tool-quirk', 'insight', 'memory']);

/** Uniform bounded sampling preserves both ends, rather than a permanent prefix quota. */
function spread<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, i) => items[Math.round(i * (items.length - 1) / (limit - 1))]);
}

/** Lexical query construction only: no topic dictionary, synonyms or semantic relevance guesses. */
export function buildMemoryQueries(task: string, extraTerms: string[] = []): string[] {
  const normalized = task.normalize('NFKC');
  const text = normalized.length <= 8192 ? normalized
    : Array.from({ length: 4 }, (_, i) => {
      const start = Math.round(i * (normalized.length - 2048) / 3);
      return normalized.slice(start, start + 2048);
    }).join(' ');
  const atoms = spread([...new Set(text.match(/[\p{L}\p{N}_./-]+/gu) ?? [])]
    .filter(term => [...term].length >= 3), 48);
  const extras = Array.isArray(extraTerms) ? spread([...new Set(extraTerms
    .filter((term): term is string => typeof term === 'string')
    .map(term => term.normalize('NFKC').trim()).filter(term => term.length >= 3 && term.length <= 32))], 6) : [];
  const quote = (term: string) => `"${term.replace(/"/g, '""')}"`;
  const trigrams = (span: string) => {
    const chars = [...span];
    return spread([...new Set(chars.slice(2).map((_, i) => chars.slice(i, i + 3).join('')))], 24);
  };
  const units = [...extras, ...atoms].flatMap(atom => {
    const basename = atom.split('/').filter(Boolean).at(-1) ?? atom;
    return basename === atom ? [atom] : [basename, atom];
  }).map(atom => {
    // Acronym boundaries as well as ordinary camelCase; no language/topic aliases.
    const stem = atom.replace(/\.[\p{Script=Latin}\p{N}]+$/u, '');
    const parts = stem.replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, '$1 $2')
      .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
      .match(/[\p{Script=Latin}\p{N}]+|[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
    const latin = parts.filter(part => /^[\p{Script=Latin}\p{N}]+$/u.test(part) && part.length >= 3);
    const han = parts.filter(part => /^[\p{Script=Han}]+$/u.test(part)).flatMap(trigrams);
    const other = parts.filter(part => !/^[\p{Script=Latin}\p{N}]+$|^[\p{Script=Han}]+$/u.test(part) && [...part].length >= 3);
    const hanQuery = han.map(quote).join(' OR ');
    return { latin, han, other, views: [...new Set([
      hanQuery && latin.length ? `(${hanQuery}) AND (${latin.map(quote).join(' OR ')})` : '',
      ...parts.slice(1).flatMap((part, i) => /^[\p{Script=Latin}\p{N}]+$/u.test(part)
        && /^[\p{Script=Latin}\p{N}]+$/u.test(parts[i]) && `${parts[i]} ${part}`.length >= 3
        ? [quote(`${parts[i]} ${part}`)] : []).reverse(),
      hanQuery, ...latin.map(quote), ...other.map(quote),
      ...(!/^[\p{Script=Han}]+$/u.test(stem) && stem.length <= 128 ? [quote(stem)] : []),
    ].filter(Boolean))] };
  });
  const latin = spread([...new Set(units.flatMap(unit => unit.latin))], 48);
  const han = spread([...new Set(units.flatMap(unit => unit.han))], 96);
  const queries = new Set<string>();
  // Pooled lexical views retain coverage even when precise views exceed the query cap.
  if (latin.length) queries.add(latin.map(quote).join(' OR '));
  if (han.length) queries.add(han.map(quote).join(' OR '));
  const other = spread([...new Set(units.flatMap(unit => unit.other))], 48);
  if (other.length) queries.add(other.map(quote).join(' OR '));
  // Natural-language clauses share the pooled trigram view; only lexical
  // identifiers/filenames get separate views, avoiding repeated boilerplate votes.
  const families = spread(units.filter(unit => (unit.latin.length || unit.other.length) && unit.views.length), 24);
  // One view per lexical unit per pass: a long early path cannot consume all slots.
  for (let rank = 0; rank < Math.max(0, ...families.map(unit => unit.views.length)); rank++) {
    for (const unit of families) if (unit.views[rank]) queries.add(unit.views[rank]);
  }
  return [...queries].slice(0, 32);
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
  // Interleave lexical sources; stable IDs deduplicate complete records.
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
      const keywordQueries = new Set(buildMemoryQueries('', options.extraTerms));
      const baselineQueries = buildMemoryQueries(task);
      const querySet = new Set<string>();
      const expandedQueries = [...keywordQueries];
      for (let i = 0; i < Math.max(baselineQueries.length, expandedQueries.length); i++) {
        if (baselineQueries[i]) querySet.add(baselineQueries[i]);
        if (expandedQueries[i]) querySet.add(expandedQueries[i]);
      }
      const queries = [...querySet].slice(0, 32);
      // Lexical document frequency gives precise views a fair chance before broad
      // boilerplate views. This orders recall only; Jev still decides applicability.
      const frequencies = new Map(queries.map(query => [query, Number((db!.prepare(`
        SELECT count(*) AS n FROM memories m JOIN memory_fts ON memory_fts.rowid=m.id
        WHERE memory_fts MATCH ? AND (m.project IS NULL OR m.project = ?)` )
        .get(query, project) as { n: number }).n)]));
      const fusedRows = new Map<number, Row>();
      const fusedScores = new Map<number, number>();
      const keywordScores = new Map<number, number>();
      const matchedViews = new Map<number, Map<string, number>>();
      const guardIds = new Set<number>();
      for (const query of queries) {
        const evidence = new Map<number, number>();
        for (const channelType of ['guards', 'lessons', 'general']) {
          for (const scope of [project, null]) {
            if (options.signal?.aborted) { stats.status = 'cancelled'; return { memories: [], stats }; }
            stats.queries++;
            const filter = channelType === 'guards' ? " AND (m.category IN ('correction', 'preference') OR m.target = 'user')"
              : channelType === 'lessons' ? " AND m.target = 'failure'" : '';
            const rows = db.prepare(`SELECT m.id,m.project,m.target,m.category,m.content,m.created,m.last_referenced
              FROM memories m JOIN memory_fts ON memory_fts.rowid=m.id
              WHERE memory_fts MATCH ? AND m.project IS ?${filter}
              ORDER BY bm25(memory_fts), m.last_referenced DESC, m.id ASC LIMIT ?`)
              .all(query, scope, Math.min(maxCandidates, 20)) as unknown as Row[];
            // A small fresh lexical view lets later corrections compete with old
            // highly repeated records. Recency is recall diversity, not applicability.
            stats.queries++;
            const recent = db.prepare(`SELECT m.id,m.project,m.target,m.category,m.content,m.created,m.last_referenced
              FROM memories m JOIN memory_fts ON memory_fts.rowid=m.id
              WHERE memory_fts MATCH ? AND m.project IS ?${filter}
              ORDER BY m.created DESC, m.id DESC LIMIT 4`).all(query, scope) as unknown as Row[];
            const views = [rows, recent];
            for (const view of views) view.forEach((row, rank) => {
              fusedRows.set(row.id, row);
              if (channelType !== 'general') guardIds.add(row.id);
              // Overlapping category channels count once per lexical view.
              evidence.set(row.id, Math.max(evidence.get(row.id) ?? 0, 1 / (60 + rank + 1)));
            });
          }
        }
        const weight = 1 / Math.sqrt(Math.max(1, frequencies.get(query)!));
        // Correlated variants of one identifier must not accumulate unrestricted
        // votes. Retain the strongest lexical view; additional hits are not semantics.
        for (const [id, score] of evidence) {
          fusedScores.set(id, Math.max(fusedScores.get(id) ?? 0, weight * score));
          if (keywordQueries.has(query)) keywordScores.set(id, Math.max(keywordScores.get(id) ?? 0, weight * score));
          let views = matchedViews.get(id);
          if (!views) { views = new Map(); matchedViews.set(id, views); }
          views.set(query, weight * score);
        }
      }
      // Prefer lexical evidence per serialized byte under the fixed budget. Whole
      // long records remain eligible; they cannot monopolize recall just because
      // a consolidated entry mentions many unrelated identifiers.
      const costs = new Map([...fusedRows.values()].map(row => [row.id,
        Buffer.byteLength(JSON.stringify(buildMemoryQuestions([memoryFromRow(row)])), 'utf8')]));
      const priority = (row: Row) => fusedScores.get(row.id)! / Math.sqrt(costs.get(row.id)!);
      const priorities = new Map([...fusedRows.values()].map(row => [row.id, priority(row)]));
      const fused = [...fusedRows.values()].sort((a, b) => priorities.get(b.id)! - priorities.get(a.id)! || a.id - b.id);
      // Plan lexical-view coverage before filling remaining slots. Retrieval
      // ordering is not an applicability decision; every submitted record sees Jev.
      const covered = new Set<string>();
      const remaining = new Map(fused.map(row => [row.id, row]));
      const diversified: Row[] = [];
      // Greedy lexical-view coverage prevents many nearly identical boilerplate
      // records from spending the budget before another identifier gets one slot.
      while (remaining.size) {
        let best: Row | undefined;
        let bestScore = 0;
        for (const row of remaining.values()) {
          const benefit = [...matchedViews.get(row.id)!].reduce((sum, [view, score]) =>
            sum + (covered.has(view) ? 0 : score), 0);
          if (!benefit) continue;
          const score = benefit / Math.sqrt(costs.get(row.id)!);
          if (score > bestScore) { best = row; bestScore = score; }
        }
        if (!best) break;
        diversified.push(best); remaining.delete(best.id);
        for (const view of matchedViews.get(best.id)!.keys()) covered.add(view);
      }
      const guards = fused.filter(row => guardIds.has(row.id));
      const keywordRows = fused.filter(row => keywordScores.has(row.id)).sort((a, b) =>
        keywordScores.get(b.id)! / Math.sqrt(costs.get(b.id)!)
        - keywordScores.get(a.id)! / Math.sqrt(costs.get(a.id)!) || a.id - b.id);
      const baselineRows = [...guards.slice(0, 1), ...diversified, ...remaining.values()];
      // Scope diversity remains a recall invariant even when fresh leaders all
      // belong to one scope. Interleave ranked scopes, without semantic filtering.
      const fairScopes = (rows: Row[]) => {
        const projectRows = rows.filter(row => row.project === project);
        const globalRows = rows.filter(row => row.project === null);
        return Array.from({ length: Math.max(projectRows.length, globalRows.length) }, (_, i) =>
          [projectRows[i], globalRows[i]].filter((row): row is Row => !!row)).flat();
      };
      const bounded = boundMemoryCandidates([fairScopes(keywordRows), fairScopes(baselineRows)], maxCandidates, maxTokens);
      Object.assign(stats, { retrieved: bounded.retrieved, candidates: bounded.memories.length,
        candidateIds: bounded.memories.map(memory => memory.id),
        budgetLimited: bounded.budgetLimited, estimatedTokens: bounded.estimatedTokens });
      if (!bounded.memories.length) stats.status = 'empty';
      if (options.keywordStats) {
        stats.keywordTerms = options.keywordStats.terms;
        stats.keywordLatencyMs = options.keywordStats.latencyMs;
        stats.keywordStatus = options.keywordStats.status;
      }
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
