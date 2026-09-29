import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { JevNavigator } from './index.js';
import type { DispatchDecision } from './types.js';
import { TailInjector } from './injector/tail-injector.js';
import { transformNavigationContext } from './injector/context-transform.js';

/** Request-local transformations only; never rewrite provider payloads or persisted transcripts. */
export function registerRuntimeHooks(pi: ExtensionAPI, getNavigator: (cwd: string) => JevNavigator): void {
  type Run = { decision?: DispatchDecision; guidance?: string; userTimestamp?: number };
  const runs = new Map<string, Run>();
  const keyFor = (ctx: ExtensionContext) => JSON.stringify([
    path.resolve(ctx.cwd), ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? '',
  ]);

  pi.on('session_start', async (_event, ctx) => {
    runs.delete(keyFor(ctx));
    try {
      const nav = getNavigator(ctx.cwd);
      if (ctx.hasUI) {
        ctx.ui.setStatus('jev', nav.hasApiKey() ? '⚡ Jev Active' : '⚠️ Jev (No API Key)');
        for (const diagnostic of nav.getConfigStore().getDiagnostics()) ctx.ui.notify(diagnostic, 'warning');
      }
    } catch {
      // Missing/unreadable local state must not prevent the main agent from starting.
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const key = keyFor(ctx);
    const run: Run = {};
    runs.set(key, run); // invalidate any pending result from an earlier prompt in this session
    let workingMessage = false;
    try {
      if (!event.prompt || event.prompt.startsWith('/')) return;
      const nav = getNavigator(ctx.cwd);
      const config = nav.getConfig();
      if (!nav.hasApiKey() || config.enableTailInjection === false || ctx.signal?.aborted) return;
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage('⚡ Jev System One routing...');
        workingMessage = true;
      }
      // Pi's canonical catalog includes package/custom paths and excludes disabled resources.
      const hostSkills = event.systemPromptOptions?.skills;
      const skills = hostSkills?.filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({ name: skill.name, description: skill.description, path: skill.filePath }));
      const decision = await nav.evaluatePrompt(event.prompt, [], {
        sessionFile: ctx.sessionManager?.getSessionFile?.(),
        sessionId: ctx.sessionManager?.getSessionId?.(),
      }, { skills, signal: ctx.signal });
      if (runs.get(key) !== run || ctx.signal?.aborted || !decision || decision.bypassed) return;
      run.decision = decision;
      run.guidance = new TailInjector().formatTailGuidance(decision);
      if (ctx.hasUI) {
        const parts = [`Subsystem: ${decision.targetSubsystems?.join(', ') || 'General'}`];
        if (decision.activatedSkill) parts.push(`Skill: ${decision.activatedSkill}`);
        for (const guard of decision.activatedMemoryGuards ?? (decision.activatedMemoryGuard ? [decision.activatedMemoryGuard] : [])) {
          parts.push(`Guard: [${guard.category}] ${guard.title.slice(0, 30)}`);
        }
        ctx.ui.notify(`⚡ Jev Routed: ${parts.join(' | ')} (${decision.latencyMs?.toFixed(0) ?? '?'}ms)`, 'info');
      }
      // Do not return systemPrompt: it would persist a decision-dependent leading prompt.
    } catch {
      run.decision = undefined;
      run.guidance = undefined;
    } finally {
      if (workingMessage && runs.get(key) === run) ctx.ui.setWorkingMessage();
    }
  });

  pi.on('context_with_system', async (event, ctx) => {
    const run = runs.get(keyFor(ctx));
    if (!run?.decision || ctx.signal?.aborted) return;
    let latestUser: (typeof event.messages)[number] | undefined;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (event.messages[i].role === 'user') { latestUser = event.messages[i]; break; }
    }
    if (!latestUser) return;
    // Steering messages need a fresh decision; do not attach a previous task's constraints.
    if (run.userTimestamp !== undefined && run.userTimestamp !== latestUser.timestamp) return;
    run.userTimestamp = latestUser.timestamp;
    const messages = transformNavigationContext(event.messages, run.decision, getNavigator(ctx.cwd).getConfig(), run.guidance);
    return { messages };
  });

  // turn_end fires after every tool batch; agent_end can precede recovery/continuations.
  // Keep guidance for the whole run, including retries, until Pi's final settle boundary.
  pi.on('agent_settled', async (_event, ctx) => { runs.delete(keyFor(ctx)); });
  pi.on('session_shutdown', async (_event, ctx) => { runs.delete(keyFor(ctx)); });
}
