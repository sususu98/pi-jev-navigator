import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { JevNavigator } from './index.js';
import type { DispatchDecision } from './types.js';
import { TailInjector } from './injector/tail-injector.js';
import { formatRoutingStats, formatMemoryRetrieval } from './jev/stats.js';
import { NavigationTailLedger, navigationMessageKey } from './injector/tail-ledger.js';
import { SessionSkillPolicy } from './injector/skill-policy.js';

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
  const ledger = new NavigationTailLedger(pi);
  const skillPolicy = new SessionSkillPolicy(pi);
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
      }, { skills, signal: ctx.signal });
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
    let current: { index: number; guidance: string; userEntryId?: string; bind?: (id: string) => void } | undefined;
    if (run && latestIndex >= 0 && !ctx.signal?.aborted) {
      if (run.userKey === undefined) run.userKey = navigationMessageKey(event.messages[latestIndex]);
      // Bind the initial prompt even when steering arrives before the first request.
      // Never attach its guidance to the newest (different) user message.
      const matchingIndices = event.messages.flatMap((message, index) => message.role === 'user'
        && navigationMessageKey(message) === run.userKey ? [index] : []);
      const index = run.userOccurrence === undefined
        ? matchingIndices.at(-1) : matchingIndices[run.userOccurrence];
      if (index !== undefined) current = {
        index, guidance: run.guidance ?? '', userEntryId: run.userEntryId,
        bind: id => { run.userEntryId = id; },
      };
    }
    const messages = ledger.replay(event.messages, ctx, key, current);
    if (ctx.hasUI && current && run && !run.guidanceDisplayed) {
      const original = event.messages[current.index];
      const injected = messages[current.index];
      let tail = '';
      if (original.role === 'user' && injected.role === 'user') {
        if (typeof original.content === 'string' && typeof injected.content === 'string'
          && injected.content.startsWith(original.content)) {
          tail = injected.content.slice(original.content.length);
        } else if (Array.isArray(original.content) && Array.isArray(injected.content)) {
          tail = injected.content.slice(original.content.length)
            .filter(part => part.type === 'text').map(part => part.text).join('');
        }
      }
      if (tail) {
        // Display exactly the bytes sent to the model, including full SOP paths and
        // memory constraints. Never add a second model message or rewrite old tails.
        run.guidanceDisplayed = true;
        // Pi coalesces consecutive info notifications. Send one display with two
        // distinct blocks so neither the navigation body nor telemetry is overwritten.
        try { ctx.ui.notify(`${tail}\n\n${run.telemetry ?? ''}`, 'info'); }
        catch { /* UI failure must not affect wire history. */ }
      }
    }
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
    skillPolicy.clear(keyFor(ctx));
  });
}
