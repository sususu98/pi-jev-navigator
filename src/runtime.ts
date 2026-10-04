import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { JevNavigator } from './index.js';
import type { DispatchDecision } from './types.js';
import { TailInjector } from './injector/tail-injector.js';
import { formatRoutingStats, formatMemoryRetrieval } from './jev/stats.js';
import { NavigationTailLedger, navigationMessageKey, type CurrentTail } from './injector/tail-ledger.js';
import { SessionSkillPolicy } from './injector/skill-policy.js';
import { collectTaskContext } from './memory/task-context.js';

/** Request-local transformations only; never rewrite provider payloads or persisted transcripts. */
export function registerRuntimeHooks(pi: ExtensionAPI, getNavigator: (cwd: string) => JevNavigator): void {
  try {
    pi.registerFlag?.('no-jev', {
      description: 'Disable Jev System One context routing and tail injection for this run',
      type: 'boolean',
    });
  } catch {
    // Ignore if flag API not available or already registered
  }

  const isJevDisabled = (ctx: ExtensionContext): boolean => {
    if (
      process.env.JEV_DISABLE === '1' ||
      process.env.PI_NO_JEV === '1' ||
      process.env.DISABLE_JEV === '1'
    ) {
      return true;
    }
    try {
      if ((ctx as any).flags?.['no-jev'] || (pi as any).getFlag?.('no-jev')) {
        return true;
      }
    } catch {
      // Ignore
    }
    return false;
  };

  type Run = { decision?: DispatchDecision; guidance?: string; userKey?: string; userEntryId?: string; userOccurrence?: number; guidanceDisplayed?: boolean; telemetry?: string };
  const runs = new Map<string, Run>();
  type SteeringItem = { text: string; promise: Promise<Run | undefined> };
  const steeringRuns = new Map<string, SteeringItem[]>();
  const ledger = new NavigationTailLedger(pi);
  const skillPolicy = new SessionSkillPolicy(pi);
  const warmSubscriptions = new Map<string, () => void>();
  const keyFor = (ctx: ExtensionContext) => JSON.stringify([
    path.resolve(ctx.cwd), ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? '',
  ]);

  pi.on('session_start', async (_event, ctx) => {
    runs.delete(keyFor(ctx));
    steeringRuns.delete(keyFor(ctx));
    ledger.clearFallback(keyFor(ctx));
    try {
      const nav = getNavigator(ctx.cwd);
      if (ctx.hasUI) {
        if (isJevDisabled(ctx)) {
          ctx.ui.setStatus('jev', '⏸️ Jev Disabled (Flag/Env)');
        } else {
          ctx.ui.setStatus('jev', nav.hasApiKey() ? '⚡ Jev Active' : '⚠️ Jev (No API Key)');
        }
        for (const diagnostic of nav.getConfigStore().getDiagnostics()) ctx.ui.notify(diagnostic, 'warning');
        // Typing after an idle period warms the keyword path before the prompt is submitted.
        // Observe only: never consume or rewrite terminal input.
        warmSubscriptions.get(keyFor(ctx))?.();
        warmSubscriptions.delete(keyFor(ctx));
        if (!isJevDisabled(ctx) && typeof ctx.ui.onTerminalInput === 'function') {
          const cwd = ctx.cwd;
          warmSubscriptions.set(keyFor(ctx), ctx.ui.onTerminalInput(() => {
            try { getNavigator(cwd).warmKeywordPath(); } catch { /* best effort */ }
            return undefined;
          }));
        }
      }
    } catch {
      // Missing/unreadable local state must not prevent the main agent from starting.
    }
  });

  pi.on('input', async (event, ctx) => {
    // Intercept prompts submitted while the model/tools are running (steering or follow-up).
    // Idle prompts proceed through before_agent_start.
    if (!event.streamingBehavior) return;
    if (!event.text || event.text.startsWith('/') || isJevDisabled(ctx)) return;
    const key = keyFor(ctx);
    const nav = getNavigator(ctx.cwd);
    const config = nav.getConfig();
    if (!nav.hasApiKey() || config.enableTailInjection === false || ctx.signal?.aborted) return;

    const promise = (async (): Promise<Run | undefined> => {
      try {
        const decision = await nav.evaluatePrompt(event.text, [], {
          sessionFile: ctx.sessionManager?.getSessionFile?.(),
          sessionId: ctx.sessionManager?.getSessionId?.(),
        }, { signal: ctx.signal, recentContext: collectTaskContext(ctx.sessionManager?.getBranch?.() ?? []) });
        if (!decision || decision.bypassed) return undefined;
        const guidance = new TailInjector().formatTailGuidance(decision);
        const stats = [formatRoutingStats(decision)];
        if (decision.memoryRetrieval) stats.push(formatMemoryRetrieval(decision.memoryRetrieval));
        const telemetry = `Jev Telemetry: ${stats.join('\n')}`;
        return { decision, guidance, telemetry };
      } catch {
        return undefined;
      }
    })();

    let queue = steeringRuns.get(key);
    if (!queue) {
      queue = [];
      steeringRuns.set(key, queue);
    }
    queue.push({ text: event.text, promise });
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const key = keyFor(ctx);
    const run: Run = {};
    runs.set(key, run); // invalidate any pending result from an earlier prompt in this session
    let workingMessage = false;
    // Capture routing metadata before applying the session's fixed catalog policy.
    const hostSkills = event.systemPromptOptions?.skills;
    try {
      const omitCatalog = skillPolicy.resolve(ctx, key, () => {
        try { return !isJevDisabled(ctx) && getNavigator(ctx.cwd).getConfig().enableSkills !== false; }
        catch { return false; } // A broken config must not later flip the session policy.
      });
      if (omitCatalog && event.systemPromptOptions) event.systemPromptOptions.skills = [];
      if (!event.prompt || event.prompt.startsWith('/') || isJevDisabled(ctx)) return;
      const nav = getNavigator(ctx.cwd);
      const config = nav.getConfig();
      if (!nav.hasApiKey() || config.enableTailInjection === false || ctx.signal?.aborted) return;
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage('⚡ Jev System One routing...');
        workingMessage = true;
      }
      // Pi's canonical catalog includes package/custom paths and excludes disabled resources.
      const skills = hostSkills?.filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({ name: skill.name, description: skill.description, path: skill.filePath }));
      const decision = await nav.evaluatePrompt(event.prompt, [], {
        sessionFile: ctx.sessionManager?.getSessionFile?.(),
        sessionId: ctx.sessionManager?.getSessionId?.(),
      }, { skills, signal: ctx.signal, recentContext: collectTaskContext(ctx.sessionManager?.getBranch?.() ?? []) });
      if (runs.get(key) !== run || ctx.signal?.aborted || !decision || decision.bypassed) return;
      run.decision = decision;
      run.guidance = new TailInjector().formatTailGuidance(decision);

      // Human-only telemetry is never part of the frozen model tail.
      const stats = [formatRoutingStats(decision)];
      if (decision.memoryRetrieval) stats.push(formatMemoryRetrieval(decision.memoryRetrieval));
      run.telemetry = `Jev Telemetry: ${stats.join('\n')}`;
      // Do not return systemPrompt: it would persist a decision-dependent leading prompt.
    } catch {
      run.decision = undefined;
      run.guidance = undefined;
    } finally {
      if (workingMessage && runs.get(key) === run) ctx.ui.setWorkingMessage();
    }
  });

  // Initial user messages are finalized before the first provider request. Bind before
  // a possible steering message can become the newest user in that request clone.
  pi.on('message_end', (event, ctx) => {
    const run = runs.get(keyFor(ctx));
    if (run && run.userKey === undefined && event.message.role === 'user') {
      run.userKey = navigationMessageKey(event.message);
      const branch = ctx.sessionManager?.getBranch?.();
      if (branch) {
        const matches = branch.filter(entry => entry.type === 'message' && entry.message.role === 'user'
          && navigationMessageKey(entry.message) === run.userKey);
        // Native message_end precedes persistence; minimal hosts may emit after it.
        const known = matches.findIndex(entry => entry.type === 'message' && entry.message === event.message);
        run.userOccurrence = known >= 0 ? known : matches.length;
        if (known >= 0) run.userEntryId = matches[known].id;
      }
    }
  });

  pi.on('context_with_system', async (event, ctx) => {
    // Even cancellation/idle warming must keep the historical wire prefix unchanged.
    const key = keyFor(ctx);
    const run = runs.get(key);
    let latestIndex = -1;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (event.messages[i].role === 'user') { latestIndex = i; break; }
    }
    const currentTails: CurrentTail[] = [];
    if (run && latestIndex >= 0 && !ctx.signal?.aborted) {
      if (run.userKey === undefined) run.userKey = navigationMessageKey(event.messages[latestIndex]);
      // Bind the initial prompt even when steering arrives before the first request.
      // Never attach its guidance to the newest (different) user message.
      const matchingIndices = event.messages.flatMap((message, index) => message.role === 'user'
        && navigationMessageKey(message) === run.userKey ? [index] : []);
      const index = run.userOccurrence === undefined
        ? matchingIndices.at(-1) : matchingIndices[run.userOccurrence];
      if (index !== undefined) currentTails.push({
        index, guidance: run.guidance ?? '', userEntryId: run.userEntryId,
        bind: id => { run.userEntryId = id; },
      });
    }

    const steeringList = steeringRuns.get(key);
    const activeSteeringRuns: Array<{ run: Run; index: number }> = [];
    if (steeringList && steeringList.length > 0 && !ctx.signal?.aborted) {
      for (let i = 0; i < event.messages.length; i++) {
        const msg = event.messages[i];
        if (msg.role !== 'user') continue;
        if (run && navigationMessageKey(msg) === run.userKey) continue;
        const msgText = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter(p => p.type === 'text').map(p => (p as any).text).join('') : '';
        const matchIdx = steeringList.findIndex(s => s.text === msgText || (msgText && msgText.startsWith(s.text)));
        if (matchIdx >= 0) {
          const item = steeringList.splice(matchIdx, 1)[0];
          const evaluated = await item.promise;
          if (evaluated?.guidance) {
            const steeringRun: Run = { ...evaluated, userKey: navigationMessageKey(msg) };
            currentTails.push({
              index: i, guidance: evaluated.guidance,
              bind: id => { steeringRun.userEntryId = id; },
            });
            activeSteeringRuns.push({ run: steeringRun, index: i });
          }
        }
      }
    }

    const messages = ledger.replay(event.messages, ctx, key, currentTails);
    const displayTail = (targetRun: Run, targetIndex: number) => {
      if (!ctx.hasUI || targetRun.guidanceDisplayed) return;
      const original = event.messages[targetIndex];
      const injected = messages[targetIndex];
      let tail = '';
      if (original?.role === 'user' && injected?.role === 'user') {
        if (typeof original.content === 'string' && typeof injected.content === 'string'
          && injected.content.startsWith(original.content)) {
          tail = injected.content.slice(original.content.length);
        } else if (Array.isArray(original.content) && Array.isArray(injected.content)) {
          tail = injected.content.slice(original.content.length)
            .filter(part => part.type === 'text').map(part => (part as any).text).join('');
        }
      }
      if (tail) {
        targetRun.guidanceDisplayed = true;
        try { ctx.ui.notify(`${tail}\n\n${targetRun.telemetry ?? ''}`, 'info'); }
        catch { /* UI failure must not affect wire history. */ }
      }
    };

    if (run && currentTails.length > 0 && currentTails[0].index !== undefined) {
      displayTail(run, currentTails[0].index);
    }
    for (const item of activeSteeringRuns) {
      displayTail(item.run, item.index);
    }

    const hasAnyGuidance = run?.guidance || activeSteeringRuns.some(s => s.run.guidance);
    if (messages !== event.messages || hasAnyGuidance) return { messages };
  });

  // turn_end fires after every tool batch; agent_end can precede recovery/continuations.
  // Keep guidance for the whole run, including retries, until Pi's final settle boundary.
  pi.on('agent_settled', async (_event, ctx) => {
    runs.delete(keyFor(ctx));
    steeringRuns.delete(keyFor(ctx));
  });
  pi.on('session_tree', async (_event, ctx) => {
    runs.delete(keyFor(ctx));
    steeringRuns.delete(keyFor(ctx));
    ledger.clearFallback(keyFor(ctx));
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    runs.delete(keyFor(ctx));
    steeringRuns.delete(keyFor(ctx));
    ledger.clearFallback(keyFor(ctx));
    skillPolicy.clear(keyFor(ctx));
    warmSubscriptions.get(keyFor(ctx))?.();
    warmSubscriptions.delete(keyFor(ctx));
  });
}
