import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CodeGraphExtractor } from '../src/graph/codegraph.js';
import { resolveGitContext } from '../src/graph/git.js';

const extractor = new CodeGraphExtractor();

describe('graph regressions', () => {
  test('resets global regex state between symbol extractions', () => {
    expect(extractor.extractSymbols('a.ts', 'export const First = 1; export const Extra = 2;', 1)).toEqual(['First']);
    expect(extractor.extractSymbols('b.ts', 'export const Second = 2;')).toEqual(['Second']);
  });

  test('resolves repository and linked worktree metadata from subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-git-'));
    const worktree = `${root}-worktree`;
    try {
      execSync('git init -q && git config user.email test@example.com && git config user.name test && touch root.go && git add root.go && git commit -qm init', { cwd: root });
      mkdirSync(join(root, 'sub'));
      const repo = resolveGitContext(join(root, 'sub'));
      expect(repo.mainRepoRoot).toBe(realpathSync(root));
      execSync(`git worktree add -q -b regression ${worktree}`, { cwd: root });
      const linked = resolveGitContext(join(worktree, ''));
      expect(linked.isWorktree).toBe(true);
      expect(linked.mainRepoRoot).toBe(realpathSync(root));
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recognizes TSX and JSX files and tests', () => {
    expect(extractor.isTestFile('src/view.test.tsx')).toBe(true);
    expect(extractor.isTestFile('src/view.spec.jsx')).toBe(true);
    expect(extractor.isTestFile('src/view.tsx')).toBe(false);

    const root = mkdtempSync(join(tmpdir(), 'jev-graph-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'view.tsx'), 'export function View() {}');
    const graph = extractor.generateTrieDSL({ rootDir: root, excludeTests: true });
    expect(graph.dsl).toContain('view.tsx->View');
  });

  test('extracts single-letter exported Go functions and types such as F and T', () => {
    const goCode = `
package main

type T struct {
\tField int
}

type S struct {
\tField string
}

func F() {}
func G(a int) bool { return true }
func (t *T) M() {}
`;
    const symbols = extractor.extractSymbols('main.go', goCode);
    expect(symbols).toContain('T');
    expect(symbols).toContain('S');
    expect(symbols).toContain('F');
    expect(symbols).toContain('G');
    expect(symbols).toContain('M');
  });
});
