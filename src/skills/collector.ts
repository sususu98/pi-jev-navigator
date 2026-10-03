import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseYaml } from 'yaml';
import { SkillSummary } from '../types.js';
import { resolveGitContext } from '../graph/git.js';
import { parseJsonc } from '../config/config-store.js';
import { resolveHermesScope } from '../memory/hermes-scope.js';

export class SkillCollector {
  private readonly homeDir: string;

  constructor(homeDir: string = os.homedir()) {
    this.homeDir = homeDir;
  }

  /** Parse only YAML frontmatter; the markdown body is deliberately ignored. */
  private parseSkillFile(filePath: string): SkillSummary | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(/^(?:\uFEFF)?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
      if (!match) return null;
      const frontmatter = parseYaml(match[1]) as Record<string, unknown> | null;
      if (!frontmatter || typeof frontmatter !== 'object') return null;
      if (frontmatter['disable-model-invocation'] === true) return null;

      const name = typeof frontmatter.name === 'string' && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : path.basename(filePath).toLowerCase() === 'skill.md'
          ? path.basename(path.dirname(filePath))
          : path.basename(filePath, path.extname(filePath));
      const description = typeof frontmatter.description === 'string'
        ? frontmatter.description
        : '';
      if (!description) return null;
      return { name, description, path: filePath };
    } catch {
      return null;
    }
  }

  private readSettingsPaths(projectRoot: string, agentRoot: string): string[] {
    const result: string[] = [];
    for (const directory of [agentRoot, path.join(projectRoot, '.pi')]) {
      try {
        const settings = parseJsonc<{ skills?: unknown }>(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'));
        if (!Array.isArray(settings.skills)) continue;
        for (const item of settings.skills) {
          // Pi's canonical catalog handles exclusions/globs/packages in extension mode.
          // Standalone discovery accepts literal extra files/directories only.
          if (typeof item !== 'string' || /^[!-]/.test(item) || /[*?{}]/.test(item)) continue;
          const entry = item.replace(/^\+/, '');
          result.push(entry.startsWith('~/') ? path.join(this.homeDir, entry.slice(2)) : path.resolve(directory, entry));
        }
      } catch { /* optional settings */ }
    }
    return result;
  }

  private collectFromPath(input: string, add: (file: string) => void, visitedDirs: Set<string>, visitedFiles: Set<string>, allowStandalone = true): void {
    let stat: fs.Stats;
    let real: string;
    try {
      real = fs.realpathSync(input);
      stat = fs.statSync(real);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (/\.md$/i.test(real) && !visitedFiles.has(real)) {
        visitedFiles.add(real);
        add(real);
      }
      return;
    }
    if (!stat.isDirectory() || visitedDirs.has(real)) return;
    visitedDirs.add(real);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(real, { withFileTypes: true }); } catch { return; }
    const skillFile = entries.find((entry) => entry.name === 'SKILL.md')
      ?? entries.find((entry) => entry.name.toLowerCase() === 'skill.md');
    if (skillFile) {
      this.collectFromPath(path.join(real, skillFile.name), add, visitedDirs, visitedFiles, false);
      return; // A skill's references/scripts are not additional skills.
    }
    for (const entry of entries) {
      const child = path.join(real, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        this.collectFromPath(child, add, visitedDirs, visitedFiles, false);
      } else if (allowStandalone && entry.isFile() && /\.md$/i.test(entry.name)) {
        this.collectFromPath(child, add, visitedDirs, visitedFiles, false);
      }
    }
  }

  public collectSkills(projectRoot: string, additionalPaths: string[] = []): SkillSummary[] {
    const gitCtx = resolveGitContext(projectRoot);
    const hermes = resolveHermesScope(projectRoot, this.homeDir);
    const searchDirs = [
      path.join(gitCtx.worktreeRoot, '.agents', 'skills'),
      path.join(gitCtx.worktreeRoot, '.pi', 'skills'),
      ...(gitCtx.isWorktree ? [path.join(gitCtx.mainRepoRoot, '.agents', 'skills'), path.join(gitCtx.mainRepoRoot, '.pi', 'skills')] : []),
      path.join(this.homeDir, '.agents', 'skills'),
      path.join(hermes.agentRoot, 'skills'),
      ...(hermes.project ? [path.join(hermes.projectsRoot, hermes.project, 'skills')] : []),
      path.join(hermes.memoryDir, 'skills'),
      ...this.readSettingsPaths(projectRoot, hermes.agentRoot),
      ...additionalPaths.map((p) => p.startsWith('~/') ? path.join(this.homeDir, p.slice(2)) : path.resolve(projectRoot, p)),
    ];
    return this.collectPaths(searchDirs);
  }

  /** Learned Hermes SOPs supplement, but never override, Pi's canonical catalog. */
  public collectLearnedSkills(projectRoot: string): SkillSummary[] {
    const hermes = resolveHermesScope(projectRoot, this.homeDir);
    return this.collectPaths([
      path.join(hermes.memoryDir, 'skills'),
      ...(hermes.project ? [path.join(hermes.projectsRoot, hermes.project, 'skills')] : []),
    ]);
  }

  private collectPaths(searchDirs: string[]): SkillSummary[] {
    const skills = new Map<string, SkillSummary>();
    const visitedDirs = new Set<string>();
    const visitedFiles = new Set<string>();
    const add = (file: string) => {
      const summary = this.parseSkillFile(file);
      if (summary && !skills.has(summary.name)) skills.set(summary.name, summary);
    };
    for (const dir of searchDirs) this.collectFromPath(dir, add, visitedDirs, visitedFiles);
    return [...skills.values()];
  }

  public formatForJev(skills: SkillSummary[]): string[] {
    return skills.map((s) => `${s.name}: ${s.description}`);
  }
}
