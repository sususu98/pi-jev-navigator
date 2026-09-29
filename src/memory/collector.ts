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
}

export class MemoryCollector {
  /**
   * Parse a memory markdown block into a structured MemoryGuard
   */
  private parseBlock(block: string, defaultCategory: MemoryGuard['category'] = 'memory', index: number = 0): MemoryGuard | null {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;

    const firstLine = lines[0];
    const catMatch = firstLine.match(/^\[(correction|preference|failure|tool-quirk|insight|convention)\]/i);
    const category = (catMatch ? catMatch[1].toLowerCase() : defaultCategory) as MemoryGuard['category'];

    const cleanTitle = firstLine
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/<!--[\s\S]*?-->/, '')
      .trim();

    if (!cleanTitle) return null;

    const bodyLines = lines.slice(1).map((l) => l.replace(/<!--[\s\S]*?-->/g, '').trim()).filter(Boolean);
    const body = bodyLines.join(' ').replace(/\s+/g, ' ').trim();

    // Create a concise rule text (<= 140 chars)
    const summary = (body ? `${cleanTitle}: ${body}` : cleanTitle).slice(0, 140);
    const rule = (body || cleanTitle).slice(0, 300);

    // Slug identifier
    const slugBase = cleanTitle
      .slice(0, 24)
      .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');

    const id = `mem_${slugBase || index}`;

    return {
      id,
      category,
      title: cleanTitle.slice(0, 60),
      summary,
      rule,
    };
  }

  /**
   * Collect active memory constraints across Hermes memory store and project memory (Max 50 high-signal entries, ~2.5k tokens to stay safely within 32K Jev window)
   */
  public collectMemories(projectRoot: string = process.cwd(), maxTotal: number = 50): MemoryGuard[] {
    const guardsMap = new Map<string, MemoryGuard>();
    const homeDir = os.homedir();
    const gitCtx = resolveGitContext(projectRoot);

    const memoryFiles = [
      { path: path.join(homeDir, '.pi', 'agent', 'pi-hermes-memory', 'failures.md'), defaultCategory: 'correction' as const, maxBlocks: 30 },
      { path: path.join(homeDir, '.pi', 'agent', 'pi-hermes-memory', 'USER.md'), defaultCategory: 'preference' as const, maxBlocks: 20 },
      { path: path.join(homeDir, '.pi', 'agent', 'projects-memory', gitCtx.projectName, 'MEMORY.md'), defaultCategory: 'convention' as const, maxBlocks: 15 },
      { path: path.join(homeDir, '.pi', 'agent', 'pi-hermes-memory', 'MEMORY.md'), defaultCategory: 'convention' as const, maxBlocks: 15 },
    ];

    let counter = 0;
    for (const item of memoryFiles) {
      if (!fs.existsSync(item.path)) continue;
      if (guardsMap.size >= maxTotal) break;
      try {
        const raw = fs.readFileSync(item.path, 'utf-8');
        const rawBlocks = raw.split(/\n§\s*\n?|\n§$/m).map((b) => b.trim()).filter(Boolean);
        const blocks = item.maxBlocks ? rawBlocks.slice(0, item.maxBlocks) : rawBlocks;

        for (const block of blocks) {
          if (guardsMap.size >= maxTotal) break;
          const guard = this.parseBlock(block, item.defaultCategory, counter++);
          if (guard && !guardsMap.has(guard.id)) {
            guardsMap.set(guard.id, guard);
          }
        }
      } catch {
        // Ignore unreadable files
      }
    }

    return Array.from(guardsMap.values()).slice(0, maxTotal);
  }

  /**
   * Format memory guards for Jev state string list
   */
  public formatForJev(guards: MemoryGuard[]): string[] {
    return guards.map((g) => `[${g.category}] ${g.title}: ${g.summary}`);
  }
}
