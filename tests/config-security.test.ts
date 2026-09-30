import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JevConfigStore } from '../src/config/config-store.ts';
import { writeSafeConfig } from '../src/config/safe-file.ts';
import { put } from './support.ts';

let temporary: string;
let home: string;
let root: string;
let globalFile: string;
let localFile: string;
const globalText = '{\n  // trusted credentials must remain untouched\n  "apiKey": "FAKE_SECRET",\n  "endpoint": "https://trusted.invalid",\n  "enableSkills": true\n}\n';
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-config-security-'));
  home = path.join(temporary, 'home'); root = path.join(temporary, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(root);
  globalFile = path.join(home, '.pi/agent/jev-config.json');
  localFile = path.join(root, '.pi/jev-config.json');
  put(globalFile, globalText);
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));
const unchanged = () => expect(fs.readFileSync(globalFile, 'utf8')).toBe(globalText);

describe('project configuration write boundary', () => {
  it('rejects a project config symlink to trusted global config', () => {
    fs.mkdirSync(path.dirname(localFile)); fs.symlinkSync(globalFile, localFile);
    const store = new JevConfigStore(root, {}, home);
    store.toggle('skills');
    expect(() => store.saveProjectConfig()).toThrow();
    unchanged();
    expect(fs.lstatSync(localFile).isSymbolicLink()).toBe(true);
  });

  it('rejects parent directory symlinks even when the config file does not exist', () => {
    fs.symlinkSync(path.dirname(globalFile), path.join(root, '.pi'), 'dir');
    const store = new JevConfigStore(root, {}, home);
    store.toggle('skills');
    expect(() => store.saveProjectConfig()).toThrow();
    unchanged();
    expect(fs.readdirSync(path.dirname(globalFile))).toEqual(['jev-config.json']);
  });

  it('rejects dangling links and hard-linked global files', () => {
    fs.mkdirSync(path.dirname(localFile));
    fs.symlinkSync(path.join(home, 'missing'), localFile);
    expect(() => new JevConfigStore(root, {}, home).saveProjectConfig()).toThrow();
    expect(fs.existsSync(path.join(home, 'missing'))).toBe(false);
    fs.unlinkSync(localFile); fs.linkSync(globalFile, localFile);
    const store = new JevConfigStore(root, {}, home); store.toggle('skills');
    expect(() => store.saveProjectConfig()).toThrow();
    unchanged();
  });

  it('refuses a final-file link introduced immediately before the no-follow read', () => {
    put(localFile, '{"enableSkills": true}');
    const store = new JevConfigStore(root, {}, home); store.toggle('skills');
    const original = fs.openSync;
    const canonicalLocal = fs.realpathSync(localFile);
    let replaced = false;
    const open = spyOn(fs, 'openSync').mockImplementation(((file: any, flags: any, mode: any) => {
      if (!replaced && file === canonicalLocal) {
        replaced = true; fs.unlinkSync(localFile); fs.symlinkSync(globalFile, localFile);
      }
      return (original as any)(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(() => store.saveProjectConfig()).toThrow(); unchanged();
    } finally { open.mockRestore(); }
  });

  it('rechecks the parent identity after staging, without writing through a redirected directory', () => {
    put(localFile, '{"enableSkills": true}');
    const store = new JevConfigStore(root, {}, home); store.toggle('skills');
    const original = fs.writeFileSync;
    let replaced = false;
    const write = spyOn(fs, 'writeFileSync').mockImplementation(((...args: any[]) => {
      const result = (original as any)(...args);
      if (!replaced && typeof args[0] === 'number') {
        replaced = true;
        fs.renameSync(path.join(root, '.pi'), path.join(root, '.pi-moved'));
        fs.symlinkSync(path.dirname(globalFile), path.join(root, '.pi'), 'dir');
      }
      return result;
    }) as typeof fs.writeFileSync);
    try {
      expect(() => store.saveProjectConfig()).toThrow(); unchanged();
      expect(fs.readdirSync(path.dirname(globalFile))).toEqual(['jev-config.json']);
    } finally { write.mockRestore(); }
  });

  it('preserves JSONC and 0600 permissions with atomic replacement and cleans failed staging files', () => {
    const jsonc = path.join(root, '.pi/jev-config.jsonc');
    const text = '{\n // preserve comment\n "enableSkills": true,\n}\n';
    put(jsonc, text);
    const store = new JevConfigStore(root, {}, home); store.toggle('skills');
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated rename failure'); });
    try {
      expect(() => store.saveProjectConfig()).toThrow('simulated rename failure');
      expect(fs.readFileSync(jsonc, 'utf8')).toBe(text);
      expect(fs.readdirSync(path.dirname(jsonc))).toEqual(['jev-config.jsonc']);
    } finally { rename.mockRestore(); }
    store.saveProjectConfig();
    expect(fs.readFileSync(jsonc, 'utf8')).toContain('preserve comment');
    expect(new JevConfigStore(root, {}, home).get().enableSkills).toBe(false);
    expect(fs.statSync(jsonc).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(jsonc))).toEqual(['jev-config.jsonc']);
    unchanged();
  });

  it('keeps home project preferences separate from the legacy global fallback file', () => {
    const legacy = path.join(home, '.pi/jev-config.json');
    put(legacy, globalText);
    fs.unlinkSync(globalFile);
    const store = new JevConfigStore(home, {}, home); store.toggle('skills');
    expect(store.saveProjectConfig()).toBe(path.join(home, '.jev-config.json'));
    expect(fs.readFileSync(legacy, 'utf8')).toBe(globalText);
    expect(new JevConfigStore(home, {}, home).get().enableSkills).toBe(false);
    expect(fs.readFileSync(path.join(home, '.jev-config.json'), 'utf8')).not.toContain('FAKE_SECRET');
  });

  it('refuses lexical escapes and protected global destinations even inside the permitted root', () => {
    expect(() => writeSafeConfig(path.join(home, 'escape.json'), root, [], () => '{}')).toThrow('outside');
    expect(() => writeSafeConfig(globalFile, home, [globalFile], () => '{}')).toThrow('protected global');
    unchanged();
  });
});
