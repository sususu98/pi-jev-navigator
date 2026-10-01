import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TTLStore } from '../src/cache/ttl-store.js';
import { CodeGraphExtractor } from '../src/graph/codegraph.js';
import { JevNavigator } from '../src/index.js';

let temporary: string;
let root: string;
let outside: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-resource-safety-'));
  root = path.join(temporary, 'repo'); outside = path.join(temporary, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

const writers = [
  { name: 'DSL', file: 'cpa-macro-map.dsl', write: (store: TTLStore) => store.setRawFile('cpa-macro-map.dsl', 'replacement') },
  { name: 'JSON', file: 'codegraph.json', write: (store: TTLStore) => store.set('codegraph', { replacement: true }) },
];

describe('cache write boundary', () => {
  for (const writer of writers) {
    it(`rejects ${writer.name} symlinks, dangling links and hard links without touching targets`, () => {
      const directory = path.join(root, '.pi'); fs.mkdirSync(directory);
      const target = path.join(outside, 'victim'); fs.writeFileSync(target, 'original');
      const cache = path.join(directory, writer.file);
      const store = new TTLStore(root);
      fs.symlinkSync(target, cache);
      expect(() => writer.write(store)).toThrow();
      expect(fs.readFileSync(target, 'utf8')).toBe('original');
      expect(fs.lstatSync(cache).isSymbolicLink()).toBe(true);
      fs.unlinkSync(cache);
      const missing = path.join(outside, 'missing'); fs.symlinkSync(missing, cache);
      expect(() => writer.write(store)).toThrow();
      expect(fs.existsSync(missing)).toBe(false);
      fs.unlinkSync(cache); fs.linkSync(target, cache);
      expect(() => writer.write(store)).toThrow();
      expect(fs.readFileSync(target, 'utf8')).toBe('original');
    });

    it(`rejects a linked .pi parent for ${writer.name} writes`, () => {
      fs.symlinkSync(outside, path.join(root, '.pi'), 'dir');
      expect(() => writer.write(new TTLStore(root))).toThrow();
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  }

  it('rejects path escapes and Windows-style separators in both write APIs', () => {
    const store = new TTLStore(root);
    for (const name of ['../victim', '/absolute', '..\\victim', 'C:escape', 'bad\0name']) {
      expect(() => store.setRawFile(name, 'replacement')).toThrow('Invalid cache filename');
      expect(() => store.set(name, {})).toThrow('Invalid cache filename');
    }
    expect(fs.existsSync(path.join(root, '.pi'))).toBe(false);
  });

  it('uses private atomic replacement and cleans staging files on failed rename', () => {
    const store = new TTLStore(root);
    store.setRawFile('map.dsl', 'original');
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('rename failed'); });
    try {
      expect(() => store.setRawFile('map.dsl', 'replacement')).toThrow('rename failed');
      expect(store.getRawFile('map.dsl')).toBe('original');
      expect(fs.readdirSync(path.join(root, '.pi'))).toEqual(['map.dsl']);
    } finally { rename.mockRestore(); }
    store.setRawFile('map.dsl', 'replacement');
    expect(store.getRawFile('map.dsl')).toBe('replacement');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root, '.pi', 'map.dsl')).mode & 0o777).toBe(0o600);
    store.set('codegraph', { value: 1 });
    expect(store.get('codegraph')).toEqual({ value: 1 });
  });

  it('refuses a parent redirected after staging without writing into the new directory', () => {
    const store = new TTLStore(root); store.setRawFile('map.dsl', 'original');
    const original = fs.writeFileSync;
    let redirected = false;
    const write = spyOn(fs, 'writeFileSync').mockImplementation(((...args: any[]) => {
      const result = (original as any)(...args);
      if (!redirected && typeof args[0] === 'number') {
        redirected = true;
        fs.renameSync(path.join(root, '.pi'), path.join(root, '.pi-moved'));
        fs.symlinkSync(outside, path.join(root, '.pi'), 'dir');
      }
      return result;
    }) as typeof fs.writeFileSync);
    try {
      expect(() => store.setRawFile('map.dsl', 'replacement')).toThrow();
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.readFileSync(path.join(root, '.pi-moved', 'map.dsl'), 'utf8')).toBe('original');
    } finally { write.mockRestore(); }
  });

  it('keeps graph generation fail-open when cache publication is unsafe', () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const A = 1;');
    fs.mkdirSync(path.join(root, '.pi'));
    const target = path.join(outside, 'victim'); fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, path.join(root, '.pi', 'cpa-macro-map.dsl'));
    const nav = new JevNavigator(root, { enableSkills: false, enableMemories: false, logDecisions: false }, outside);
    expect(nav.getOrGenerateCodeGraph(true).dsl).toContain('a.ts->A');
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    // Automatic expiry also attempts publication; it must preserve the link target.
    const expired = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(target, expired, expired);
    const regenerated = nav.getOrGenerateCodeGraph();
    expect(regenerated.fromCache).toBe(false);
    expect(regenerated.dsl).toContain('a.ts->A');
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });
});

