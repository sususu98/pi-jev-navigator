import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const HERMES_MEMORY_TARGETS = ['memory', 'user', 'failure', 'project'] as const;
export type HermesMemoryTarget = typeof HERMES_MEMORY_TARGETS[number];
export interface HermesScope { agentRoot: string; memoryDir: string; projectsRoot: string; project: string | null }
export interface HermesRecallRange { project: string | null; scopes: Array<'global' | 'current-project'>; targets: readonly HermesMemoryTarget[] }

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  return /^~[\/\\]/.test(value) ? path.join(homeDir, value.slice(2)) : value;
}

/** Resolve the same documented .git/commondir layouts as Hermes project detection. */
function repositoryRoot(cwd: string): string | null {
  for (let current = cwd; ; current = path.dirname(current)) {
    const dotGit = path.join(current, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return current;
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!pointer) return current;
        const gitDir = path.resolve(current, pointer[1].trim());
        let common: string | undefined;
        try {
          const value = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
          if (value) common = path.resolve(gitDir, value);
        } catch { /* a separate git dir is not a linked worktree */ }
        const parent = path.dirname(gitDir);
        if (!common && path.basename(parent) === 'worktrees') common = path.dirname(parent);
        return common ? (path.basename(common) === '.git' ? path.dirname(common) : common) : current;
      }
    } catch { /* no readable git metadata at this level */ }
    if (path.dirname(current) === current) return null;
  }
}

/** Align Hermes public storage configuration and project identity, without importing
 * its private modules or allowing a model/project config to choose arbitrary scopes. */
export function resolveHermesScope(projectRoot: string, homeDir = os.homedir()): HermesScope {
  const configuredAgent = homeDir === os.homedir() ? process.env.PI_CODING_AGENT_DIR?.trim() : undefined;
  const agentRoot = configuredAgent ? path.resolve(expandHome(configuredAgent, homeDir)) : path.join(homeDir, '.pi', 'agent');
  let memoryDir = path.join(agentRoot, 'pi-hermes-memory');
  let projectsRoot = path.join(agentRoot, 'projects-memory');
  const file = path.join(agentRoot, 'hermes-memory-config.json');
  try {
    // Hermes uses strict JSON and returns defaults on read/parse failure.
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Hermes configuration');
    if (typeof config.memoryDir === 'string' && config.memoryDir.trim()) {
      const value = expandHome(config.memoryDir.trim(), homeDir);
      const configured = path.resolve(agentRoot, value);
      if (configured !== path.join(agentRoot, 'memory')) memoryDir = configured;
    }
    if (typeof config.projectsMemoryDir === 'string' && config.projectsMemoryDir.trim()) {
      const value = expandHome(config.projectsMemoryDir.trim(), homeDir);
      const relative = path.relative(agentRoot, path.resolve(agentRoot, value));
      // Hermes allows one directory immediately under the agent root.
      if (relative && relative !== '.' && relative !== '..' && !relative.includes(path.sep)
        && !relative.includes('\\') && !path.isAbsolute(relative)) projectsRoot = path.join(agentRoot, relative);
    }
  } catch { /* mirror Hermes defaults; do not disable unrelated routing */ }
  const cwd = path.resolve(projectRoot);
  if (cwd === path.resolve(homeDir) || cwd === path.parse(cwd).root) return { agentRoot, memoryDir, projectsRoot, project: null };
  const repoRoot = repositoryRoot(cwd);
  const cwdName = path.basename(cwd);
  let project = repoRoot && repoRoot !== path.resolve(homeDir) ? path.basename(repoRoot) : cwdName;
  // Match Hermes' migration bridge: canonical store wins when present; a legacy
  // cwd-named store is used only if no canonical store exists. Never union siblings.
  if (cwdName !== project && !fs.existsSync(path.join(projectsRoot, project))
    && fs.existsSync(path.join(projectsRoot, cwdName))) project = cwdName;
  return { agentRoot, memoryDir, projectsRoot, project: project || null };
}

export function hermesRecallRange(scope: HermesScope): HermesRecallRange {
  return { project: scope.project, scopes: scope.project ? ['global', 'current-project'] : ['global'], targets: HERMES_MEMORY_TARGETS };
}
