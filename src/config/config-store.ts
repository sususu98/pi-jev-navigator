import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as jsonc from 'jsonc-parser/lib/esm/main.js';
import { JevNavigatorConfig, ExecutionMode } from '../types.js';
import { resolveGitContext } from '../graph/git.js';

export const { applyEdits, modify, parse } = jsonc;
export type ParseError = jsonc.ParseError;

export const DEFAULT_CONFIG: Required<Omit<JevNavigatorConfig, 'apiKey' | 'keyFilePath' | 'endpoint' | 'model' | 'projects'>> & {
  endpoint: string;
  model: string;
  projects?: JevNavigatorConfig['projects'];
} = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  enableTailInjection: true,
  enableSubsystems: true,
  enableSkills: true,
  enableMemories: true,
  enableSystemPromptPruning: false,
  executionMode: 'auto',
  timeoutMs: 1500,
  maxMemoryGuards: 80,
  cacheTtlDays: 7,
  logDecisions: true,
  ignoreDirs: [
    '.git', '.worktrees', 'node_modules', 'vendor', 'dist', 'build', 'test-output', 'tmp', 'temp',
    '.agents', '.pi', '.gitnexus', '.llm-wiki', 'auths', 'logs', 'subagent-artifacts',
    'Library', 'Applications', '.cache', '.cargo', '.rustup', '.npm', '.bun', '.pnpm', '.yarn',
    '.local', '.vscode', '.idea', 'Downloads', 'Movies', 'Music', 'Pictures', 'VirtualBox VMs',
    '.cocoapods', '.gradle', '.m2', '.docker', '.orbstack', '.colima', '.venv', 'venv', 'env',
    'target', 'out', '.next', '.nuxt', 'coverage', '.terraform',
  ],
  maxFilesIndexed: 3000,
  maxScanDepth: 8,
};

const PROTECTED_PROJECT_KEYS = new Set<keyof JevNavigatorConfig>(['endpoint', 'apiKey', 'keyFilePath']);
const CONFIG_KEYS = new Set<keyof JevNavigatorConfig>([
  'apiKey', 'keyFilePath', 'endpoint', 'model', 'enableTailInjection', 'enableSubsystems',
  'enableSkills', 'enableMemories', 'enableSystemPromptPruning', 'executionMode', 'timeoutMs',
  'maxMemoryGuards', 'cacheTtlDays', 'logDecisions', 'ignoreDirs', 'maxFilesIndexed', 'maxScanDepth',
  'projects',
]);
type ConfigKey = keyof JevNavigatorConfig;
type Layer = Partial<JevNavigatorConfig>;

/** Kept for compatibility; parsing itself is delegated to jsonc-parser. */
export function stripJsoncComments(text: string): string {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  return errors.length ? text : JSON.stringify(value);
}

export function parseJsonc<T>(raw: string): T {
  const errors: ParseError[] = [];
  const value = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`JSONC parse error at offset ${errors[0].offset}`);
  return value as T;
}

function validateLayer(value: unknown, label: string, diagnostics: string[]): Layer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(`⚠️ Invalid ${label} config: expected an object.`);
    return {};
  }
  const result: Layer = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!CONFIG_KEYS.has(rawKey as ConfigKey)) {
      diagnostics.push(`⚠️ Ignoring unknown ${label} config key: ${rawKey}.`);
      continue;
    }
    const key = rawKey as ConfigKey;
    const valid = key === 'projects'
      ? (typeof rawValue === 'object' && rawValue !== null)
      : key === 'executionMode'
      ? rawValue === 'auto' || rawValue === 'parallel' || rawValue === 'unified'
      : key === 'apiKey' || key === 'keyFilePath' || key === 'endpoint' || key === 'model'
        ? typeof rawValue === 'string' && rawValue.length > 0
        : ['enableTailInjection', 'enableSubsystems', 'enableSkills', 'enableMemories', 'enableSystemPromptPruning', 'logDecisions'].includes(key)
          ? typeof rawValue === 'boolean'
          : key === 'ignoreDirs'
            ? Array.isArray(rawValue) && rawValue.every((item) => typeof item === 'string')
            : typeof rawValue === 'number' && Number.isFinite(rawValue) &&
              (key === 'timeoutMs' ? Number.isSafeInteger(rawValue) && rawValue > 0
                : key === 'maxMemoryGuards' ? Number.isSafeInteger(rawValue) && rawValue >= 0
                  : rawValue >= 0);
    if (!valid) {
      diagnostics.push(`⚠️ Ignoring invalid ${label} config value for ${key}.`);
      continue;
    }
    result[key] = rawValue as never;
  }
  return result;
}

