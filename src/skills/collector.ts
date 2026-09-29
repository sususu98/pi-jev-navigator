import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillSummary } from '../types.js';
import { resolveGitContext } from '../graph/git.js';

export class SkillCollector {
  /**
   * Extract skill metadata from a SKILL.md file
   */
  private parseSkillFile(filePath: string): SkillSummary | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const dirName = path.basename(path.dirname(filePath));

      let name = dirName;
      let description = '';

      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('name:')) {
          name = trimmed.replace('name:', '').trim().replace(/^["']|["']$/g, '');
        } else if (trimmed.startsWith('description:')) {
          description = trimmed.replace('description:', '').trim().replace(/^["']|["']$/g, '');
        }
      }

      if (!description) {
        // Fallback to first non-header line
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
            description = trimmed.slice(0, 100);
            break;
          }
        }
      }

      return {
        name,
        description: description.slice(0, 100),
        path: filePath,
      };
    } catch {
      return null;
    }
  }

  /**
   * Collect all available project and global skills with full Git Worktree support
   */
  public collectSkills(projectRoot: string): SkillSummary[] {
    const skillsMap = new Map<string, SkillSummary>();
    const homeDir = os.homedir();
    const gitCtx = resolveGitContext(projectRoot);

    const searchDirs = [
      path.join(gitCtx.worktreeRoot, '.agents', 'skills'),
      path.join(gitCtx.worktreeRoot, '.pi', 'skills'),
      ...(gitCtx.isWorktree
        ? [
            path.join(gitCtx.mainRepoRoot, '.agents', 'skills'),
            path.join(gitCtx.mainRepoRoot, '.pi', 'skills'),
          ]
        : []),
      path.join(homeDir, '.agents', 'skills'),
      path.join(homeDir, '.pi', 'agent', 'skills'),
      path.join(homeDir, '.pi', 'agent', 'projects-memory', gitCtx.projectName, 'skills'),
      path.join(homeDir, '.pi', 'agent', 'projects-memory', path.basename(projectRoot), 'skills'),
      path.join(homeDir, '.pi', 'agent', 'pi-hermes-memory', 'skills'),
    ];

    for (const baseDir of searchDirs) {
      if (!fs.existsSync(baseDir)) continue;
      try {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillPath = path.join(baseDir, entry.name, 'SKILL.md');
            const skillLowerPath = path.join(baseDir, entry.name, 'skill.md');
            const targetFile = fs.existsSync(skillPath)
              ? skillPath
              : fs.existsSync(skillLowerPath)
                ? skillLowerPath
                : null;

            if (targetFile) {
              const summary = this.parseSkillFile(targetFile);
              if (summary && !skillsMap.has(summary.name)) {
                skillsMap.set(summary.name, summary);
              }
            }
          }
        }
      } catch {
        // Ignore unreadable dirs
      }
    }

    return Array.from(skillsMap.values());
  }

  /**
   * Format skills list into compact strings for Jev state
   */
  public formatForJev(skills: SkillSummary[]): string[] {
    return skills.map((s) => `${s.name}: ${s.description}`);
  }
}
