import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { JevNavigator } from './index.js';
import type { DispatchDecision } from './types.js';
import { TailInjector } from './injector/tail-injector.js';
import { formatRoutingStats, formatMemoryRetrieval } from './jev/stats.js';
import { NavigationTailLedger, navigationMessageKey } from './injector/tail-ledger.js';

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

  type Run = { decision?: DispatchDecision; guidance?: string; userKey?: string; userEntryId?: string };
  const runs = new Map<string, Run>();
  const ledger = new NavigationTailLedger(pi);
  const keyFor = (ctx: ExtensionContext) => JSON.stringify([
    path.resolve(ctx.cwd), ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? '',
  ]);

  pi.on('session_start', async (_event, ctx) => {
    runs.delete(keyFor(ctx));
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
      if (!event.prompt || event.prompt.startsWith('/') || isJevDisabled(ctx)) return;
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

      // System Prompt Purity Invariant:
      // Completely empty event.systemPromptOptions.skills to prevent Pi from injecting 56KB+
      // of skill catalog into system instructions. System prompt stays 100% bit-for-bit static
      // across all turns (even when skills are activated), preserving LCP cache permanently.
      // Activated skills are exclusively routed via user prompt tail navigation.
      if (config.enableSystemPromptPruning !== false && config.enableSkills !== false && event.systemPromptOptions?.skills) {
        event.systemPromptOptions.skills = [];
      }

      if (ctx.hasUI) {
        const parts = [`Subsystem: ${decision.targetSubsystems?.join(', ') || 'General'}`];
        if (decision.activatedSkill) parts.push(`Skill: ${decision.activatedSkill}`);
        for (const guard of decision.activatedMemoryGuards ?? (decision.activatedMemoryGuard ? [decision.activatedMemoryGuard] : [])) {
          parts.push(`Guard: [${guard.category}] ${guard.title.slice(0, 30)}`);
        }
        if (decision.memoryRetrieval) {
          parts.push(`Memory: ${formatMemoryRetrieval(decision.memoryRetrieval)}`);
        }
        ctx.ui.notify(`Jev Routed: ${parts.join(' | ')} | ${formatRoutingStats(decision)}`, 'info');
      }
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
    let current: { index: number; guidance: string; userEntryId?: string; bind?: (id: string) => void } | undefined;
    if (run && latestIndex >= 0 && !ctx.signal?.aborted) {
      const messageKey = navigationMessageKey(event.messages[latestIndex]);
      if (run.userKey === undefined) run.userKey = messageKey;
      // Steering/new branches need a fresh decision. Still replay ALL historical tails.
      if (run.userKey === messageKey) current = {
        index: latestIndex, guidance: run.guidance ?? '', userEntryId: run.userEntryId,
        bind: id => { run.userEntryId = id; },
      };
    }
    const messages = ledger.replay(event.messages, ctx, key, current);
    if (messages !== event.messages || run?.guidance) return { messages };
  });

  // turn_end fires after every tool batch; agent_end can precede recovery/continuations.
  // Keep guidance for the whole run, including retries, until Pi's final settle boundary.
  pi.on('agent_settled', async (_event, ctx) => { runs.delete(keyFor(ctx)); });
  pi.on('session_tree', async (_event, ctx) => {
    runs.delete(keyFor(ctx));
    ledger.clearFallback(keyFor(ctx));
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    runs.delete(keyFor(ctx));
    ledger.clearFallback(keyFor(ctx));
  });
}