function parseFile(filePath: string, label: string, diagnostics: string[]): Layer | null {
  try {
    const errors: ParseError[] = [];
    const value = parse(fs.readFileSync(filePath, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`JSONC parse error at offset ${errors[0].offset}`);
    return validateLayer(value, label, diagnostics);
  } catch (err) {
    diagnostics.push(`⚠️ Failed to parse ${label} config [${filePath}]: ${err instanceof Error ? err.message : String(err)}.`);
    return null;
  }
}

export class JevConfigStore {
  private config: JevNavigatorConfig;
  private projectRoot: string;
  private homeDir: string;
  private diagnostics: string[] = [];
  private globalLayer: Layer = {};
  private projectLayer: Layer = {};
  private globalConfigPath: string | null = null;
  private projectConfigPath: string | null = null;
  private explicitKeys = new Set<ConfigKey>();

  constructor(projectRoot: string = process.cwd(), overrides: JevNavigatorConfig = {}, homeDir: string = os.homedir()) {
    this.projectRoot = projectRoot;
    this.homeDir = homeDir;
    this.config = this.loadConfig(overrides);
  }

  public getDiagnostics(): string[] { return [...this.diagnostics]; }

  private candidatePaths(base: string): string[] { return [`${base}.jsonc`, `${base}.json`]; }

  private loadLayer(bases: string | string[], label: string): { layer: Layer; filePath: string | null } {
    const list = Array.isArray(bases) ? bases : [bases];
    for (const base of list) {
      for (const candidate of this.candidatePaths(base)) {
        if (!fs.existsSync(candidate)) continue;
        const parsed = parseFile(candidate, label, this.diagnostics);
        if (parsed) return { layer: parsed, filePath: candidate };
      }
    }
    return { layer: {}, filePath: null };
  }

  private loadConfig(overrides: JevNavigatorConfig): JevNavigatorConfig {
    this.diagnostics = [];
    const globalBases = [
      path.join(this.homeDir, '.pi', 'agent', 'jev-config'),
      path.join(this.homeDir, '.pi', 'jev-config'),
    ];
    const projectBases = [
      path.join(this.projectRoot, '.pi', 'jev-config'),
      path.join(this.projectRoot, '.jev-config'),
      path.join(this.projectRoot, 'jev-config'),
    ];
    const global = this.loadLayer(globalBases, 'global');
    const project = this.loadLayer(projectBases, 'project');
    this.globalLayer = global.layer;
    this.projectLayer = Object.fromEntries(
      Object.entries(project.layer).filter(([key]) => !PROTECTED_PROJECT_KEYS.has(key as ConfigKey)),
    );
    this.globalConfigPath = global.filePath;
    this.projectConfigPath = project.filePath;
    for (const key of Object.keys(project.layer) as ConfigKey[]) {
      if (PROTECTED_PROJECT_KEYS.has(key)) this.diagnostics.push(`⚠️ Ignoring protected project config key: ${key}.`);
    }
    const matchedProjectRule = this.resolveGlobalProjectRule(global.layer.projects);
    const trustedOverrides = validateLayer(overrides, 'constructor', this.diagnostics);
    return {
      ...DEFAULT_CONFIG,
      ...this.globalLayer,
      ...matchedProjectRule,
      ...this.projectLayer,
      ...trustedOverrides,
    };
  }

  private normalizePathCandidate(targetPath: string): string {
    const raw = targetPath.trim();
    const resolved = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
      ? path.resolve(this.homeDir, raw.replace(/^~[/\\]?/, ''))
      : path.resolve(raw);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }

  private resolveGlobalProjectRule(projectsConfig: unknown): Layer {
    if (!projectsConfig || typeof projectsConfig !== 'object') return {};
    const gitCtx = resolveGitContext(this.projectRoot);
    const realOrResolve = (p: string) => {
      try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
    };
    const resolvedProject = realOrResolve(this.projectRoot);
    const resolvedMain = realOrResolve(gitCtx.mainRepoRoot);
    const resolvedWorktree = realOrResolve(gitCtx.worktreeRoot);

    const entries: Array<{ path: string; config: unknown }> = [];
    if (Array.isArray(projectsConfig)) {
      for (const item of projectsConfig) {
        if (item && typeof item === 'object' && typeof (item as any).path === 'string') {
          const { path: p, ...rest } = item as any;
          entries.push({ path: p, config: rest });
        }
      }
    } else {
      for (const [p, cfg] of Object.entries(projectsConfig)) {
        entries.push({ path: p, config: cfg });
      }
    }

    for (const entry of entries) {
      const normalized = this.normalizePathCandidate(entry.path);
      if (
        normalized === resolvedProject ||
        normalized === resolvedMain ||
        normalized === resolvedWorktree
      ) {
        const validated = validateLayer(entry.config, `projects[${entry.path}]`, this.diagnostics);
        return Object.fromEntries(
          Object.entries(validated).filter(([k]) => !PROTECTED_PROJECT_KEYS.has(k as ConfigKey))
        );
      }
    }
    return {};
  }

  public get(): JevNavigatorConfig { return { ...this.config }; }

  public set(updates: Partial<JevNavigatorConfig>): void {
    const valid = validateLayer(updates, 'runtime', this.diagnostics);
    this.config = { ...this.config, ...valid };
    for (const key of Object.keys(valid) as ConfigKey[]) this.explicitKeys.add(key);
  }

  public toggle(feature: 'subsystems' | 'skills' | 'memories' | 'mode'): { key: string; newValue: boolean | string } {
    const mapping = {
      subsystems: 'enableSubsystems', skills: 'enableSkills', memories: 'enableMemories',
    } as const;
    if (feature === 'mode') {
      const modes: ExecutionMode[] = ['auto', 'parallel', 'unified'];
      const nextMode = modes[(modes.indexOf(this.config.executionMode || 'auto') + 1) % modes.length];
      this.set({ executionMode: nextMode });
      return { key: 'executionMode', newValue: nextMode };
    }
    const key = mapping[feature];
    const value = !this.config[key];
    this.set({ [key]: value });
    return { key, newValue: value };
  }

  private writeConfig(baseDir: string, baseName: string, values: Layer, existingPath: string | null, removeProtected: boolean): string {
    fs.mkdirSync(baseDir, { recursive: true });
    const configPath = existingPath || path.join(baseDir, `${baseName}.json`);
    let output: string;
    if (existingPath && fs.existsSync(existingPath)) {
      output = fs.readFileSync(existingPath, 'utf8');
      const formattingOptions = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
      if (removeProtected) {
        for (const key of PROTECTED_PROJECT_KEYS) output = applyEdits(output, modify(output, [key], undefined, formattingOptions));
      }
      for (const [key, value] of Object.entries(values)) {
        output = applyEdits(output, modify(output, [key], value, formattingOptions));
      }
      if (!output.endsWith('\n')) output += '\n';
    } else {
      output = JSON.stringify(values, null, 2) + '\n';
    }
    fs.writeFileSync(configPath, output, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    return configPath;
  }

  public saveProjectConfig(): string {
    const values: Layer = { ...this.projectLayer };
    for (const key of this.explicitKeys) {
      if (!PROTECTED_PROJECT_KEYS.has(key)) (values as Record<string, unknown>)[key] = this.config[key];
    }
    const targetDir = this.projectConfigPath ? path.dirname(this.projectConfigPath) : path.join(this.projectRoot, '.pi');
    const baseName = this.projectConfigPath ? path.basename(this.projectConfigPath).replace(/\.(?:jsonc|json)$/, '') : 'jev-config';
    const result = this.writeConfig(targetDir, baseName, values, this.projectConfigPath, true);
    this.projectConfigPath = result;
    return result;
  }

  public saveGlobalConfig(): string {
    const values: Layer = { ...this.globalLayer };
    for (const key of this.explicitKeys) (values as Record<string, unknown>)[key] = this.config[key];
    const result = this.writeConfig(path.join(this.homeDir, '.pi', 'agent'), 'jev-config', values, this.globalConfigPath, false);
    this.globalConfigPath = result;
    return result;
  }
}
