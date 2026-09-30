import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { describe, it } from 'bun:test';
import { JevConfigStore, parseJsonc } from '../src/config/config-store.js';

const temp = () => mkdtempSync(join(tmpdir(), 'jev-config-'));
const writeConfig = (file: string, contents: string) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
};

 describe('JevConfigStore', () => {
  it('parses JSONC strings containing comma-braces and comma-brackets', () => {
    const parsed = parseJsonc<{ model: string; values: string[] }>(`{
      // comments and trailing commas are valid JSONC
      "model": ",}",
      "values": [",]",],
    }`);
    assert.equal(parsed.model, ',}');
    assert.deepEqual(parsed.values, [',]']);
  });

  it('preserves JSONC comments and persists a toggle across reload', () => {
    const home = temp();
    const project = temp();
    const file = join(project, '.pi', 'jev-config.jsonc');
    writeConfig(file, '{\n  // Keep this comment\n  "enableSkills": true,\n}\n');
    const store = new JevConfigStore(project, {}, home);
    assert.equal(store.toggle('skills').newValue, false);
    store.saveProjectConfig();
    const saved = readFileSync(file, 'utf8');
    assert.match(saved, /Keep this comment/);
    assert.equal(new JevConfigStore(project, {}, home).get().enableSkills, false);
  });

  it('never lets project secrets or endpoint override trusted global config', () => {
    const home = temp();
    const project = temp();
    writeConfig(join(home, '.pi', 'agent', 'jev-config.json'), JSON.stringify({
      endpoint: 'https://trusted.example/v1', apiKey: 'global-secret', keyFilePath: '/trusted/key',
    }));
    writeConfig(join(project, '.pi', 'jev-config.json'), JSON.stringify({
      endpoint: 'https://evil.example', apiKey: 'evil', keyFilePath: '/tmp/evil', model: 'project-model',
    }));
    const store = new JevConfigStore(project, {}, home);
    assert.equal(store.get().endpoint, 'https://trusted.example/v1');
    assert.equal(store.get().apiKey, 'global-secret');
    assert.equal(store.get().keyFilePath, '/trusted/key');
    assert.equal(store.get().model, 'project-model');
    store.saveProjectConfig();
    const saved = readFileSync(join(project, '.pi', 'jev-config.json'), 'utf8');
    assert.doesNotMatch(saved, /evil|endpoint|apiKey|keyFilePath/);
  });

  it('does not copy global secrets or defaults into project saves', () => {
    const home = temp();
    const project = temp();
    writeConfig(join(home, '.pi', 'agent', 'jev-config.json'), JSON.stringify({ apiKey: 'not-for-project', timeoutMs: 42 }));
    const store = new JevConfigStore(project, {}, home);
    store.saveProjectConfig();
    const saved = JSON.parse(readFileSync(join(project, '.pi', 'jev-config.json'), 'utf8'));
    assert.deepEqual(saved, {});
    store.set({ enableSkills: false });
    store.saveProjectConfig();
    assert.equal(JSON.parse(readFileSync(join(project, '.pi', 'jev-config.json'), 'utf8')).enableSkills, false);
  });

  it('saveGlobalConfig does not inherit project or constructor implicit values, and does not leak project-local overrides', () => {
    const home = temp();
    const project = temp();
    // Global starts with just model
    writeConfig(join(home, '.pi', 'agent', 'jev-config.json'), JSON.stringify({ model: 'global-model' }));
    // Project config has enableSkills: false
    writeConfig(join(project, '.pi', 'jev-config.json'), JSON.stringify({ enableSkills: false, timeoutMs: 9999 }));

    // Instantiate with constructor overrides
    const store = new JevConfigStore(project, { timeoutMs: 5555 }, home);
    // saveGlobalConfig should only persist explicit keys modified via store.set()
    const globalFile = store.saveGlobalConfig();
    const globalSaved = JSON.parse(readFileSync(globalFile, 'utf8'));

    // Global file should still only contain its original global keys, not project's enableSkills or timeoutMs
    assert.equal(globalSaved.model, 'global-model');
    assert.equal(globalSaved.enableSkills, undefined);
    assert.equal(globalSaved.timeoutMs, undefined);

    // If we explicitly set a global key via store.set
    store.set({ maxMemoryGuards: 50 });
    store.saveGlobalConfig();
    const globalSaved2 = JSON.parse(readFileSync(globalFile, 'utf8'));
    assert.equal(globalSaved2.maxMemoryGuards, 50);
    assert.equal(globalSaved2.enableSkills, undefined);
  });

  it('validates values, reports diagnostics, uses valid fallback files, and writes 0600', () => {
    const home = temp();
    const project = temp();
    writeConfig(join(home, '.pi', 'agent', 'jev-config.jsonc'), '{ broken');
    writeConfig(join(home, '.pi', 'agent', 'jev-config.json'), JSON.stringify({ timeoutMs: 10, ignoreDirs: ['.git', 'dist'] }));
    writeConfig(join(project, '.pi', 'jev-config.json'), JSON.stringify({ timeoutMs: -1, enableSkills: 'yes', ignoreDirs: 'not-an-array' }));
    const store = new JevConfigStore(project, {}, home);
    assert.equal(store.get().timeoutMs, 10);
    assert.equal(store.get().enableSkills, true);
    assert.deepEqual(store.get().ignoreDirs, ['.git', 'dist']);
    const diags = store.getDiagnostics();
    assert.ok(diags.length >= 3);
    assert.ok(diags.some((d) => d.includes('Ignoring invalid project config value for ignoreDirs')));
    const globalPath = store.saveGlobalConfig();
    chmodSync(globalPath, 0o600);
    assert.equal(statSync(globalPath).mode & 0o777, 0o600);
  });

  it('supports ~/.jev-config.jsonc or project root .jev-config.jsonc to override global config', () => {
    const home = temp();
    // 1. Global config has subsystems and memories enabled
    writeConfig(join(home, '.pi', 'agent', 'jev-config.jsonc'), JSON.stringify({
      enableSubsystems: true,
      enableSkills: true,
      enableMemories: true,
    }));

    // 2. Normal project without local config inherits global config
    const normalProject = temp();
    const normalStore = new JevConfigStore(normalProject, {}, home);
    assert.equal(normalStore.get().enableSubsystems, true);
    assert.equal(normalStore.get().enableSkills, true);
    assert.equal(normalStore.get().enableMemories, true);

    // 3. User places ~/.jev-config.jsonc in home directory (projectRoot = home)
    writeConfig(join(home, '.jev-config.jsonc'), JSON.stringify({
      enableSubsystems: false,
      enableSkills: false,
      enableMemories: true,
    }));

    // 4. In home directory, ~/.jev-config.jsonc overrides global config: only mem enabled!
    const homeStore = new JevConfigStore(home, {}, home);
    assert.equal(homeStore.get().enableSubsystems, false);
    assert.equal(homeStore.get().enableSkills, false);
    assert.equal(homeStore.get().enableMemories, true);

    // 5. Saving home project config updates ~/.jev-config.jsonc without creating .pi
    homeStore.set({ maxMemoryGuards: 42 });
    homeStore.saveProjectConfig();
    const savedHome = JSON.parse(readFileSync(join(home, '.jev-config.jsonc'), 'utf8'));
    assert.equal(savedHome.enableSubsystems, false);
    assert.equal(savedHome.maxMemoryGuards, 42);
  });

  it('supports per-directory project configs in global jev-config.jsonc with fallback and worktree inheritance', () => {
    const home = temp();
    const mainRepo = temp();
    const worktree = `${mainRepo}-worktree`;

    try {
      execSync(`git init -q ${mainRepo}`);
      execSync('git config user.email "test@example.com"', { cwd: mainRepo });
      execSync('git config user.name "Test"', { cwd: mainRepo });
      execSync('git commit --allow-empty -m "init" -q', { cwd: mainRepo });
      execSync(`git worktree add -q -b feature-test ${worktree}`, { cwd: mainRepo });

      // Write global config with both object mapping and array format supported
      writeConfig(join(home, '.pi', 'agent', 'jev-config.jsonc'), JSON.stringify({
        enableSubsystems: true,
        enableSkills: true,
        enableMemories: true,
        projects: {
          '~': {
            enableSubsystems: false,
            enableSkills: false,
            enableMemories: true,
          },
          [mainRepo]: {
            timeoutMs: 4500,
            enableSkills: false,
          },
        },
      }));

      // 1. Home directory matches '~' rule from global projects list: only mem enabled
      const homeStore = new JevConfigStore(home, {}, home);
      assert.equal(homeStore.get().enableSubsystems, false);
      assert.equal(homeStore.get().enableSkills, false);
      assert.equal(homeStore.get().enableMemories, true);

      // 2. Normal project without rule uses global base
      const otherProject = temp();
      const otherStore = new JevConfigStore(otherProject, {}, home);
      assert.equal(otherStore.get().enableSubsystems, true);
      assert.equal(otherStore.get().enableSkills, true);
      assert.equal(otherStore.get().timeoutMs, 1500);

      // 3. Main repo matches mainRepo rule
      const mainStore = new JevConfigStore(mainRepo, {}, home);
      assert.equal(mainStore.get().timeoutMs, 4500);
      assert.equal(mainStore.get().enableSkills, false);

      // 4. Git Worktree inherits main repo root rule!
      const worktreeStore = new JevConfigStore(worktree, {}, home);
      assert.equal(worktreeStore.get().timeoutMs, 4500);
      assert.equal(worktreeStore.get().enableSkills, false);

      // 5. Project local ./.pi/jev-config.jsonc has higher priority than global projects rule
      writeConfig(join(worktree, '.pi', 'jev-config.jsonc'), JSON.stringify({
        enableSkills: true, // local override wins!
      }));
      const worktreeLocalStore = new JevConfigStore(worktree, {}, home);
      assert.equal(worktreeLocalStore.get().enableSkills, true); // local wins
      assert.equal(worktreeLocalStore.get().timeoutMs, 4500); // inherited from main repo rule
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(mainRepo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('supports array format for projects list in global config', () => {
    const home = temp();
    const project = temp();
    writeConfig(join(home, '.pi', 'agent', 'jev-config.jsonc'), JSON.stringify({
      enableSubsystems: true,
      projects: [
        {
          path: project,
          enableSubsystems: false,
          timeoutMs: 3333,
        },
      ],
    }));

    const store = new JevConfigStore(project, {}, home);
    assert.equal(store.get().enableSubsystems, false);
    assert.equal(store.get().timeoutMs, 3333);
  });
});
