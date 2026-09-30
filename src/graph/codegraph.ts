import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraphExportOptions } from '../types.js';

/**
 * Safeguard: check whether the target path is the user home directory or a system root
 */
export function isSystemRootOrHome(targetPath: string, homeDir: string = os.homedir()): boolean {
  const resolved = path.resolve(targetPath);
  const home = path.resolve(homeDir);
  const root = path.resolve('/');
  const homeParent = path.dirname(home);
  return (
    resolved === home ||
    resolved === root ||
    resolved === homeParent ||
    resolved === '/Users' ||
    resolved === '/home' ||
    resolved === '/root' ||
    path.dirname(resolved) === resolved
  );
}

export class CodeGraphExtractor {
  private defaultIgnoreDirs = new Set([
    '.git',
    'node_modules',
    'vendor',
    'dist',
    'build',
    'test-output',
    'tmp',
    'temp',
    '.agents',
    '.pi',
    '.gitnexus',
    '.worktrees',
    '.llm-wiki',
    'auths',
    'logs',
    'subagent-artifacts',
    'Library',
    'Applications',
    '.cache',
    '.cargo',
    '.rustup',
    '.npm',
    '.bun',
    '.pnpm',
    '.yarn',
    '.local',
    '.vscode',
    '.idea',
    'Downloads',
    'Movies',
    'Music',
    'Pictures',
    'VirtualBox VMs',
    '.cocoapods',
    '.gradle',
    '.m2',
    '.docker',
    '.orbstack',
    '.colima',
    '.venv',
    'venv',
    'env',
    'target',
    'out',
    '.next',
    '.nuxt',
    'coverage',
    '.terraform',
  ]);

