import { describe, expect, it, mock } from 'bun:test';
import register, { type JevNavigator } from '../src/index.ts';
import { transformNavigationContext } from '../src/injector/context-transform.ts';
import type { DispatchDecision, JevNavigatorConfig } from '../src/types.ts';
import { redactSensitive } from '../src/config/redact.ts';

const tag = (name: string, content: string) => '<' + name + '>' + content + '</' + name + '>';
const catalog = tag('skills', tag('available_skills', tag('skill', tag('name', 'fixture') + tag('location', '/fixture/SKILL.md'))));
const config: JevNavigatorConfig = { enableTailInjection: true, enableSystemPromptPruning: true, enableSkills: true };
const decision = (name = 'fixture'): DispatchDecision => ({
  targetSubsystems: [name], activatedSkill: name, activatedSkillPath: `/skills/${name}/SKILL.md`, latencyMs: 1,
});
function messages(): any[] {
  return [
    { role: 'system', content: '', sections: { skills: catalog, instructions: 'Preserve ' + catalog }, toolsAdded: [{ description: catalog }], timestamp: 0 },
    { role: 'user', content: 'Explain this XML: ' + catalog, timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'write', arguments: { content: catalog } }], timestamp: 2 },
    { role: 'toolResult', content: [{ type: 'text', text: catalog }], timestamp: 3 },
  ];
}
function context(id = 'session-a'): any {
  return { cwd: '/fixture/repo', hasUI: false, sessionManager: { getSessionId: () => id }, ui: { notify: mock(), setWorkingMessage: mock(), setStatus: mock() } };
}
function harness(options: { cfg?: JevNavigatorConfig; hasKey?: boolean; evaluate?: (...args: any[]) => Promise<DispatchDecision | null> } = {}) {
  const events = new Map<string, any[]>();
  const commands: Record<string, any> = {};
  const nav = {
    hasApiKey: () => options.hasKey !== false,
    getConfig: () => ({ ...config, ...options.cfg }),
    getConfigForDisplay: () => redactSensitive({ ...config, ...options.cfg }),
    getConfigStore: () => ({ getDiagnostics: () => [] }),
    getStatus: () => { throw new Error('expensive status must not run during hooks'); },
    evaluatePrompt: mock(options.evaluate ?? (async () => decision())),
  };
  register({
    on(name: string, handler: any) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerCommand(name: string, command: any) { commands[name] = command; },
  } as any, () => nav as unknown as JevNavigator);
  return {
    nav, events, commands,
    async emit(name: string, event: any = {}, ctx = context()) {
      let result: any;
      for (const handler of events.get(name) ?? []) result = await handler(event, ctx) ?? result;
      return result;
    },
  };
}

 describe('request-local navigation transform', () => {
  it('preserves system sections 100% untouched and appends guidance to user message', () => {
    const original = messages();
    const snapshot = structuredClone(original);
    const output = transformNavigationContext(original as any, decision(), config);
    expect(original).toEqual(snapshot);
    expect(output[0].sections?.skills).toBe(catalog);
    expect((output[0] as any).sections.instructions).toBe('Preserve ' + catalog);
    expect((output[0] as any).toolsAdded).toEqual(snapshot[0].toolsAdded);
    expect(output[2]).toEqual(snapshot[2]);
    expect(output[3]).toEqual(snapshot[3]);
    expect((output[1] as any).content.startsWith(snapshot[1].content)).toBe(true);
    expect((output[1] as any).content).toContain('/skills/fixture/SKILL.md');
    expect(transformNavigationContext(output, decision(), config)).toEqual(output);
  });

  it('uses a static skill section across decisions and preserves opaque non-system text', () => {
    const original = messages();
    original[0] = { role: 'system', content: 'prefix ' + catalog + ' suffix', timestamp: 0 };
    const first = transformNavigationContext(original as any, decision('first'), config);
    const second = transformNavigationContext(original as any, decision('second'), config);
    expect(first[0]).toEqual(second[0]);
    expect(first[2]).toEqual(original[2]);
    expect(first[3]).toEqual(original[3]);
  });

  it('appends a text part after images without modifying existing user parts', () => {
    const original = messages();
    original[1].content = [{ type: 'text', text: 'image task ' + catalog }, { type: 'image', data: 'fixture', mimeType: 'image/png' }];
    const output = transformNavigationContext(original as any, decision(), config);
    expect((output[1] as any).content.slice(0, 2)).toEqual(original[1].content);
    expect((output[1] as any).content[2].type).toBe('text');
    expect(transformNavigationContext(output, decision(), config)).toEqual(output);
  });

  it('preserves native context on failure, disabled tail, disabled pruning or disabled skills', () => {
    const original = messages();
    expect(transformNavigationContext(original as any, null, config)).toBe(original);
    expect(transformNavigationContext(original as any, { bypassed: true }, config)).toBe(original);
    expect(transformNavigationContext(original as any, decision(), { ...config, enableTailInjection: false })).toBe(original);
    for (const cfg of [{ ...config, enableSystemPromptPruning: false }, { ...config, enableSkills: false }]) {
      const output = transformNavigationContext(original as any, decision(), cfg);
      expect(output[0]).toEqual(original[0]);
      expect((output[1] as any).content).toContain('System One Navigation Context');
    }
  });
});

