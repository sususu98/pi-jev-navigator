import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    writeConfig(join(home, '.pi', 'agent', 'jev-config.json'), JSON.stringify({ timeoutMs: 10 }));
    writeConfig(join(project, '.pi', 'jev-config.json'), JSON.stringify({ timeoutMs: -1, enableSkills: 'yes' }));
    const store = new JevConfigStore(project, {}, home);
    assert.equal(store.get().timeoutMs, 10);
    assert.equal(store.get().enableSkills, true);
    assert.ok(store.getDiagnostics().length >= 3);
    const globalPath = store.saveGlobalConfig();
    chmodSync(globalPath, 0o600);
    assert.equal(statSync(globalPath).mode & 0o777, 0o600);
  });
});
