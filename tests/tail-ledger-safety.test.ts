import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import register from '../src/index.ts';
import { NavigationTailLedger, NAVIGATION_TAIL_ENTRY } from '../src/injector/tail-ledger.ts';

let temp: string;
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-tail-native-')); });
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function runtime(manager: SessionManager, evaluate = async (_p: string): Promise<any> => ({ activatedSkill: 'fixture-sop', activatedSkillPath: '/fixture/SKILL.md', latencyMs: 1 })) {
  const events = new Map<string, any[]>();
  const appends: any[] = [];
  const api = {
    on(name: string, fn: any) { events.set(name, [...(events.get(name) ?? []), fn]); },
    registerCommand() {}, registerFlag() {},
    appendEntry(type: string, data: unknown) { appends.push(data); manager.appendCustomEntry(type, data); },
  };
  const nav = { hasApiKey: () => true, getConfig: () => ({ enableTailInjection: true }),
    getConfigStore: () => ({ getDiagnostics: () => [] }), evaluatePrompt: evaluate };
  register(api as any, () => nav as any);
  const ctx: any = { cwd: temp, hasUI: false, sessionManager: manager };
  return { api, ctx, appends, async emit(name: string, event: any = {}) {
    let result: any;
    for (const fn of events.get(name) ?? []) result = await fn(event, ctx) ?? result;
    return result;
  } };
}
const rawMessages = (manager: SessionManager): any[] => manager.getBranch()
  .filter(e => e.type === 'message').map((e: any) => structuredClone(e.message));

 describe('native SessionManager wire-history safety', () => {
  it('keeps the entire skill/SOP/tool history prefix identical across runs and disk resume', async () => {
    const manager = SessionManager.create(temp, path.join(temp, 'sessions'));
    manager.appendMessage({ role: 'system', content: '', sections: { skills: 'fixed catalog' }, timestamp: 1 } as any);
    const user: any = { role: 'user', content: [{ type: 'text', text: 'Read the recommended SOP and inspect the module' }], timestamp: 2 };
    const userId = manager.appendMessage(user);
    const h = runtime(manager);
    await h.emit('before_agent_start', { prompt: user.content[0].text });
    await h.emit('message_end', { message: user });
    await h.emit('context_with_system', { messages: rawMessages(manager) });
    // Simulate a complete SOP read plus a long tool trajectory after the injected skill.
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'read-sop', name: 'read', arguments: { path: '/fixture/SKILL.md' } }], timestamp: 3 } as any);
    manager.appendMessage({ role: 'toolResult', toolCallId: 'read-sop', toolName: 'read', content: [{ type: 'text', text: 'Full immutable SOP instructions\n'.repeat(3000) }], isError: false, timestamp: 4 } as any);
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'SOP applied; task finished' }], timestamp: 5 } as any);
    const finalFirst = await h.emit('context_with_system', { messages: rawMessages(manager) });
    await h.emit('agent_settled');
    const next: any = { role: 'user', content: 'Next task, keep prior work', timestamp: 6 };
    manager.appendMessage(next);
    await h.emit('before_agent_start', { prompt: next.content });
    await h.emit('message_end', { message: next });
    const second = await h.emit('context_with_system', { messages: rawMessages(manager) });
    expect(JSON.stringify(second.messages.slice(0, finalFirst.messages.length))).toBe(JSON.stringify(finalFirst.messages));
    expect((manager.getEntry(userId) as any).message).toEqual(user);
    const file = manager.getSessionFile()!;
    const stored = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(stored.find(e => e.id === userId).message).toEqual(user);
    expect(stored.some(e => e.type === 'custom' && e.customType === NAVIGATION_TAIL_ENTRY)).toBe(true);
    const resumed = SessionManager.open(file, path.join(temp, 'sessions'));
    const h2 = runtime(resumed, async () => { throw new Error('No re-evaluation on resume'); });
    await h2.emit('session_start');
    const replay = await h2.emit('context_with_system', { messages: rawMessages(resumed) });
    expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(second.messages));
  });

  it('freezes no-tail decisions so retries cannot backfill navigation into an old user', async () => {
    const manager = SessionManager.inMemory(temp);
    const user: any = { role: 'user', content: 'First evaluation bypassed', timestamp: 2 };
    manager.appendMessage(user);
    let succeed = false;
    const h = runtime(manager, async () => succeed ? { activatedSkill: 'later-skill', latencyMs: 2 } : null);
    await h.emit('before_agent_start', { prompt: user.content });
    expect(await h.emit('context_with_system', { messages: rawMessages(manager) })).toBeUndefined();
    succeed = true;
    await h.emit('before_agent_start', { prompt: user.content });
    const retried = await h.emit('context_with_system', { messages: rawMessages(manager) });
    expect(retried.messages[0]).toEqual(user);
    expect(h.appends).toHaveLength(1);
    expect(h.appends[0].guidance).toBe('');
  });

  it('replays historical tails during cancelled/idle contexts without new routing', async () => {
    const manager = SessionManager.inMemory(temp);
    const user: any = { role: 'user', content: 'Keep cached SOP', timestamp: 2 };
    manager.appendMessage(user);
    const h = runtime(manager);
    await h.emit('before_agent_start', { prompt: user.content });
    const first = await h.emit('context_with_system', { messages: rawMessages(manager) });
    await h.emit('agent_settled');
    h.ctx.signal = AbortSignal.abort();
    const idle = await h.emit('context_with_system', { messages: rawMessages(manager) });
    expect(idle.messages).toEqual(first.messages);
    expect(h.appends).toHaveLength(1);
  });

  it('uses native entry provenance for identical user text and timestamps within a branch', async () => {
    const manager = SessionManager.inMemory(temp);
    const user: any = { role: 'user', content: 'same task', timestamp: 2 };
    manager.appendMessage(user);
    let round = 1;
    const h = runtime(manager, async () => ({ activatedSkill: `sop-${round}`, latencyMs: round }));
    await h.emit('before_agent_start', { prompt: user.content });
    const first = await h.emit('context_with_system', { messages: rawMessages(manager) });
    await h.emit('agent_settled');
    manager.appendMessage(user); round = 2;
    await h.emit('before_agent_start', { prompt: user.content });
    const second = await h.emit('context_with_system', { messages: rawMessages(manager) });
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.messages[1].content).toContain('sop-2');
    expect(second.messages[1].content).not.toContain('sop-1');
  });

  it('does not leak an active decision into an identical prompt on another branch', async () => {
    const manager = SessionManager.inMemory(temp);
    const rootId = manager.appendMessage({ role: 'system', content: 'root', timestamp: 1 } as any);
    const user: any = { role: 'user', content: 'identical alternative', timestamp: 2 };
    manager.appendMessage(user);
    const h = runtime(manager);
    await h.emit('before_agent_start', { prompt: user.content });
    const first = await h.emit('context_with_system', { messages: rawMessages(manager) });
    const branchA = manager.getLeafId()!;
    manager.branch(rootId); manager.appendMessage(user);
    const second = await h.emit('context_with_system', { messages: rawMessages(manager) });
    expect(second.messages[1]).toEqual(user);
    expect(h.appends).toHaveLength(1);
    manager.branch(branchA);
    const restored = await h.emit('context_with_system', { messages: rawMessages(manager) });
    expect(restored.messages).toEqual(first.messages);
  });

  it('keeps multimodal bindings stable across object-key ordering without rewriting content', async () => {
    const manager = SessionManager.inMemory(temp);
    const user: any = { role: 'user', content: [
      { type: 'text', text: 'Inspect diagram' }, { type: 'image', data: 'fixture', mimeType: 'image/png' },
    ], timestamp: 2 };
    manager.appendMessage(user);
    const h = runtime(manager);
    await h.emit('before_agent_start', { prompt: 'Inspect diagram' });
    const first = await h.emit('context_with_system', { messages: rawMessages(manager) });
    await h.emit('agent_settled');
    const reordered: any = [{ ...user, content: [
      { text: 'Inspect diagram', type: 'text' }, { mimeType: 'image/png', data: 'fixture', type: 'image' },
    ] }];
    const second = await h.emit('context_with_system', { messages: reordered });
    expect(second.messages[0].content.slice(0, 2)).toEqual(reordered[0].content);
    expect(second.messages[0].content[2]).toEqual(first.messages[0].content[2]);
    expect(h.appends).toHaveLength(1);
  });

  it('does not publish transient tails or add them later after metadata persistence fails', () => {
    const manager = SessionManager.inMemory(temp);
    const user: any = { role: 'user', content: 'No durable write available', timestamp: 2 };
    manager.appendMessage(user);
    let fail = true;
    const ledger = new NavigationTailLedger({ appendEntry(type: string, data: unknown) {
      if (fail) throw new Error('read-only session');
      manager.appendCustomEntry(type, data);
    } } as any);
    const ctx: any = { sessionManager: manager };
    const input: any = [user];
    expect(ledger.replay(input, ctx, 'session', { index: 0, guidance: 'TAIL' })).toBe(input);
    fail = false;
    expect(ledger.replay(input, ctx, 'session', { index: 0, guidance: 'TAIL' })).toBe(input);
    expect(manager.getBranch().filter(e => e.type === 'custom')).toHaveLength(0);
  });

  it('binds the initial user before a steering message arrives ahead of first request', async () => {
    const manager = SessionManager.inMemory(temp);
    const first: any = { role: 'user', content: 'Initial task', timestamp: 2 };
    manager.appendMessage(first);
    const h = runtime(manager);
    await h.emit('before_agent_start', { prompt: first.content });
    await h.emit('message_end', { message: first });
    const steering: any = { role: 'user', content: 'Do something else', timestamp: 3 };
    manager.appendMessage(steering);
    await h.emit('message_end', { message: steering });
    const result = await h.emit('context_with_system', { messages: rawMessages(manager) });
    expect(result.messages[1]).toEqual(steering);
    expect(JSON.stringify(result.messages)).not.toContain('fixture-sop');
  });
});
