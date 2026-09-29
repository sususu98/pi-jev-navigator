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

export class JevConfigStore {
  private config: JevNavigatorConfig;
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd(), overrides: JevNavigatorConfig = {}) {
    this.projectRoot = projectRoot;
    this.config = this.loadConfig(overrides);
  }

  /**
   * Load and merge configurations: Default -> Global (~/.pi/agent/jev-config.json) -> Project (.pi/jev-config.json) -> Overrides
   */
  private loadConfig(overrides: JevNavigatorConfig): JevNavigatorConfig {
    const homeDir = os.homedir();
    const globalConfigPath = path.join(homeDir, '.pi', 'agent', 'jev-config.json');
    const projectConfigPath = path.join(this.projectRoot, '.pi', 'jev-config.json');

    let globalConfig: Partial<JevNavigatorConfig> = {};
    if (fs.existsSync(globalConfigPath)) {
      try {
        globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
      } catch {
        // Ignore malformed global config
      }
    }

    let projectConfig: Partial<JevNavigatorConfig> = {};
    if (fs.existsSync(projectConfigPath)) {
      try {
        projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
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
