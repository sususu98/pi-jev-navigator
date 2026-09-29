import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

interface InternalMemoryCluster {
  canonicalId: string;
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
  private memoryCache: { project: string; timestamp: number; guards: MemoryGuard[] } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

  /**
   * Normalize title into a semantic cluster key to aggregate repeated corrections
   */
  private normalizeClusterKey(title: string): string {
    const lower = title.toLowerCase();

    // Specific high-frequency operational patterns
    if (lower.includes('worktree') || lower.includes('工作树') || lower.includes('分支聚焦')) {
      return 'cluster_git_worktree_boundary';
    }
    if (lower.includes('grep') || lower.includes('find') || lower.includes('ripgrep') || lower.includes('fd')) {
      return 'cluster_cli_grep_fd_rg';
    }
    if (lower.includes('敏感词') || lower.includes('config.yaml') || lower.includes('查看配置') || lower.includes('配置文件')) {
      return 'cluster_config_direct_read';
    }
    if (lower.includes('8317') || lower.includes('local cpa') || lower.includes('local-cpa')) {
      return 'cluster_local_cpa_service';
    }
    if (lower.includes('sleep') || lower.includes('轮询') || lower.includes('等待 ci')) {
      return 'cluster_no_sleep_polling';
    }
    if (lower.includes('management') || lower.includes('/v0/management') || lower.includes('v8')) {
      return 'cluster_cpa_management_v8';
    }

    // Default normalized stem
    const clean = lower
      .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
      .slice(0, 16);

    return clean || 'cluster_general';
  }

  /**
   * Parse a memory markdown block with metadata (created, last, project64)
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

    const summary = (body ? `${cleanTitle}: ${body}` : cleanTitle).slice(0, 140);
    const rule = (body || cleanTitle).slice(0, 300);

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
   * Collect active memory constraints dynamically ranked by Frequency, Recency, and Project Relevance
   */
  public collectMemories(projectRoot: string = process.cwd(), maxTotal: number = 50): MemoryGuard[] {
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

    const homeDir = os.homedir();
    const memoryFiles = [
      { path: path.join(homeDir, '.pi', 'agent', 'pi-hermes-memory', 'failures.md'), defaultCategory: 'correction' as const },
      { path: path.join(homeDir, '.pi', 'agent', 'pi-hermes-memory', 'USER.md'), defaultCategory: 'preference' as const },
      { path: path.join(homeDir, '.pi', 'agent', 'projects-memory', targetProject, 'MEMORY.md'), defaultCategory: 'convention' as const },
      { path: path.join(homeDir, '.pi', 'agent', 'pi-hermes-memory', 'MEMORY.md'), defaultCategory: 'convention' as const },
    ];

    const clusters = new Map<string, InternalMemoryCluster>();

    for (const item of memoryFiles) {
      if (!fs.existsSync(item.path)) continue;
      try {
        const raw = fs.readFileSync(item.path, 'utf-8');
        const rawBlocks = raw.split(/\n§\s*\n?|\n§$/m).map((b) => b.trim()).filter(Boolean);

        for (const block of rawBlocks) {
          const parsed = this.parseBlockWithMeta(block, item.defaultCategory);
          if (!parsed) continue;

          // Filter out explicitly mismatched other projects
          if (parsed.project !== 'global' && parsed.project !== targetProject && targetProject !== 'default') {
            continue;
          }

          const clusterKey = this.normalizeClusterKey(parsed.cleanTitle);
          const existing = clusters.get(clusterKey);

          if (existing) {
            existing.frequency += 1;
            // Upgrade category if this occurrence is a higher priority [correction] / [preference]
            if (parsed.category === 'correction' || (parsed.category === 'preference' && existing.category !== 'correction')) {
              existing.category = parsed.category;
            }
            if (parsed.lastDate > existing.latestDate) {
              existing.latestDate = parsed.lastDate;
              existing.summary = parsed.summary;
              existing.rule = parsed.rule;
              existing.title = parsed.cleanTitle.slice(0, 60);
              existing.project = parsed.project;
            }
          } else {
            const slugBase = parsed.cleanTitle
              .slice(0, 24)
              .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')
              .replace(/_+/g, '_')
              .replace(/^_|_$/g, '');

            clusters.set(clusterKey, {
              canonicalId: `mem_${slugBase || clusterKey.slice(0, 20)}`,
              category: parsed.category,
              title: parsed.cleanTitle.slice(0, 60),
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

    // Dynamic Multi-Dimensional Frequency & Recency Scoring
    const now = Date.now();
    for (const c of clusters.values()) {
      let score = 0;

      // 1. Category Baseline Weight
      if (c.category === 'correction') score += 12;
      else if (c.category === 'preference') score += 10;
      else if (c.category === 'failure') score += 7;
      else if (c.category === 'tool-quirk') score += 5;
      else if (c.category === 'convention') score += 4;
      else score += 2;

      // 2. Frequency Weight: each repeated correction / occurrence significantly boosts priority
      score += Math.min(36, (c.frequency - 1) * 4);

      // 3. Project Relevance Bonus
      if (c.project === targetProject) {
        score += 10;
      }

      // 4. Recency Decay Bonus
      if (c.latestDate) {
        const d = new Date(c.latestDate).getTime();
        const daysAgo = Math.max(0, (now - d) / (1000 * 60 * 60 * 24));
        if (daysAgo <= 1) score += 12;
        else if (daysAgo <= 3) score += 8;
        else if (daysAgo <= 7) score += 5;
        else if (daysAgo <= 14) score += 3;
        else if (daysAgo <= 30) score += 1;
      }

      c.score = score;
    }

    const sortedGuards: MemoryGuard[] = Array.from(clusters.values())
      .sort((a, b) => b.score - a.score)
      .map((c) => ({
        id: c.canonicalId,
        category: c.category,
        title: c.title,
        summary: c.summary,
        rule: c.rule,
        project: c.project,
        frequency: c.frequency,
        latestDate: c.latestDate,
        score: c.score,
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
