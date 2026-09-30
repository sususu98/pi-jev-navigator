import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { resolveGitContext } from '../graph/git.js';

export interface MemoryGuard {
  id: string;
  category: 'correction' | 'preference' | 'failure' | 'convention' | 'tool-quirk' | 'insight' | 'memory';
  title: string;
  summary: string;
  rule: string;
  project?: string;
  frequency?: number;
  latestDate?: string;
  score?: number;
}

interface InternalMemoryEntry {
  id: string;
  category: MemoryGuard['category'];
  title: string;
  summary: string;
  rule: string;
  project: string;
  frequency: number;
  latestDate: string;
  score: number;
}

export class MemoryCollector {
  private readonly homeDir: string;
  private memoryCache: { project: string; timestamp: number; guards: MemoryGuard[] } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

  constructor(homeDir: string = os.homedir()) {
    this.homeDir = homeDir;
  }

  /**
   * Pure mechanical normalization of memory title for exact deduplication (No hardcoded keyword heuristics)
   */
  private getDeduplicationKey(category: string, title: string, rule: string, project: string): string {
    return createHash('sha256')
      .update(JSON.stringify([category, title, rule, project]))
      .digest('hex');
  }

  /**
   * Parse a memory markdown block with objective metadata (created, last, project64)
   */
  private parseBlockWithMeta(
    block: string,
    defaultCategory: MemoryGuard['category'] = 'memory'
  ): {
    category: MemoryGuard['category'];
    cleanTitle: string;
    summary: string;
    rule: string;
    project: string;
    lastDate: string;
  } | null {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;

    const firstLine = lines[0];
    const catMatch = firstLine.match(/^\[(correction|preference|failure|tool-quirk|insight|convention)\]/i);
    const category = (catMatch ? catMatch[1].toLowerCase() : defaultCategory) as MemoryGuard['category'];

    const metaMatch = block.match(/<!--([\s\S]*?)-->/);
    let project = 'global';
    let lastDate = '2026-09-01';

    if (metaMatch) {
      const metaStr = metaMatch[1];
      const projMatch = metaStr.match(/project64=([a-zA-Z0-9+=]+)/);
      if (projMatch) {
        try {
          project = Buffer.from(projMatch[1], 'base64').toString('utf-8');
        } catch {
          project = 'global';
        }
      }
      const lastMatch = metaStr.match(/last=([0-9-]+)/);
      if (lastMatch) {
        lastDate = lastMatch[1];
      }
    }

    const cleanTitle = firstLine
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/<!--[\s\S]*?-->/, '')
      .trim();

    if (!cleanTitle) return null;

    const bodyLines = lines.slice(1).map((l) => l.replace(/<!--[\s\S]*?-->/g, '').trim()).filter(Boolean);
    const body = bodyLines.join(' ').replace(/\s+/g, ' ').trim();

    const summary = body ? `${cleanTitle}: ${body}` : cleanTitle;
    const rule = body || cleanTitle;

