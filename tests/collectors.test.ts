import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillCollector } from '../src/skills/collector.ts';
import { MemoryCollector } from '../src/memory/collector.ts';
import { JevPrompter } from '../src/jev/prompter.ts';
import { put } from './support.ts';

let temporary: string;
let home: string;
let root: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-collectors-'));
  home = path.join(temporary, 'home'); root = path.join(temporary, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));
const skill = (name: string, description = 'description') => `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\n`;

describe('skill catalog discovery', () => {
  it('supports nested skills, standalone markdown, explicit paths and symlinks without loops', () => {
    const base = path.join(root, '.pi', 'skills');
    put(path.join(base, 'group/nested/SKILL.md'), skill('nested'));
    put(path.join(base, 'standalone.md'), '---\ndescription: standalone instructions\n---\n');
    put(path.join(temporary, 'linked/SKILL.md'), skill('linked'));
    fs.symlinkSync(path.join(temporary, 'linked'), path.join(base, 'linked'));
    fs.symlinkSync(base, path.join(base, 'group', 'loop'));
    put(path.join(temporary, 'extra.md'), skill('extra'));
    const found = new SkillCollector(home).collectSkills(root, [path.join(temporary, 'extra.md'), path.join(base, 'linked')]);
    expect(found.map((entry) => entry.name).sort()).toEqual(['extra', 'linked', 'nested', 'standalone']);
  });

  it('parses frontmatter only, keeps complete multiline descriptions and honors manual invocation', () => {
    const base = path.join(root, '.agents', 'skills');
    put(path.join(base, 'valid/SKILL.md'), `---\nname: valid\ndescription: >\n  ${'Long multilingual 中文 description '.repeat(10)}\n  final description line\n---\nExample:\nname: forged\ndescription: forged body\n`);
    put(path.join(base, 'manual/SKILL.md'), '---\nname: manual\ndescription: explicit command only\ndisable-model-invocation: true\n---\n');
    put(path.join(base, 'valid/references/child/SKILL.md'), skill('not-another-skill'));
    const found = new SkillCollector(home).collectSkills(root);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('valid');
    expect(found[0].description.length).toBeGreaterThan(100);
    expect(found[0].description).toContain('final description line');
    expect(found[0].description).not.toContain('forged');
  });

  it('resolves literal user and project settings paths relative to their settings files', () => {
    put(path.join(home, '.pi/agent/settings.json'), JSON.stringify({ other: 'https://example.invalid/', skills: ['extra-catalog'] }));
    put(path.join(home, '.pi/agent/extra-catalog/SKILL.md'), skill('user-custom'));
    put(path.join(root, '.pi/settings.json'), JSON.stringify({ skills: ['project-catalog', '~/extra-skill.md'] }));
    put(path.join(root, '.pi/project-catalog/SKILL.md'), skill('project-custom'));
    put(path.join(home, 'extra-skill.md'), skill('home-custom'));
    expect(new SkillCollector(home).collectSkills(root).map((entry) => entry.name).sort())
      .toEqual(['home-custom', 'project-custom', 'user-custom']);
  });
});

describe('memory candidate identity', () => {
  it('decodes full Base64URL Unicode projects without accepting a truncated project or corrupt marker', () => {
    const current = path.join(temporary, 'rep'); fs.mkdirSync(current);
    const unicode = 'repo😀';
    put(path.join(home, '.pi/agent/pi-hermes-memory/failures.md'), [
      `[correction] FOREIGN_UNICODE\nSecret rule\n<!-- project64=${Buffer.from(unicode).toString('base64url')} last=2026-10-03 -->`,
      '[correction] CORRUPT_SCOPE\nSecret corrupt rule\n<!-- project64=a!broken last=2026-10-03 -->',
    ].join('\n§\n'));
    expect(new MemoryCollector(home).collectMemories(current)).toEqual([]);
    const matched = path.join(temporary, unicode); fs.mkdirSync(matched);
    expect(new MemoryCollector(home).collectMemories(matched).map(memory => memory.title)).toEqual(['FOREIGN_UNICODE']);
  });
  it('never merges distinct titles or bodies sharing short prefixes', () => {
    const prefix = 'a'.repeat(80);
    const records = [
      `[correction] ${prefix} Alpha\nRule alpha`,
      `[correction] ${prefix} Beta\nRule beta`,
      '[correction] Same title\nFirst body',
      '[correction] Same title\nSecond body',
      `[correction] ${prefix} Alpha\nRule alpha`,
    ];
    put(path.join(home, '.pi/agent/pi-hermes-memory/failures.md'), records.join('\n§\n'));
    const found = new MemoryCollector(home).collectMemories(root, 100);
    expect(found).toHaveLength(4);
    expect(new Set(found.map((entry) => entry.id)).size).toBe(4);
    expect(found.find((entry) => entry.rule === 'Rule alpha')?.frequency).toBe(2);
    for (const entry of found) expect(entry.id).toMatch(/^mem_[a-f0-9]{64}$/);
    const rebuilt = new MemoryCollector(home).collectMemories(root, 100);
    expect(rebuilt.map((entry) => entry.id)).toEqual(found.map((entry) => entry.id));
    const built = new JevPrompter().buildQuestions('', [], [], found);
    expect(Object.keys(built.questions).filter(id => id.startsWith('q5_memory_'))).toHaveLength(4);
  });

  it('preserves distinct long bodies and the configured total limit', () => {
    const common = 'long rule '.repeat(100);
    put(path.join(home, '.pi/agent/pi-hermes-memory/failures.md'), [
      `[correction] Long rule\n${common}FIRST_FINAL_REQUIREMENT`,
      `[correction] Long rule\n${common}SECOND_FINAL_REQUIREMENT`,
    ].join('\n§\n'));
    const collector = new MemoryCollector(home);
    const found = collector.collectMemories(root, 100);
    expect(found).toHaveLength(2);
    expect(found.some((entry) => entry.summary.includes('SECOND_FINAL_REQUIREMENT'))).toBe(true);
    expect(collector.collectMemories(root, 1)).toHaveLength(1);
    expect(collector.collectMemories(root, 0)).toEqual([]);
  });
});
