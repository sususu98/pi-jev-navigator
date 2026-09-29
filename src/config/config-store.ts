import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { JevNavigatorConfig, ExecutionMode } from '../types.js';

export const DEFAULT_CONFIG: Required<Omit<JevNavigatorConfig, 'apiKey' | 'keyFilePath' | 'endpoint' | 'model'>> & {
  endpoint: string;
  model: string;
} = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  enableTailInjection: true,
  enableSubsystems: true,
  enableSkills: true,
  enableMemories: true,
  enableSystemPromptPruning: true,
  executionMode: 'auto',
  timeoutMs: 1500,
  maxMemoryGuards: 80,
  cacheTtlDays: 7,
  logDecisions: true,
};

/**
 * Strip single-line and multi-line comments and trailing commas from JSONC string
 */
export function stripJsoncComments(text: string): string {
  let out = '';
  let inString = false;
  let inSingleComment = false;
  let inMultiComment = false;
  let stringQuote = '';
  let isEscaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inSingleComment) {
      if (ch === '\n' || ch === '\r') {
        inSingleComment = false;
        out += ch;
      }
      continue;
    }

    if (inMultiComment) {
      if (ch === '*' && next === '/') {
        inMultiComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === '\\') {
        isEscaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inSingleComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inMultiComment = true;
      i++;
      continue;
    }

    out += ch;
  }

  return out.replace(/,\s*([\]}])/g, '$1');
}

export function parseJsonc<T>(raw: string): T {
  return JSON.parse(stripJsoncComments(raw));
}

export class JevConfigStore {
  private config: JevNavigatorConfig;
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd(), overrides: JevNavigatorConfig = {}) {
    this.projectRoot = projectRoot;
    this.config = this.loadConfig(overrides);
  }

  /**
   * Resolve a JSON or JSONC config file path
   */
  private resolveConfigFile(basePathWithoutExt: string): string | null {
    const jsoncPath = `${basePathWithoutExt}.jsonc`;
    if (fs.existsSync(jsoncPath)) return jsoncPath;
    const jsonPath = `${basePathWithoutExt}.json`;
    if (fs.existsSync(jsonPath)) return jsonPath;
    return null;
  }

  /**
   * Load and merge configurations: Default -> Global (~/.pi/agent/jev-config.json[c]) -> Project (.pi/jev-config.json[c]) -> Overrides
   */
  private loadConfig(overrides: JevNavigatorConfig): JevNavigatorConfig {
    const homeDir = os.homedir();
    const globalConfigPath = this.resolveConfigFile(path.join(homeDir, '.pi', 'agent', 'jev-config'));
    const projectConfigPath = this.resolveConfigFile(path.join(this.projectRoot, '.pi', 'jev-config'));

    let globalConfig: Partial<JevNavigatorConfig> = {};
    if (globalConfigPath && fs.existsSync(globalConfigPath)) {
      try {
        globalConfig = parseJsonc<Partial<JevNavigatorConfig>>(fs.readFileSync(globalConfigPath, 'utf-8'));
      } catch {
        // Ignore malformed global config
      }
    }

    let projectConfig: Partial<JevNavigatorConfig> = {};
    if (projectConfigPath && fs.existsSync(projectConfigPath)) {
      try {
        projectConfig = parseJsonc<Partial<JevNavigatorConfig>>(fs.readFileSync(projectConfigPath, 'utf-8'));
      } catch {
        // Ignore malformed project config
      }
    }

    return {
      ...DEFAULT_CONFIG,
      ...globalConfig,
      ...projectConfig,
      ...overrides,
    };
  }

  public get(): JevNavigatorConfig {
    return { ...this.config };
  }

  public set(updates: Partial<JevNavigatorConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Toggle a boolean feature flag or cycle execution mode
   */
  public toggle(feature: 'subsystems' | 'skills' | 'memories' | 'pruning' | 'mode'): {
    key: string;
    newValue: boolean | string;
  } {
    switch (feature) {
      case 'subsystems': {
        const val = !this.config.enableSubsystems;
        this.config.enableSubsystems = val;
        return { key: 'enableSubsystems', newValue: val };
      }
      case 'skills': {
        const val = !this.config.enableSkills;
        this.config.enableSkills = val;
        return { key: 'enableSkills', newValue: val };
      }
      case 'memories': {
        const val = !this.config.enableMemories;
        this.config.enableMemories = val;
        return { key: 'enableMemories', newValue: val };
      }
      case 'pruning': {
        const val = !this.config.enableSystemPromptPruning;
        this.config.enableSystemPromptPruning = val;
        return { key: 'enableSystemPromptPruning', newValue: val };
      }
      case 'mode': {
        const modes: ExecutionMode[] = ['auto', 'parallel', 'unified'];
        const currentIdx = modes.indexOf(this.config.executionMode || 'auto');
        const nextMode = modes[(currentIdx + 1) % modes.length];
        this.config.executionMode = nextMode;
        return { key: 'executionMode', newValue: nextMode };
      }
    }
  }

  /**
   * Save current configuration to project .pi/jev-config.json
   */
  public saveProjectConfig(): string {
    const piDir = path.join(this.projectRoot, '.pi');
    if (!fs.existsSync(piDir)) {
      fs.mkdirSync(piDir, { recursive: true });
    }
    const configPath = path.join(piDir, 'jev-config.json');
    fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    return configPath;
  }

  /**
   * Save current configuration to global ~/.pi/agent/jev-config.json
   */
  public saveGlobalConfig(): string {
    const homeDir = os.homedir();
    const agentDir = path.join(homeDir, '.pi', 'agent');
    if (!fs.existsSync(agentDir)) {
      fs.mkdirSync(agentDir, { recursive: true });
    }
    const configPath = path.join(agentDir, 'jev-config.json');
    fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    return configPath;
  }
}
