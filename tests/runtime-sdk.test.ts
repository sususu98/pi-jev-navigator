import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import { registerRuntimeHooks } from '../src/runtime.ts';

/** Offline native host integration: real prompt preparation, tool loop and session reconstruction.
 * No provider API or production credentials are used; this does not measure upstream cache hits.
 */
describe('native Pi request-prefix integration', () => {
  it('keeps system/tools and historical routed users stable across tool loops, bypass and runtime recreation', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sdk-prefix-'));
    let session: any;
    try {
      const file = path.join(temp, 'SKILL.md');
      fs.writeFileSync(file, '---\nname: fixture\ndescription: Fixture SOP\n---\nImmutable fixture SOP.');
      const manager = SessionManager.inMemory(temp);
      const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const modelRuntime = await ModelRuntime.create({ authPath: path.join(temp, 'auth.json'), modelsPath: path.join(temp, 'models.json') });
      let offlineStream: any;
      modelRuntime.registerProvider('jev-offline-fixture', {
        api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'offline-fixture',
        streamSimple: (...args: any[]) => offlineStream(...args),
        models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      });
      const model = modelRuntime.getModel('jev-offline-fixture', 'fixture')!;
      let hasKey = true;
      let cfg: any = { enableSkills: true, enableTailInjection: true };
      const nav: any = { getConfig: () => cfg, hasApiKey: () => hasKey,
        getConfigStore: () => ({ getDiagnostics: () => [] }),
        evaluatePrompt: async () => ({ activatedSkill: 'fixture', activatedSkillPath: file }) };
      const captured: any[] = [];
      let toolPending = true;
      const create = async () => {
        const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: settings,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          skillsOverride: () => ({ skills: [{ name: 'fixture', description: 'Fixture SOP', filePath: file, baseDir: temp }], diagnostics: [] }),
          extensionFactories: [(pi) => registerRuntimeHooks(pi, () => nav)],
        });
        await loader.reload();
        expect(loader.getSkills().skills).toHaveLength(1);
        const created = await createAgentSession({ cwd: temp, agentDir: temp, modelRuntime, model,
          thinkingLevel: 'off', resourceLoader: loader, settingsManager: settings, sessionManager: manager, tools: ['read'] });
        session = created.session;
        await session.bindExtensions({ onError: (error: any) => { throw new Error(error.error); } });
        offlineStream = (_model: any, context: any) => {
          captured.push({ system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages), messages: structuredClone(context.messages) });
          const stream = createAssistantMessageEventStream();
          const stopReason = toolPending ? 'toolUse' : 'stop';
          const content = toolPending ? [{ type: 'toolCall', id: 'fixture-read', name: 'read', arguments: { path: file } }]
            : [{ type: 'text', text: 'Fixture complete.' }];
          toolPending = false;
          const response: any = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
          stream.push({ type: 'done', reason: stopReason, message: response });
          stream.end();
          return stream;
        };
      };
      await create();
      await session.prompt('Read the SOP then finish');
      if (!captured.length) throw new Error(JSON.stringify(session.messages.at(-1)));
      expect(captured.length).toBe(2);
      expect(captured[0].system).not.toContain('<available_skills>');
      expect(captured[1].system).toBe(captured[0].system);
      expect(captured[1].tools).toEqual(captured[0].tools);
      const firstUser = captured[0].messages.find((m: any) => m.role === 'user');
      expect(JSON.stringify(firstUser)).toContain(file);
      hasKey = false;
      await session.prompt('Routing has no credentials');
      expect(captured.at(-1).system).toBe(captured[0].system);
      expect(captured.at(-1).messages.find((m: any) => m.role === 'user')).toEqual(firstUser);
      const beforeReload = captured.at(-1);
      session.dispose(); session = undefined;
      cfg = { enableSkills: false, enableTailInjection: false };
      await create();
      await session.prompt('Resume without changing old guidance');
      const resumed = captured.at(-1);
      expect(resumed.system).toBe(captured[0].system);
      expect(resumed.tools).toEqual(captured[0].tools);
      expect(resumed.messages.find((m: any) => m.role === 'user')).toEqual(firstUser);
      // Every historical message in the last pre-reload request remains byte-identical.
      expect(JSON.stringify(resumed.messages.slice(0, beforeReload.messages.length))).toBe(JSON.stringify(beforeReload.messages));
    } finally {
      session?.dispose();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 20000);
});