  private goFuncPattern = /func\s+(?:\([^)]+\)\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/g;
  private goStructPattern = /type\s+([A-Z][A-Za-z0-9_]*)\s+struct/g;
  private tsExportPattern = /export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+([A-Za-z0-9_]+)/g;
  private rustPubPattern = /pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z0-9_]+)/g;
  private pyDefPattern = /(?:def|class)\s+([A-Za-z0-9_]+)/g;

  /**
   * Check if a file is a unit test or mock fixture
   */
  public isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase().replace(/\\/g, '/');
    const base = path.basename(lower);

    return (
      base.endsWith('_test.go') ||
      base.endsWith('.test.ts') ||
      base.endsWith('.spec.ts') ||
      base.endsWith('.test.tsx') ||
      base.endsWith('.spec.tsx') ||
      base.endsWith('.test.js') ||
      base.endsWith('.spec.js') ||
      base.endsWith('.test.jsx') ||
      base.endsWith('.spec.jsx') ||
      base.endsWith('_test.py') ||
      base.startsWith('test_') ||
      lower.startsWith('tests/') ||
      lower.startsWith('test/') ||
      lower.includes('/test/') ||
      lower.includes('/tests/') ||
      lower.includes('/mocks/') ||
      lower.includes('/fixtures/')
    );
  }

  /**
   * Extract key exported symbols from file content
   */
  public extractSymbols(filePath: string, content: string, maxSymbols: number = 8): string[] {
    const ext = path.extname(filePath).toLowerCase();
    const symbols = new Set<string>();

    // RegExp instances with the global flag retain lastIndex between calls.
    // Extraction is intentionally stateless per file.
    for (const pattern of [
      this.goFuncPattern,
      this.goStructPattern,
      this.tsExportPattern,
      this.rustPubPattern,
      this.pyDefPattern,
    ]) {
      pattern.lastIndex = 0;
    }

    if (ext === '.go') {
      let match: RegExpExecArray | null;
      while ((match = this.goStructPattern.exec(content)) !== null) {
        symbols.add(match[1]);
        if (symbols.size >= 3) break;
      }
      this.goFuncPattern.lastIndex = 0;
      while ((match = this.goFuncPattern.exec(content)) !== null) {
        symbols.add(match[1]);
        if (symbols.size >= maxSymbols) break;
      }
    } else if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
      let match: RegExpExecArray | null;
      while ((match = this.tsExportPattern.exec(content)) !== null) {
        symbols.add(match[1]);
        if (symbols.size >= maxSymbols) break;
      }
    } else if (ext === '.rs') {
      let match: RegExpExecArray | null;
      while ((match = this.rustPubPattern.exec(content)) !== null) {
        symbols.add(match[1]);
        if (symbols.size >= maxSymbols) break;
      }
    } else if (ext === '.py') {
      let match: RegExpExecArray | null;
      while ((match = this.pyDefPattern.exec(content)) !== null) {
        if (!match[1].startsWith('_')) {
          symbols.add(match[1]);
          if (symbols.size >= maxSymbols) break;
        }
      }
    }

    return Array.from(symbols);
  }

  /**
   * Traverse directory and generate Trie-Folded DSL
   */
  public generateTrieDSL(options: CodeGraphExportOptions): {
    dsl: string;
    totalFiles: number;
    totalSymbols: number;
    estimatedTokens: number;
  } {
    const rootDir = path.resolve(options.rootDir);
    const excludeTests = options.excludeTests ?? true;
    const maxSymbolsPerFile = options.maxSymbolsPerFile ?? 6;
    const maxFiles = options.maxFiles ?? 3000;
    const maxDepth = options.maxDepth ?? 8;

    // Home / System Root Guard: Never recursively crawl user home directory or system root!
    if (isSystemRootOrHome(rootDir)) {
      return {
        dsl: '[~]\n',
        totalFiles: 0,
        totalSymbols: 0,
        estimatedTokens: 0,
      };
    }

    const customIgnores = options.ignoreDirs || [];
    const ignoreDirs = new Set([...this.defaultIgnoreDirs, ...customIgnores]);

    const dirClusters = new Map<string, string[]>();
    let totalFiles = 0;
    let totalSymbols = 0;

    const walk = (currentDir: string, relDir: string, depth: number = 0) => {
      if (totalFiles >= maxFiles || depth > maxDepth) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (totalFiles >= maxFiles) break;

        const name = entry.name;
        if (name.startsWith('.') && name !== '.') {
          // Check if explicit dotfile/dir is allowed; otherwise skip common hidden dirs
          if (ignoreDirs.has(name)) continue;
        }

        if (entry.isDirectory()) {
          if (!ignoreDirs.has(name)) {
            walk(path.join(currentDir, name), relDir ? `${relDir}/${name}` : name, depth + 1);
          }
        } else if (entry.isFile()) {
          const fullPath = path.join(currentDir, name);
          const relPath = relDir ? `${relDir}/${name}` : name;

          if (excludeTests && this.isTestFile(relPath)) {
            continue;
          }

          // Check supported extensions
          const ext = path.extname(name).toLowerCase();
          if (!['.go', '.ts', '.tsx', '.js', '.jsx', '.rs', '.py'].includes(ext)) {
            continue;
          }

          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const symbols = this.extractSymbols(name, content, maxSymbolsPerFile);
            if (symbols.length > 0) {
              totalFiles++;
              totalSymbols += symbols.length;
              const clusterKey = relDir || '.';
              if (!dirClusters.has(clusterKey)) {
                dirClusters.set(clusterKey, []);
              }
              dirClusters.get(clusterKey)!.push(`${name}->${symbols.join(' ')}`);
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    };

    walk(rootDir, '', 0);

    const lines: string[] = [];
    const sortedDirs = Array.from(dirClusters.keys()).sort();

    for (const d of sortedDirs) {
      lines.push(`[${d}]`);
      for (const fitem of dirClusters.get(d)!) {
        lines.push(`  ${fitem}`);
      }
    }

    const dsl = lines.join('\n');
    const bytes = Buffer.byteLength(dsl, 'utf-8');
    const estimatedTokens = Math.ceil(bytes / 3.8);

    return {
      dsl,
      totalFiles,
      totalSymbols,
      estimatedTokens,
    };
  }
}
