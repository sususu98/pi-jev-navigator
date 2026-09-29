import * as fs from 'fs';
import * as path from 'path';
import { CodeGraphExportOptions } from '../types.js';

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
    'subagent-artifacts',
  ]);

  private goFuncPattern = /func\s+(?:\([^)]+\)\s+)?([A-Z][A-Za-z0-9_]+)\s*\(/g;
  private goStructPattern = /type\s+([A-Z][A-Za-z0-9_]+)\s+struct/g;
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
      base.endsWith('.test.js') ||
      base.endsWith('.spec.js') ||
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
    const rootDir = options.rootDir;
    const excludeTests = options.excludeTests ?? true;
    const maxSymbolsPerFile = options.maxSymbolsPerFile ?? 6;
    const ignoreDirs = new Set(options.ignoreDirs || this.defaultIgnoreDirs);

    const dirClusters = new Map<string, string[]>();
    let totalFiles = 0;
    let totalSymbols = 0;

    const walk = (currentDir: string, relDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith('.') && name !== '.') continue;

        if (entry.isDirectory()) {
          if (!ignoreDirs.has(name)) {
            walk(path.join(currentDir, name), relDir ? `${relDir}/${name}` : name);
          }
        } else if (entry.isFile()) {
          const fullPath = path.join(currentDir, name);
          const relPath = relDir ? `${relDir}/${name}` : name;

          if (excludeTests && this.isTestFile(relPath)) {
            continue;
          }

          // Check supported extensions
          const ext = path.extname(name).toLowerCase();
          if (!['.go', '.ts', '.js', '.rs', '.py'].includes(ext)) {
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

    walk(rootDir, '');

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