describe('actual source scan budget', () => {
  it('charges files without symbols across nested directories, not just indexed files', () => {
    for (let directory = 0; directory < 3; directory++) {
      const folder = path.join(root, `dir-${directory}`); fs.mkdirSync(folder);
      for (let file = 0; file < 4; file++) fs.writeFileSync(path.join(folder, `${file}.ts`), 'const internalOnly = 1;');
    }
    const read = spyOn(fs, 'readFileSync');
    try {
      const graph = new CodeGraphExtractor().generateTrieDSL({ rootDir: root, maxFiles: 2 });
      expect(read.mock.calls.filter(([file]) => String(file).endsWith('.ts'))).toHaveLength(2);
      expect(graph.totalFiles).toBe(0); // Existing statistics still count emitted records.
      expect(graph.dsl).toBe('');
    } finally { read.mockRestore(); }
  });

  it('charges failed reads and stops before another source file is attempted', () => {
    for (let file = 0; file < 12; file++) fs.writeFileSync(path.join(root, `${file}.ts`), 'export const A = 1;');
    const read = spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('unreadable'); });
    try {
      const graph = new CodeGraphExtractor().generateTrieDSL({ rootDir: root, maxFiles: 2 });
      expect(read).toHaveBeenCalledTimes(2);
      expect(graph.totalFiles).toBe(0);
    } finally { read.mockRestore(); }
  });

  it('honors zero budget and excludes ignored/tests/unsupported files before charging', () => {
    fs.mkdirSync(path.join(root, 'ignored'));
    fs.writeFileSync(path.join(root, 'ignored', 'a.ts'), 'export const Ignored = 1;');
    fs.writeFileSync(path.join(root, 'a.test.ts'), 'export const Test = 1;');
    fs.writeFileSync(path.join(root, 'a.txt'), 'unsupported');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const B = 1;');
    const read = spyOn(fs, 'readFileSync');
    try {
      const extractor = new CodeGraphExtractor();
      expect(extractor.generateTrieDSL({ rootDir: root, maxFiles: 0 }).totalFiles).toBe(0);
      expect(read).not.toHaveBeenCalled();
      const graph = extractor.generateTrieDSL({ rootDir: root, maxFiles: 1, ignoreDirs: ['ignored'] });
      expect(read).toHaveBeenCalledTimes(1);
      expect(graph.totalFiles).toBe(1);
      expect(graph.dsl).toContain('b.ts->B');
    } finally { read.mockRestore(); }
  });

  it('enforces the hard 3000-read ceiling even when configuration asks for more', () => {
    for (let file = 0; file < 3002; file++) fs.writeFileSync(path.join(root, `${file}.ts`), 'const internalOnly = 1;');
    const read = spyOn(fs, 'readFileSync');
    try {
      expect(new CodeGraphExtractor().generateTrieDSL({ rootDir: root, maxFiles: 10000 }).totalFiles).toBe(0);
      expect(read).toHaveBeenCalledTimes(3000);
    } finally { read.mockRestore(); }
  });
});
