import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitNexusStatus {
  isIndexed: boolean;
  repoPath: string;
  commitSha?: string;
  totalFiles?: number;
}

export class GitNexusAdapter {
  /**
   * Check if GitNexus is indexed for the given repository
   */
  public checkStatus(projectRoot: string): GitNexusStatus {
    const gitnexusDir = path.join(projectRoot, '.gitnexus');
    const isIndexed = fs.existsSync(gitnexusDir) && fs.existsSync(path.join(gitnexusDir, 'meta.json'));

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
    };
  }

  /**
   * Trigger GitNexus indexing using bunx or npx
   */
  public analyze(projectRoot: string): boolean {
    try {
      const runner = this.resolveRunner();
      const res = spawnSync(runner, ['gitnexus', 'analyze', '--index-only', '.'], {
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
    try {
      const runner = this.resolveRunner();
      const res = spawnSync(runner, ['gitnexus', 'context', symbolName], {
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
    try {
      const runner = this.resolveRunner();
      const res = spawnSync(runner, ['gitnexus', 'impact', symbolName], {
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

  private resolveRunner(): string {
    try {
      execSync('which bunx', { stdio: 'ignore' });
      return 'bunx';
    } catch {
      return 'npx';
    }
  }
}