describe('Pi lifecycle integration', () => {
  it('does not register any provider payload mutation or per-tool-turn cleanup', () => {
    const h = harness();
    expect(h.events.has('before_provider_request')).toBe(false);
    expect(h.events.has('turn_end')).toBe(false);
    expect(h.events.has('agent_end')).toBe(false);
  });

  it('keeps guidance through tool batches and recovery, and cleans up on final settle', async () => {
    const h = harness();
    expect(await h.emit('before_agent_start', { prompt: 'task', systemPrompt: catalog })).toBeUndefined();
    const first = await h.emit('context_with_system', { messages: messages() });
    await h.emit('turn_end'); await h.emit('agent_end');
    const second = await h.emit('context_with_system', { messages: messages() });
    expect(first.messages).toEqual(second.messages);
    await h.emit('agent_settled');
    expect(await h.emit('context_with_system', { messages: messages() })).toBeUndefined();
  });

  it('fails open for missing key, thrown error, null, bypass object and disabled tail', async () => {
    const scenarios = [
      { hasKey: false },
      { evaluate: async () => { throw new Error('offline'); } },
      { evaluate: async () => null },
      { evaluate: async () => ({ bypassed: true }) },
      { cfg: { enableTailInjection: false } },
    ];
    for (const scenario of scenarios) {
      const h = harness(scenario);
      await h.emit('session_start');
      await h.emit('before_agent_start', { prompt: 'task', systemPrompt: catalog });
      const original = messages();
      expect(await h.emit('context_with_system', { messages: original })).toBeUndefined();
      expect(original).toEqual(messages());
    }
  });

  it('isolates sessions, ignores superseded asynchronous results, and clears on shutdown', async () => {
    let resolveOld!: (value: DispatchDecision) => void;
    const h = harness({ evaluate: async (prompt) => prompt === 'old'
      ? await new Promise<DispatchDecision>((resolve) => { resolveOld = resolve; }) : decision(prompt) });
    const a = context('a'); const b = context('b');
    const pending = h.emit('before_agent_start', { prompt: 'old' }, a);
    await h.emit('before_agent_start', { prompt: 'new' }, a);
    await h.emit('before_agent_start', { prompt: 'other-session' }, b);
    resolveOld(decision('old')); await pending;
    const outputA = await h.emit('context_with_system', { messages: messages() }, a);
    const outputB = await h.emit('context_with_system', { messages: messages() }, b);
    expect(outputA.messages[1].content).toContain('/skills/new/SKILL.md');
    expect(outputA.messages[1].content).not.toContain('/skills/old/SKILL.md');
    expect(outputB.messages[1].content).toContain('/skills/other-session/SKILL.md');
    await h.emit('session_shutdown', {}, a);
    expect(await h.emit('context_with_system', { messages: messages() }, a)).toBeUndefined();
    expect(await h.emit('context_with_system', { messages: messages() }, b)).toBeDefined();
  });

  it('uses the host catalog, skips manual-only skills and does not reuse guidance for steering', async () => {
    const h = harness();
    const ctx = context();
    await h.emit('before_agent_start', { prompt: 'task', systemPromptOptions: { skills: [
      { name: 'custom', description: 'all custom metadata', filePath: '/custom/SKILL.md', disableModelInvocation: false },
      { name: 'manual', description: 'manual only', filePath: '/manual/SKILL.md', disableModelInvocation: true },
    ] } }, ctx);
    expect(h.nav.evaluatePrompt.mock.calls[0][3].skills).toEqual([{ name: 'custom', description: 'all custom metadata', path: '/custom/SKILL.md' }]);
    await h.emit('context_with_system', { messages: messages() }, ctx);
    const updated = messages(); updated.push({ role: 'user', content: 'different steering request', timestamp: 10 });
    expect(await h.emit('context_with_system', { messages: updated }, ctx)).toBeUndefined();
  });

  it('shows actual per-track usage in runtime notifications and explicit evaluation', async () => {
    const h = harness({ evaluate: async () => ({
      ...decision(), pipelineMode: 'parallel', inputTokens: 300,
      tokenBreakdown: { overviewTokens: 100, catalogTokens: 200, totalTokens: 300, overviewRequests: 1, catalogRequests: 2, totalRequests: 3 },
    }) });
    const ctx = context(); ctx.hasUI = true;
    await h.emit('before_agent_start', { prompt: 'task' }, ctx);
    await h.commands['jev-eval'].handler('task', ctx);
    for (const call of ctx.ui.notify.mock.calls) {
      expect(call[0]).toContain('Track A (Overview)');
      expect(call[0]).toContain('Track B (Skills + Mem)');
      expect(call[0]).toContain('(Parallel)');
      expect(call[0]).toContain('aggregate, 2 requests');
    }
    expect(ctx.ui.notify.mock.calls).toHaveLength(2);
  });

  it('redacts the API key from the config command', async () => {
    const h = harness({ cfg: { apiKey: 'FAKE_SECRET' } });
    const ctx = context();
    await h.commands['jev-config'].handler('', ctx);
    const text = ctx.ui.notify.mock.calls[0][0];
    expect(text).not.toContain('FAKE_SECRET');
    expect(text).toContain('[REDACTED]');
  });

  it('preserves systemPromptOptions.skills 100% static in before_agent_start to protect LCP cache', async () => {
    // 1. When activated skill matches -> systemPromptOptions.skills must remain untouched
    const h1 = harness({ evaluate: async () => decision('skill-a') });
    const ev1: any = {
      prompt: 'task',
      systemPromptOptions: {
        skills: [
          { name: 'skill-a', description: 'desc a', filePath: '/a/SKILL.md' },
          { name: 'skill-b', description: 'desc b', filePath: '/b/SKILL.md' },
        ],
      },
    };
    await h1.emit('before_agent_start', ev1, context());
    expect(ev1.systemPromptOptions.skills.map((s: any) => s.name)).toEqual(['skill-a', 'skill-b']);

    // 2. When no skill is activated -> systemPromptOptions.skills must remain untouched
    const h2 = harness({ evaluate: async () => ({ ...decision(), activatedSkill: undefined }) });
    const ev2: any = {
      prompt: 'task',
      systemPromptOptions: {
        skills: [
          { name: 'skill-a', description: 'desc a', filePath: '/a/SKILL.md' },
          { name: 'skill-b', description: 'desc b', filePath: '/b/SKILL.md' },
        ],
      },
    };
    await h2.emit('before_agent_start', ev2, context());
    expect(ev2.systemPromptOptions.skills.map((s: any) => s.name)).toEqual(['skill-a', 'skill-b']);
  });
});
