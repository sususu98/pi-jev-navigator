import { describe, expect, it, mock } from 'bun:test';
import register, { type JevNavigator } from '../src/index.ts';
import { transformNavigationContext } from '../src/injector/context-transform.ts';
import type { DispatchDecision, JevNavigatorConfig } from '../src/types.ts';
import { redactSensitive } from '../src/config/redact.ts';
import { TailInjector } from '../src/injector/tail-injector.ts';

const tag = (name: string, content: string) => '<' + name + '>' + content + '</' + name + '>';
const catalog = tag('skills', tag('available_skills', tag('skill', tag('name', 'fixture') + tag('location', '/fixture/SKILL.md'))));
const config: JevNavigatorConfig = { enableTailInjection: true, enableSkills: true };
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
    warmKeywordPath: mock(() => true),
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

  it('preserves native context on failure, disabled tail or disabled skills', () => {
    const original = messages();
    expect(transformNavigationContext(original as any, null, config)).toBe(original);
    expect(transformNavigationContext(original as any, { bypassed: true }, config)).toBe(original);
    expect(transformNavigationContext(original as any, decision(), { ...config, enableTailInjection: false })).toBe(original);
    for (const cfg of [{ ...config, enableSkills: false }]) {
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

  it('keeps guidance through tool batches, recovery and historical replay after final settle', async () => {
    const h = harness();
    expect(await h.emit('before_agent_start', { prompt: 'task', systemPrompt: catalog })).toBeUndefined();
    const first = await h.emit('context_with_system', { messages: messages() });
    await h.emit('turn_end'); await h.emit('agent_end');
    const second = await h.emit('context_with_system', { messages: messages() });
    expect(first.messages).toEqual(second.messages);
    await h.emit('agent_settled');
    const historical = await h.emit('context_with_system', { messages: messages() });
    expect(historical.messages).toEqual(first.messages);
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
    const first = await h.emit('context_with_system', { messages: messages() }, ctx);
    const updated = messages(); updated.push({ role: 'user', content: 'different steering request', timestamp: 10 });
    const steered = await h.emit('context_with_system', { messages: updated }, ctx);
    expect(steered.messages[1]).toEqual(first.messages[1]);
    expect(steered.messages[4]).toEqual(updated[4]);
  });

  it('observes terminal input to warm the keyword path without consuming keystrokes', async () => {
    const h = harness();
    const ctx = context(); ctx.hasUI = true;
    const unsubscribe = mock();
    let handler: any;
    ctx.ui.onTerminalInput = mock((fn: any) => { handler = fn; return unsubscribe; });
    await h.emit('session_start', {}, ctx);
    expect(ctx.ui.onTerminalInput).toHaveBeenCalledTimes(1);
    expect(handler('a')).toBeUndefined();
    expect(h.nav.warmKeywordPath).toHaveBeenCalledTimes(1);
    await h.emit('session_start', {}, ctx); // reload replaces, never stacks listeners
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await h.emit('session_shutdown', {}, ctx);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    h.nav.warmKeywordPath.mockImplementation(() => { throw new Error('boom'); });
    expect(handler('b')).toBeUndefined();
  });

  it('passes active branch context independently to normal and steering routing', async () => {
    const h = harness();
    const ctx = context();
    (ctx.sessionManager as any).getBranch = () => [
      { type: 'message', message: { role: 'user', content: 'Implement Orchid capsule' } },
      { type: 'message', message: { role: 'toolResult', content: 'PRIVATE_TOOL_BODY' } },
    ];
    await h.emit('before_agent_start', { prompt: 'continue' }, ctx);
    await h.emit('input', { text: 'fix the tenant boundary', streamingBehavior: 'steer' }, ctx);
    (ctx.sessionManager as any).getBranch = () => [{ type: 'message', message: { role: 'user', content: 'OTHER_BRANCH_TOPIC' } }];
    for (const call of h.nav.evaluatePrompt.mock.calls) {
      expect(call[3].recentContext).toEqual([{ role: 'user', text: 'Implement Orchid capsule' }]);
      expect(JSON.stringify(call[3])).not.toContain('PRIVATE_TOOL_BODY');
    }
    expect(h.nav.evaluatePrompt.mock.calls[0][0]).toBe('continue');
    expect(h.nav.evaluatePrompt.mock.calls[1][0]).toBe('fix the tenant boundary');
  });

  it('shows actual per-track usage in runtime notifications and explicit evaluation', async () => {
    const h = harness({ evaluate: async () => ({
      ...decision(), pipelineMode: 'parallel', inputTokens: 300,
      tokenBreakdown: { overviewTokens: 100, catalogTokens: 200, totalTokens: 300, overviewRequests: 1, catalogRequests: 2, totalRequests: 3 },
    }) });
    const ctx = context(); ctx.hasUI = true;
    await h.emit('before_agent_start', { prompt: 'task' }, ctx);
    await h.emit('context_with_system', { messages: messages() }, ctx);
    await h.commands['jev-eval'].handler('task', ctx);
    const telemetryCalls = ctx.ui.notify.mock.calls.map((c: any[]) => c[0]).filter((text: string) => text.includes('Track A'));
    for (const text of telemetryCalls) {
      expect(text).toContain('Track A (Overview)');
      expect(text).toContain('Track B (Skills + Mem)');
      expect(text).toContain('(Parallel)');
      expect(text).toContain('aggregate, 2 requests');
    }
    expect(telemetryCalls).toHaveLength(2);
  });

  it('shows every selected SOP path in explicit evaluation and honors an authoritative empty set', async () => {
    let routed: DispatchDecision = { activatedSkills: [
      { name: 'first', description: 'Fixture procedure', path: '/fixture/first/SKILL.md' },
      { name: 'second', description: 'Fixture verification', path: '/fixture/second/SKILL.md' },
    ], activatedSkill: 'first' };
    const h = harness({ evaluate: async () => routed });
    const ctx = context();
    await h.commands['jev-eval'].handler('task', ctx);
    expect(ctx.ui.notify.mock.calls[0][0]).toContain('/fixture/first/SKILL.md');
    expect(ctx.ui.notify.mock.calls[0][0]).toContain('/fixture/second/SKILL.md');
    routed = { activatedSkills: [], activatedSkill: 'stale' };
    await h.commands['jev-eval'].handler('task', ctx);
    expect(ctx.ui.notify.mock.calls[1][0]).toContain('Skills: None');
    expect(ctx.ui.notify.mock.calls[1][0]).not.toContain('stale');
  });

  it('displays the exact injected tail once, with full memory and SOP paths, and separate telemetry', async () => {
    const routed: DispatchDecision = {
      ...decision(), riskScore: 0.62, inputTokens: 8500,
      activatedSkills: [
        { name: 'fixture', description: 'Fixture procedure', path: '/skills/fixture/SKILL.md' },
        { name: 'verify-fixture', description: 'Fixture verification', path: '/skills/verify-fixture/SKILL.md' },
      ],
      activatedMemoryGuards: [{
        id: 'guard', category: 'correction', title: 'A title that must not replace the actual constraint',
        summary: 'Complete constraint beyond thirty characters.\nSecond line must also be visible.', rule: 'full rule',
      }],
      memoryRetrieval: {
        source: 'hermes-sqlite', status: 'ready', eligible: 553, retrieved: 5, candidates: 5, selected: 1,
        latencyMs: 46, estimatedTokens: 1500, queries: 2, budgetLimited: false,
      },
    };
    const h = harness({ evaluate: async () => routed });
    const ctx = context(); ctx.hasUI = true;
    await h.emit('before_agent_start', { prompt: 'task' }, ctx);
    expect(ctx.ui.notify.mock.calls).toHaveLength(0);
    const original = messages();
    const result = await h.emit('context_with_system', { messages: original }, ctx);
    const modelTail = result.messages[1].content.slice(original[1].content.length);
    expect(modelTail).toBe(new TailInjector().formatTailGuidance(routed));
    const [display, level] = ctx.ui.notify.mock.calls[0];
    expect(level).toBe('info');
    expect(display.slice(0, modelTail.length)).toBe(modelTail);
    const telemetry = display.slice(modelTail.length);
    expect(telemetry).toStartWith('\n\nJev Telemetry:');
    expect(telemetry).toContain('553 eligible → 5 candidates → 1 selected');
    expect(telemetry).not.toContain('Memory: Memory:');
    expect(telemetry).not.toContain('Guard:');
    expect(modelTail).toContain('/skills/fixture/SKILL.md');
    expect(modelTail).toContain('/skills/verify-fixture/SKILL.md');
    expect(modelTail).toContain(routed.activatedMemoryGuards![0].summary);
    expect(modelTail).not.toContain('eligible');
    expect(modelTail).not.toContain('Input Tokens');
    await h.emit('context_with_system', { messages: original }, ctx);
    await h.emit('context_with_system', { messages: result.messages }, ctx);
    expect(ctx.ui.notify.mock.calls).toHaveLength(1);
    expect(original).toEqual(messages());
  });

  it('displays multimodal tails identically and keeps UI failures out of model context', async () => {
    const h = harness(); const ctx = context(); ctx.hasUI = true;
    await h.emit('before_agent_start', { prompt: 'image task' }, ctx);
    const original = messages();
    original[1].content = [{ type: 'image', data: 'fixture', mimeType: 'image/png' }, { type: 'text', text: 'image task' }];
    const result = await h.emit('context_with_system', { messages: original }, ctx);
    const modelTail = result.messages[1].content[2].text;
    expect(ctx.ui.notify.mock.calls[0][0].slice(0, modelTail.length)).toBe(modelTail);
    expect(result.messages[1].content.slice(0, 2)).toEqual(original[1].content);

    const broken = harness(); const brokenCtx = context(); brokenCtx.hasUI = true;
    await broken.emit('before_agent_start', { prompt: 'task' }, brokenCtx);
    brokenCtx.ui.notify = mock(() => { throw new Error('UI unavailable'); });
    const output = await broken.emit('context_with_system', { messages: messages() }, brokenCtx);
    expect(output.messages[1].content).toContain('/skills/fixture/SKILL.md');
    expect(await broken.emit('context_with_system', { messages: messages() }, brokenCtx)).toEqual(output);
    expect(brokenCtx.ui.notify.mock.calls).toHaveLength(1);
  });

  it('does not display nonexistent tails and binds initial guidance before first-request steering', async () => {
    for (const options of [{ hasKey: false }, { evaluate: async () => null }, { evaluate: async () => ({ bypassed: true }) }]) {
      const h = harness(options); const ctx = context(); ctx.hasUI = true;
      await h.emit('before_agent_start', { prompt: 'task' }, ctx);
      await h.emit('context_with_system', { messages: messages() }, ctx);
      expect(ctx.ui.notify.mock.calls).toHaveLength(0);
    }
    const h = harness(); const ctx = context(); ctx.hasUI = true;
    await h.emit('before_agent_start', { prompt: 'task' }, ctx);
    await h.emit('message_end', { message: messages()[1] }, ctx);
    const steered = messages(); steered.push({ role: 'user', content: 'steering', timestamp: 10 });
    await h.emit('context_with_system', { messages: steered }, ctx);
    expect(ctx.ui.notify.mock.calls).toHaveLength(1); // initial user's tail, never steering's
    expect(ctx.ui.notify.mock.calls[0][0]).toContain('/skills/fixture/SKILL.md');
    ctx.signal = AbortSignal.abort();
    await h.emit('context_with_system', { messages: messages() }, ctx);
    expect(ctx.ui.notify.mock.calls).toHaveLength(1);
  });

  it('redacts the API key from the config command', async () => {
    const h = harness({ cfg: { apiKey: 'FAKE_SECRET' } });
    const ctx = context();
    await h.commands['jev-config'].handler('', ctx);
    const text = ctx.ui.notify.mock.calls[0][0];
    expect(text).not.toContain('FAKE_SECRET');
    expect(text).toContain('[REDACTED]');
  });

  it('applies a fixed native skill-catalog policy independently of routing decisions', async () => {
    // 1. When activated skill matches -> systemPromptOptions.skills is emptied to keep system prompt 100% static
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
    expect(ev1.systemPromptOptions.skills).toEqual([]);

    // 2. When no skill is activated -> natively filters to empty array
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
    expect(ev2.systemPromptOptions.skills).toEqual([]);

    // 3. When skills disabled via config (enableSkills: false) -> skills preserved untouched
    const h3 = harness({ cfg: { enableSkills: false }, evaluate: async () => decision('skill-a') });
    const ev3: any = {
      prompt: 'task',
      systemPromptOptions: {
        skills: [
          { name: 'skill-a', description: 'desc a', filePath: '/a/SKILL.md' },
          { name: 'skill-b', description: 'desc b', filePath: '/b/SKILL.md' },
        ],
      },
    };
    await h3.emit('before_agent_start', ev3, context());
    expect(ev3.systemPromptOptions.skills.map((s: any) => s.name)).toEqual(['skill-a', 'skill-b']);
  });
});
