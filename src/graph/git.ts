import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitContext {
  worktreeRoot: string;
  mainRepoRoot: string;
  projectName: string;
  isWorktree: boolean;
  branch?: string;
}

/**
 * Resolve Git repository context including Worktrees and canonical project root
 */
export function resolveGitContext(targetPath: string = process.cwd()): GitContext {
  try {
    const worktreeRoot = execSync('git rev-parse --show-toplevel', {
      cwd: targetPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const gitCommonDirRaw = execSync('git rev-parse --git-common-dir', {
      cwd: targetPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // git prints relative paths relative to the command's cwd, not the
    // worktree root (important when targetPath is a subdirectory).
    const gitCommonDirPath = path.isAbsolute(gitCommonDirRaw)
      ? gitCommonDirRaw
      : path.resolve(targetPath, gitCommonDirRaw);
    const gitCommonDir = fs.realpathSync(gitCommonDirPath);

    // main repo root is parent of .git common directory
    const mainRepoRoot = path.dirname(gitCommonDir);
    const projectName = path.basename(mainRepoRoot);
    const isWorktree = path.resolve(worktreeRoot) !== path.resolve(mainRepoRoot);

    let branch: string | undefined;
    try {
      branch = execSync('git branch --show-current', {
        cwd: targetPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Ignore
    }

    return {
      worktreeRoot,
      mainRepoRoot,
      projectName,
      isWorktree,
      branch: branch || undefined,
    };
  } catch {
    const resolved = path.resolve(targetPath);
    return {
      worktreeRoot: resolved,
      mainRepoRoot: resolved,
      projectName: path.basename(resolved),
      isWorktree: false,
    };
  }
}
