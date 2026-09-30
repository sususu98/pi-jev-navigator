import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import register, { JevNavigator } from '../src/index.ts';
import { redactSensitive, sensitiveValues } from '../src/config/redact.ts';
import { put, responseFor } from './support.ts';

let temporary: string;
let home: string;
let root: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-redaction-'));
  home = path.join(temporary, 'home'); root = path.join(temporary, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));
const globalFile = () => path.join(home, '.pi/agent/jev-config.json');

async function configCommand(nav: JevNavigator): Promise<string> {
  const commands: Record<string, any> = {};
  register({ on() {}, registerFlag() {}, registerCommand(name: string, value: any) { commands[name] = value; } } as any, () => nav);
  let displayed = '';
  await commands['jev-config'].handler('', { cwd: root, ui: { notify(value: string) { displayed = value; } } });
  return displayed;
}

describe('recursive credential redaction', () => {
  it('redacts object and array project rules, including unused branches and echoed secret values', async () => {
    for (const projects of [
      { '/unused-project': { apiKey: 'NESTED_SECRET', model: 'model-NESTED_SECRET', projects: { another: { API_KEY: 'DEEP_SECRET' } } } },
      [{ path: '/unused-project', apiKey: 'NESTED_SECRET', model: 'model-NESTED_SECRET', extra: [{ authorization: 'DEEP_SECRET' }] }],
    ]) {
      put(globalFile(), JSON.stringify({ apiKey: 'TOP_SECRET', projects }));
      const nav = new JevNavigator(root, {}, home);
      const before = JSON.stringify(nav.getConfig());
      const displayed = await configCommand(nav);
      for (const secret of ['TOP_SECRET', 'NESTED_SECRET', 'DEEP_SECRET']) expect(displayed).not.toContain(secret);
      expect(displayed).toContain('[REDACTED]');
      expect(JSON.stringify(nav.getConfig())).toBe(before);
      expect(nav.getConfig().apiKey).toBe('TOP_SECRET');
    }
  });

  it('redacts diagnostic text using known configured secrets without hiding normal messages', () => {
    put(globalFile(), JSON.stringify({ apiKey: 'DIAG_SECRET', projects: { [root]: { DIAG_SECRET: true, enableSkills: false } } }));
    const nav = new JevNavigator(root, {}, home);
    const diagnostics = nav.getConfigStore().getDiagnostics().join(' ');
    expect(diagnostics).not.toContain('DIAG_SECRET');
    expect(diagnostics).toContain('[REDACTED]');
    expect(diagnostics).toContain('Ignoring unknown');
    expect(nav.getConfig().enableSkills).toBe(false);
  });

  it('redacts prompt/error/raw-answer logs, including the key actually resolved from a key file', async () => {
    const key = path.join(home, 'fixture.key'); put(key, 'FILE_SECRET\n');
    put(globalFile(), JSON.stringify({ keyFilePath: key, projects: { '/unused': { apiKey: 'NESTED_SECRET' } } }));
    let authorization = '';
    const transport = (async (_url, init) => {
      authorization = String((init?.headers as any).Authorization);
      return Response.json(responseFor(JSON.parse(String(init?.body))));
    }) as typeof fetch;
    const nav = new JevNavigator(root, {}, home, transport);
    await nav.evaluatePrompt('Never echo FILE_SECRET or NESTED_SECRET', [], { sessionId: 'safe' }, { skills: [] });
    expect(authorization).toBe('Bearer FILE_SECRET');
    nav.logDecisionToFile('FILE_SECRET NESTED_SECRET', {
      bypassed: true, bypassReason: 'transport error mentions FILE_SECRET',
    }, { sessionId: 'safe' });
    nav.logDecisionToFile('ordinary prompt', {
      rawAnswers: { extra: { apiKey: 'REMOTE_SECRET', echoed: 'REMOTE_SECRET' } } as any,
    }, { sessionId: 'safe' });
    const slug = `--${root.replace(/^\/+/, '').replace(/\/+/g, '-')}--`;
    const log = fs.readFileSync(path.join(home, '.pi/agent/jev-sessions', slug, 'safe.jsonl'), 'utf8');
    for (const secret of ['FILE_SECRET', 'NESTED_SECRET', 'REMOTE_SECRET']) expect(log).not.toContain(secret);
    expect(log).toContain('[REDACTED]');
    expect(log).toContain('ordinary prompt');
    expect(nav.getConfig().projects).toEqual({ '/unused': { apiKey: 'NESTED_SECRET' } });
  });

  it('handles cycles, shared objects and regex metacharacters without mutating the input', () => {
    const shared = { value: 'literal.*[secret]' };
    const original: any = { visible: shared, apiKey: shared, aliases: [shared], plain: 'keep metadata', input_tokens: 123 };
    original.cycle = original;
    const redacted = redactSensitive(original) as any;
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('literal.*[secret]');
    expect(redacted.visible.value).toBe('[REDACTED]');
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.cycle).toBe('[Circular]');
    expect(redacted.plain).toBe('keep metadata');
    expect(redacted.input_tokens).toBe(123);
    expect(shared.value).toBe('literal.*[secret]');
    expect(original.cycle).toBe(original);
    expect(sensitiveValues(original)).toEqual(['literal.*[secret]']);
  });

  it('redacts known secrets in object keys and non-sensitive field echoes as literal strings', () => {
    const original = { 'project-FAKE_SECRET': { apiKey: 'FAKE_SECRET', model: 'before-FAKE_SECRET-after' } };
    const text = JSON.stringify(redactSensitive(original));
    expect(text).not.toContain('FAKE_SECRET');
    expect(text).toContain('before-[REDACTED]-after');
    expect(original['project-FAKE_SECRET'].apiKey).toBe('FAKE_SECRET');
  });
});
