import { describe, expect, it } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { SessionSkillPolicy, SKILL_POLICY_ENTRY } from '../src/injector/skill-policy.ts';
import { registerRuntimeHooks } from '../src/runtime.ts';

// Exercise the installed host's actual renderer, not a hand-written prompt fixture.
const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await import(
  new URL('./core/system-prompt.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href
);
const skills = [{ name: 'fixture', description: 'Fixture SOP', filePath: '/fixture/SKILL.md', baseDir: '/fixture' }];
const options = () => normalizeBuildSystemPromptOptions({ cwd: '/fixture', selectedTools: ['read'], skills });
function harness(manager = SessionManager.inMemory('/fixture')) {
  const handlers = new Map<string, any>();
  let cfg: any = { enableSkills: true, enableTailInjection: true };
  let hasKey = true;
  let evaluate: any = async () => ({ activatedSkill: 'fixture', activatedSkillPath: '/fixture/SKILL.md' });
  const api: any = {
    on(name: string, handler: any) { handlers.set(name, handler); }, registerFlag() {},
    appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
  };
  const nav: any = { getConfig: () => cfg, hasApiKey: () => hasKey,
    getConfigStore: () => ({ getDiagnostics: () => [] }), evaluatePrompt: (...args: any[]) => evaluate(...args) };
  registerRuntimeHooks(api, () => nav);
  const ctx: any = { cwd: '/fixture', hasUI: false, sessionManager: manager };
  return { manager, api, ctx,
    setConfig(value: any) { cfg = value; }, setKey(value: boolean) { hasKey = value; },
    setEvaluate(value: any) { evaluate = value; },
    emit(name: string, event: any = {}) { return handlers.get(name)?.(event, ctx); },
    async prompt(text = 'task') {
      const event = { prompt: text, systemPromptOptions: options() };
      await handlers.get('before_agent_start')(event, ctx);
      return event;
    },
  };
}

describe('session-invariant native skill policy', () => {
  it('renders identical system bytes through success, missing key, exceptions, null, bypass and disabled routing', async () => {
    const h = harness();
    const first = await h.prompt();
    const system = buildSystemPrompt(first.systemPromptOptions);
    expect(first.systemPromptOptions.skills).toEqual([]);
    const scenarios = [
      () => h.setKey(false),
      () => { h.setKey(true); h.setEvaluate(async () => { throw new Error('offline'); }); },
      () => h.setEvaluate(async () => null),
      () => h.setEvaluate(async () => ({ bypassed: true })),
      () => h.setConfig({ enableSkills: false, enableTailInjection: false }),
    ];
    for (const scenario of scenarios) {
      scenario();
      const next = await h.prompt();
      expect(next.systemPromptOptions.skills).toEqual([]);
      expect(buildSystemPrompt(next.systemPromptOptions)).toBe(system);
      // The host rebuilds options between tool batches from the current run's options.
      expect(buildSystemPrompt(normalizeBuildSystemPromptOptions(next.systemPromptOptions))).toBe(system);
    }
    expect(buildSystemPrompt((await h.prompt('/command')).systemPromptOptions)).toBe(system);
    h.ctx.signal = AbortSignal.abort();
    expect(buildSystemPrompt((await h.prompt()).systemPromptOptions)).toBe(system);
    const entries = h.manager.getEntries().filter(e => e.type === 'custom' && e.customType === SKILL_POLICY_ENTRY);
    expect(entries).toHaveLength(1);
  });

  it('omits the catalog even when the first request has no credentials or routing fails', async () => {
    for (const mode of ['missing', 'throw', 'null', 'bypass', 'tail-disabled']) {
      const h = harness();
      if (mode === 'missing') h.setKey(false);
      if (mode === 'throw') h.setEvaluate(async () => { throw new Error('offline'); });
      if (mode === 'null') h.setEvaluate(async () => null);
      if (mode === 'bypass') h.setEvaluate(async () => ({ bypassed: true }));
      if (mode === 'tail-disabled') h.setConfig({ enableTailInjection: false, enableSkills: true });
      expect((await h.prompt()).systemPromptOptions.skills).toEqual([]);
    }
  });

  it('reloads policy from non-context session entries despite config changes and branch navigation', async () => {
    const h = harness();
    const root = h.manager.appendMessage({ role: 'user', content: 'root', timestamp: 1 });
    const first = await h.prompt();
    const reloaded = harness(h.manager);
    reloaded.setConfig({ enableSkills: false });
    await reloaded.emit('session_start');
    expect(buildSystemPrompt((await reloaded.prompt()).systemPromptOptions)).toBe(buildSystemPrompt(first.systemPromptOptions));
    h.manager.branch(root);
    const branched = harness(h.manager);
    branched.setConfig({ enableSkills: false });
    expect((await branched.prompt()).systemPromptOptions.skills).toEqual([]);
  });

  it('preserves a session started with native skills disabled for routing, even when enabled later', async () => {
    const h = harness();
    h.setConfig({ enableSkills: false });
    const first = await h.prompt();
    expect(first.systemPromptOptions.skills).toEqual(skills);
    h.setConfig({ enableSkills: true });
    expect(buildSystemPrompt((await h.prompt()).systemPromptOptions)).toBe(buildSystemPrompt(first.systemPromptOptions));
  });

  it('recovers the sent policy from structured history after a failed metadata save and reload', async () => {
    for (const omit of [true, false]) {
      const h = harness();
      h.setConfig({ enableSkills: omit });
      h.api.appendEntry = () => { throw new Error('disk full'); };
      const first = await h.prompt();
      // The host persists its actual structured loadout, separately from our metadata.
      h.manager.appendMessage({ role: 'system', content: '', sections: {
        instructions: 'Fixed host instructions', ...(omit ? {} : { skills: 'Native fixture catalog' }),
      }, timestamp: 1 } as any);
      h.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done' }], timestamp: 2 } as any);
      const reloaded = harness(h.manager);
      reloaded.setConfig({ enableSkills: !omit });
      expect((await reloaded.prompt()).systemPromptOptions.skills).toEqual(first.systemPromptOptions.skills);
    }
  });

  it('keeps local policy fixed if persistence fails without throwing', () => {
    const manager = SessionManager.inMemory('/fixture');
    const policy = new SessionSkillPolicy({ appendEntry() { throw new Error('read-only'); } } as any);
    const ctx: any = { sessionManager: manager };
    expect(policy.resolve(ctx, 'fixture', () => true)).toBe(true);
    expect(policy.resolve(ctx, 'fixture', () => false)).toBe(true);
  });
});
