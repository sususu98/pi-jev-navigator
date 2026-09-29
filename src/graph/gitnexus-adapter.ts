import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitNexusStatus {
  isIndexed: boolean;
  repoPath: string;
  commitSha?: string;
  totalFiles?: number;
  runner: 'native' | 'bunx' | 'npx' | 'unavailable';
}

export class GitNexusAdapter {
  /**
   * Check if GitNexus is indexed for the given repository
   */
  public checkStatus(projectRoot: string): GitNexusStatus {
    const gitnexusDir = path.join(projectRoot, '.gitnexus');
    const isIndexed = fs.existsSync(gitnexusDir) && fs.existsSync(path.join(gitnexusDir, 'meta.json'));
    const runner = this.resolveRunner();

    let commitSha: string | undefined;
    if (isIndexed) {
      try {
        const metaRaw = fs.readFileSync(path.join(gitnexusDir, 'meta.json'), 'utf-8');
        const meta = JSON.parse(metaRaw);
        commitSha = meta.commitSha || meta.indexedCommit;
      } catch {
        // Ignore
      }
    }

    return {
      isIndexed,
      repoPath: projectRoot,
      commitSha,
      runner: runner ? runner.type : 'unavailable',
    };
  }

  /**
   * Trigger GitNexus indexing using the best available runner (native -> bunx -> npx)
   */
  public analyze(projectRoot: string): boolean {
    const runner = this.resolveRunner();
    if (!runner) return false;

    try {
      const args = [...runner.baseArgs, 'analyze', '--index-only', '.'];
      const res = spawnSync(runner.bin, args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 120000,
      });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Query 360-degree context for a specific symbol from GitNexus
   */
  public queryContext(symbolName: string, projectRoot: string): string | null {
    const runner = this.resolveRunner();
    if (!runner) return null;

    try {
      const args = [...runner.baseArgs, 'context', symbolName];
      const res = spawnSync(runner.bin, args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });
      if (res.status === 0) {
        return res.stdout.trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Query blast radius / impact for a symbol from GitNexus
   */
  public queryImpact(symbolName: string, projectRoot: string): string | null {
    const runner = this.resolveRunner();
    if (!runner) return null;

    try {
      const args = [...runner.baseArgs, 'impact', symbolName];
      const res = spawnSync(runner.bin, args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });
      if (res.status === 0) {
        return res.stdout.trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the fastest available runner in order:
   * 1. Global binary `gitnexus` (Direct native execution, ~5ms)
   * 2. `bunx gitnexus` (Fast cache execution, ~100ms)
   * 3. `npx gitnexus` (Standard npm fallback)
   */
  public resolveRunner(): { bin: string; baseArgs: string[]; type: 'native' | 'bunx' | 'npx' } | null {
    try {
      execSync('which gitnexus', { stdio: 'ignore' });
      return { bin: 'gitnexus', baseArgs: [], type: 'native' };
    } catch {
      // Continue
    }

    try {
      execSync('which bunx', { stdio: 'ignore' });
      return { bin: 'bunx', baseArgs: ['gitnexus'], type: 'bunx' };
    } catch {
      // Continue
    }

    try {
      execSync('which npx', { stdio: 'ignore' });
      return { bin: 'npx', baseArgs: ['gitnexus'], type: 'npx' };
    } catch {
      // Unavailable
    }

    return null;
  }
}