    return {
      category,
      cleanTitle,
      summary,
      rule,
      project,
      lastDate,
    };
  }

  /**
   * Collect active memory constraints across Hermes memory store and project memory
   * Pure metadata-driven ranking (Recency + Category Hierarchy + Project Scope) with ZERO client-side keyword heuristics.
   */
  public collectMemories(projectRoot: string = process.cwd(), maxTotal: number = Infinity): MemoryGuard[] {
    const gitCtx = resolveGitContext(projectRoot);
    const targetProject = gitCtx.projectName || 'default';

    // Check memory cache
    if (
      this.memoryCache &&
      this.memoryCache.project === targetProject &&
      Date.now() - this.memoryCache.timestamp < this.CACHE_TTL_MS
    ) {
      return this.memoryCache.guards.slice(0, maxTotal);
    }

    const memoryFiles = [
      { path: path.join(this.homeDir, '.pi', 'agent', 'pi-hermes-memory', 'failures.md'), defaultCategory: 'correction' as const },
      { path: path.join(this.homeDir, '.pi', 'agent', 'pi-hermes-memory', 'USER.md'), defaultCategory: 'preference' as const },
      { path: path.join(this.homeDir, '.pi', 'agent', 'projects-memory', targetProject, 'MEMORY.md'), defaultCategory: 'convention' as const },
      { path: path.join(this.homeDir, '.pi', 'agent', 'pi-hermes-memory', 'MEMORY.md'), defaultCategory: 'convention' as const },
    ];

    const entriesMap = new Map<string, InternalMemoryEntry>();

    for (const item of memoryFiles) {
      if (!fs.existsSync(item.path)) continue;
      try {
        const raw = fs.readFileSync(item.path, 'utf-8');
        const rawBlocks = raw.split(/\n§\s*\n?|\n§$/m).map((b) => b.trim()).filter(Boolean);

        for (const block of rawBlocks) {
          const parsed = this.parseBlockWithMeta(block, item.defaultCategory);
          if (!parsed) continue;

          // Project boundary filter: only keep target project and global memories
          if (parsed.project !== 'global' && parsed.project !== targetProject) {
            continue;
          }

          const dedupKey = this.getDeduplicationKey(parsed.category, parsed.cleanTitle, parsed.rule, parsed.project);
          if (!dedupKey) continue;

          const existing = entriesMap.get(dedupKey);

          if (existing) {
            existing.frequency += 1;
            // Upgrade category if this occurrence is higher priority
            if (parsed.category === 'correction' || (parsed.category === 'preference' && existing.category !== 'correction')) {
              existing.category = parsed.category;
            }
            if (parsed.lastDate > existing.latestDate) {
              existing.latestDate = parsed.lastDate;
              existing.summary = parsed.summary;
              existing.rule = parsed.rule;
              existing.title = parsed.cleanTitle;
              existing.project = parsed.project;
            }
          } else {
            entriesMap.set(dedupKey, {
              id: `mem_${dedupKey}`,
              category: parsed.category,
              title: parsed.cleanTitle,
              summary: parsed.summary,
              rule: parsed.rule,
              project: parsed.project,
              frequency: 1,
              latestDate: parsed.lastDate,
              score: 0,
            });
          }
        }
      } catch {
        // Ignore unreadable files
      }
    }

    // Pure objective metadata scoring: Category Hierarchy + Recency Decay + Project Relevance
    const now = Date.now();
    for (const e of entriesMap.values()) {
      let score = 0;

      // 1. Category Baseline Weight
      if (e.category === 'correction') score += 12;
      else if (e.category === 'preference') score += 10;
      else if (e.category === 'failure') score += 7;
      else if (e.category === 'tool-quirk') score += 5;
      else if (e.category === 'convention') score += 4;
      else score += 2;

      // 2. Natural Occurrence Frequency (raw count of duplicate records in memory store)
      score += Math.min(30, (e.frequency - 1) * 3);

      // 3. Project Relevance Bonus
      if (e.project === targetProject) {
        score += 10;
      }

      // 4. Recency Decay (Date arithmetic only)
      if (e.latestDate) {
        const d = new Date(e.latestDate).getTime();
        const daysAgo = Math.max(0, (now - d) / (1000 * 60 * 60 * 24));
        if (daysAgo <= 1) score += 12;
        else if (daysAgo <= 3) score += 8;
        else if (daysAgo <= 7) score += 5;
        else if (daysAgo <= 14) score += 3;
        else if (daysAgo <= 30) score += 1;
      }

      e.score = score;
    }

    const sortedGuards: MemoryGuard[] = Array.from(entriesMap.values())
      .sort((a, b) => b.score - a.score)
      .map((e) => ({
        id: e.id,
        category: e.category,
        title: e.title,
        summary: e.summary,
        rule: e.rule,
        project: e.project,
        frequency: e.frequency,
        latestDate: e.latestDate,
        score: e.score,
      }));

    this.memoryCache = {
      project: targetProject,
      timestamp: Date.now(),
      guards: sortedGuards,
    };

    return sortedGuards.slice(0, maxTotal);
  }

  /**
   * Format memory guards for Jev state string list
   */
  public formatForJev(guards: MemoryGuard[]): string[] {
    return guards.map((g) => {
      const freqSuffix = (g.frequency && g.frequency > 1) ? ` [Freq: ${g.frequency}x]` : '';
      return `[${g.category}] ${g.title}${freqSuffix}: ${g.summary}`;
    });
  }
}
