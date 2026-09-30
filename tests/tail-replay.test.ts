import { describe, expect, it, mock } from 'bun:test';
import register, { type JevNavigator } from '../src/index.ts';
import type { DispatchDecision, JevNavigatorConfig } from '../src/types.ts';
import { redactSensitive } from '../src/config/redact.ts';
import { TailInjector } from '../src/injector/tail-injector.ts';

// ============================================================================
// Fake Session Data Model (conforming to Pi Coding Agent session tree contract)
// ============================================================================

export interface FakeSessionMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string; [k: string]: any }>;
  timestamp: number;
  [key: string]: any;
}

export interface FakeSessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface FakeSessionMessageEntry extends FakeSessionEntryBase {
  type: 'message';
  message: FakeSessionMessage;
}

export interface FakeCustomEntry<T = any> extends FakeSessionEntryBase {
  type: 'custom';
  customType: string;
  data: T;
}

export interface FakeCompactionEntry extends FakeSessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  systemMessage?: any;
}

export interface FakeBranchSummaryEntry extends FakeSessionEntryBase {
  type: 'branch_summary';
  fromId: string;
  summary: string;
}

export type FakeSessionEntry =
  | FakeSessionMessageEntry
  | FakeCustomEntry
  | FakeCompactionEntry
  | FakeBranchSummaryEntry
  | (FakeSessionEntryBase & { type: string; [k: string]: any });

/**
 * Fake SessionManager implementing the tree-based session storage contract of Pi.
 * Provides getBranch, getEntry, getLeafId, appendMessage, appendCustomEntry, appendCompaction, branch, etc.
 */
export class FakeSessionManager {
  public sessionId: string;
  public sessionFile: string;
  private leafId: string | null = null;
  private entries: FakeSessionEntry[] = [];
  private byId = new Map<string, FakeSessionEntry>();
  private idCounter = 1;

  constructor(sessionId = 'session-replay-test', sessionFile = '/tmp/fake-session.jsonl') {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  public nextId(prefix = 'e'): string {
    return `${prefix}_${this.idCounter++}`;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getSessionFile(): string {
    return this.sessionFile;
  }

  public getLeafId(): string | null {
    return this.leafId;
  }

  public getLeafEntry(): FakeSessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  public getEntry(id: string): FakeSessionEntry | undefined {
    return this.byId.get(id);
  }

  public getBranch(fromId?: string): FakeSessionEntry[] {
    const startId = fromId ?? this.leafId;
    if (!startId) return [];
    const path: FakeSessionEntry[] = [];
    let current = this.byId.get(startId);
    while (current) {
      path.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
  }

  public getChildren(parentId: string): FakeSessionEntry[] {
    return this.entries.filter((e) => e.parentId === parentId);
  }

  public getEntries(): FakeSessionEntry[] {
    return [...this.entries];
  }

  public branch(branchFromId: string | null): void {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
  }

  public resetLeaf(): void {
    this.leafId = null;
  }

  public appendMessage(message: FakeSessionMessage, customId?: string): string {
    const id = customId ?? this.nextId('msg');
    const entry: FakeSessionMessageEntry = {
      type: 'message',
      id,
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message: structuredClone(message),
    };
    this.entries.push(entry);
    this.byId.set(id, entry);
    this.leafId = id;
    return id;
  }

  public appendCustomEntry(customType: string, data?: any, customId?: string): string {
    const id = customId ?? this.nextId('cust');
    const entry: FakeCustomEntry = {
      type: 'custom',
      id,
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      customType,
      data: structuredClone(data),
    };
    this.entries.push(entry);
    this.byId.set(id, entry);
    this.leafId = id;
    return id;
  }

  public appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore = 1000): string {
    const id = this.nextId('compact');
    const entry: FakeCompactionEntry = {
      type: 'compaction',
      id,
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    this.entries.push(entry);
    this.byId.set(id, entry);
    this.leafId = id;
    return id;
  }
}

// ============================================================================
// Tail Replay Test Harness
// ============================================================================

export interface TailReplayHarnessOptions {
  cfg?: JevNavigatorConfig;
  hasKey?: boolean;
  evaluate?: (prompt: string, ...args: any[]) => Promise<DispatchDecision | null>;
  sessionManager?: FakeSessionManager;
  cwd?: string;
  flags?: Record<string, any>;
}

export function createTailReplayHarness(options: TailReplayHarnessOptions = {}) {
  const events = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
  const commands: Record<string, any> = {};
  const flagDefs = new Map<string, any>();
  const flagValues = new Map<string, any>(Object.entries(options.flags ?? {}));
  const sm = options.sessionManager ?? new FakeSessionManager();
  const appendEntryCalls: Array<{ customType: string; data: any }> = [];

  const defaultCfg: JevNavigatorConfig = {
    enableTailInjection: true,
    enableSkills: true,
  };

  const nav = {
    hasApiKey: () => options.hasKey !== false,
    getConfig: () => ({ ...defaultCfg, ...options.cfg }),
    getConfigForDisplay: () => redactSensitive({ ...defaultCfg, ...options.cfg }),
    getConfigStore: () => ({ getDiagnostics: () => [] }),
    getStatus: () => { throw new Error('expensive status must not run during hooks'); },
    evaluatePrompt: mock(options.evaluate ?? (async (prompt: string) => ({
      targetSubsystems: ['core'],
      activatedSkill: 'sop-fixture',
      activatedSkillPath: '/skills/sop-fixture/SKILL.md',
      latencyMs: 5,
    }))),
  };

  const piMock: any = {
    on(name: string, handler: any) {
      const list = events.get(name) ?? [];
      list.push(handler);
      events.set(name, list);
    },
    registerCommand(name: string, cmd: any) {
      commands[name] = cmd;
    },
    registerFlag(name: string, flagOpts: any) {
      flagDefs.set(name, flagOpts);
    },
    getFlag(name: string) {
      return flagValues.get(name);
    },
    appendEntry: mock((customType: string, data?: any) => {
      appendEntryCalls.push({ customType, data });
      sm.appendCustomEntry(customType, data);
    }),
  };

  register(piMock, () => nav as unknown as JevNavigator);

  const getContext = (customSm = sm) => ({
    cwd: options.cwd ?? '/fixture/repo',
    hasUI: false,
    sessionManager: customSm,
    ui: {
      notify: mock(),
      setWorkingMessage: mock(),
      setStatus: mock(),
    },
    flags: Object.fromEntries(flagValues.entries()),
  });

  return {
    nav,
    events,
    commands,
    flagDefs,
    flagValues,
    piMock,
    sessionManager: sm,
    appendEntryCalls,
    getContext,
    async emit(name: string, event: any = {}, ctx = getContext()) {
      let result: any;
      for (const handler of events.get(name) ?? []) {
        result = (await handler(event, ctx)) ?? result;
      }
      return result;
    },
  };
}

// ============================================================================
// Test Suite: Tail Replay and Prompt Cache Invariant
// ============================================================================

describe('Tail Replay & Prompt Cache Invariance (jev-navigation-tail-v1)', () => {
  it('run1 -> settled -> run2: preserves historical user1 tail and prefix verbatim while run2 can have a distinct tail', async () => {
    const sm = new FakeSessionManager('session-run1-run2');
    let evalTurn = 1;
    const h = createTailReplayHarness({
      sessionManager: sm,
      evaluate: async (prompt) => {
        if (evalTurn === 1) {
          return {
            targetSubsystems: ['database'],
            activatedSkill: 'sop-db-optimizer',
            activatedSkillPath: '/skills/db/SKILL.md',
            latencyMs: 10,
          };
        }
        return {
          targetSubsystems: ['http-api'],
          activatedSkill: 'sop-rate-limiter',
          activatedSkillPath: '/skills/rate-limit/SKILL.md',
          latencyMs: 12,
        };
      },
    });

    const ctx = h.getContext();

    // 1. Setup session history with system message and User 1
    const sysMsg: FakeSessionMessage = { role: 'system', content: 'You are an expert system.', timestamp: 100 };
    sm.appendMessage(sysMsg);

    const user1RawMsg: FakeSessionMessage = { role: 'user', content: 'Task 1: Optimize database pool', timestamp: 1000 };
    sm.appendMessage(user1RawMsg);

    // 2. Run 1: before_agent_start -> context_with_system
    await h.emit('before_agent_start', { prompt: user1RawMsg.content }, ctx);
    const run1Context = await h.emit('context_with_system', { messages: [sysMsg, structuredClone(user1RawMsg)] }, ctx);

    expect(run1Context).toBeDefined();
    expect(run1Context.messages).toHaveLength(2);
    const user1Transformed = run1Context.messages[1].content as string;
    expect(user1Transformed).toContain('Task 1: Optimize database pool');
    expect(user1Transformed).toContain('sop-db-optimizer');

    // Verify custom entry was persisted via pi.appendEntry
    expect(h.piMock.appendEntry).toHaveBeenCalled();
    const customEntries = sm.getBranch().filter((e) => e.type === 'custom' && (e as any).customType === 'jev-navigation-tail-v1');
    expect(customEntries.length).toBeGreaterThanOrEqual(1);

    // 3. Assistant 1 reply and Run 1 settle
    const ast1Msg: FakeSessionMessage = { role: 'assistant', content: 'Optimized pool.', timestamp: 1500 };
    sm.appendMessage(ast1Msg);
    await h.emit('agent_settled', {}, ctx);

    // 4. Run 2: User 2 prompt
    evalTurn = 2;
    const user2RawMsg: FakeSessionMessage = { role: 'user', content: 'Task 2: Add rate limiting', timestamp: 2000 };
    sm.appendMessage(user2RawMsg);

    await h.emit('before_agent_start', { prompt: user2RawMsg.content }, ctx);

    // Pi rebuilds model context with raw messages from history + new user message
    const run2InputMessages = [sysMsg, structuredClone(user1RawMsg), ast1Msg, structuredClone(user2RawMsg)];
    const run2Context = await h.emit('context_with_system', { messages: run2InputMessages }, ctx);

    expect(run2Context).toBeDefined();
    expect(run2Context.messages).toHaveLength(4);

    // [Prompt Cache Invariant Assertion 1]: Historical user1 content must match verbatim (bit-for-bit exact string equality)
    expect(run2Context.messages[1].content).toBe(user1Transformed);

    // [Prompt Cache Invariant Assertion 2]: Entire upstream prefix prior to user2 must be strictly identical
    expect(run2Context.messages[0]).toEqual(run1Context.messages[0]); // system
    expect(run2Context.messages[1]).toEqual(run1Context.messages[1]); // user1
    expect(run2Context.messages[2]).toEqual(ast1Msg); // assistant1

    // [Distinct Tail Assertion]: Run 2 user gets the new decision tail, not the old one
    const user2Transformed = run2Context.messages[3].content as string;
    expect(user2Transformed).toContain('Task 2: Add rate limiting');
    expect(user2Transformed).toContain('sop-rate-limiter');
    expect(user2Transformed).not.toContain('sop-db-optimizer');
    expect(user2Transformed).not.toBe(user1Transformed);
  });

  it('run2 with evaluate null/bypassed/disabled/no-key retains historical user1 tail while leaving new user untransformed', async () => {
    const failureScenarios = [
      { name: 'evaluate returns null', evaluate: async () => null },
      { name: 'evaluate returns bypassed', evaluate: async () => ({ bypassed: true as const }) },
      { name: 'missing API key', hasKey: false },
      { name: 'tail injection disabled', cfg: { enableTailInjection: false } },
    ];

    for (const scenario of failureScenarios) {
      const sm = new FakeSessionManager(`session-${scenario.name.replace(/\s+/g, '-')}`);
      const sysMsg: FakeSessionMessage = { role: 'system', content: 'System instructions', timestamp: 100 };
      sm.appendMessage(sysMsg);
      const user1RawMsg: FakeSessionMessage = { role: 'user', content: 'User prompt 1', timestamp: 1000 };
      sm.appendMessage(user1RawMsg);

      // Harness 1 for Run 1
      const h1 = createTailReplayHarness({
        sessionManager: sm,
        evaluate: async () => ({
          targetSubsystems: ['core'],
          activatedSkill: 'sop-initial',
          latencyMs: 5,
        }),
      });
      const ctx1 = h1.getContext();
      await h1.emit('before_agent_start', { prompt: user1RawMsg.content }, ctx1);
      const res1 = await h1.emit('context_with_system', { messages: [sysMsg, structuredClone(user1RawMsg)] }, ctx1);
      expect(res1).toBeDefined();
      const user1ExpectedContent = res1.messages[1].content as string;
      expect(user1ExpectedContent).toContain('sop-initial');

      const astMsg: FakeSessionMessage = { role: 'assistant', content: 'Done 1', timestamp: 1500 };
      sm.appendMessage(astMsg);
      await h1.emit('agent_settled', {}, ctx1);

      // Run 2 under the failure scenario
      const user2RawMsg: FakeSessionMessage = { role: 'user', content: 'User prompt 2 (failure run)', timestamp: 2000 };
      sm.appendMessage(user2RawMsg);

      const h2 = createTailReplayHarness({
        sessionManager: sm,
        hasKey: scenario.hasKey,
        cfg: scenario.cfg,
        evaluate: scenario.evaluate,
      });
      const ctx2 = h2.getContext();
      await h2.emit('session_start', {}, ctx2);
      await h2.emit('before_agent_start', { prompt: user2RawMsg.content }, ctx2);

      const inputMessages = [sysMsg, structuredClone(user1RawMsg), astMsg, structuredClone(user2RawMsg)];
      const res2 = await h2.emit('context_with_system', { messages: inputMessages }, ctx2);

      // Historical user1 tail MUST be retained to protect upstream Prompt Cache
      expect(res2).toBeDefined();
      expect(res2.messages[1].content).toBe(user1ExpectedContent);

      // New user2 MUST NOT be transformed or injected
      expect(res2.messages[3].content).toBe('User prompt 2 (failure run)');
      expect(res2.messages[3].content).not.toContain('sop-initial');
      expect(res2.messages[3].content).not.toContain('System One Navigation Context');
    }
  });

  it('preserves existing tail across tool execution turns and does not attach old decision to steering user', async () => {
    const sm = new FakeSessionManager('session-tool-steering');
    const h = createTailReplayHarness({
      sessionManager: sm,
      evaluate: async () => ({
        targetSubsystems: ['tooling'],
        activatedSkill: 'sop-tool-executor',
        latencyMs: 7,
      }),
    });
    const ctx = h.getContext();

    const sysMsg: FakeSessionMessage = { role: 'system', content: 'System prompt', timestamp: 100 };
    sm.appendMessage(sysMsg);
    const user1RawMsg: FakeSessionMessage = { role: 'user', content: 'Run command task', timestamp: 1000 };
    sm.appendMessage(user1RawMsg);

    // Initial prompt in run 1
    await h.emit('before_agent_start', { prompt: user1RawMsg.content }, ctx);
    const firstContext = await h.emit('context_with_system', { messages: [sysMsg, structuredClone(user1RawMsg)] }, ctx);
    const user1Transformed = firstContext.messages[1].content as string;
    expect(user1Transformed).toContain('sop-tool-executor');

    // 1. Tool Turn: assistant emits toolCall, toolResult is returned
    const toolCallMsg: FakeSessionMessage = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'git status' } }],
      timestamp: 1200,
    };
    const toolResultMsg: FakeSessionMessage = {
      role: 'toolResult',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'On branch main' }],
      timestamp: 1300,
    };
    sm.appendMessage(toolCallMsg);
    sm.appendMessage(toolResultMsg);

    await h.emit('turn_end', {}, ctx);

    // context_with_system triggered again during tool turns
    const toolTurnContext = await h.emit('context_with_system', {
      messages: [sysMsg, structuredClone(user1RawMsg), toolCallMsg, toolResultMsg],
    }, ctx);

    // Assert tail on user1 is NOT revoked
    expect(toolTurnContext).toBeDefined();
    expect(toolTurnContext.messages[1].content).toBe(user1Transformed);

    // 2. Steering Message inserted by user mid-run
    const steeringMsg: FakeSessionMessage = {
      role: 'user',
      content: 'Steering instruction: abort and check git diff instead',
      timestamp: 1400,
    };
    sm.appendMessage(steeringMsg);

    const steeringContext = await h.emit('context_with_system', {
      messages: [sysMsg, structuredClone(user1RawMsg), toolCallMsg, toolResultMsg, structuredClone(steeringMsg)],
    }, ctx);

    // Assert: old user1 tail stays intact
    expect(steeringContext).toBeDefined();
    expect(steeringContext.messages[1].content).toBe(user1Transformed);

    // Assert: steering user message does NOT receive the old decision
    expect(steeringContext.messages[4].content).toBe('Steering instruction: abort and check git diff instead');
    expect(steeringContext.messages[4].content).not.toContain('sop-tool-executor');
    expect(steeringContext.messages[4].content).not.toContain('System One Navigation Context');
  });

  it('restores historical tails from persisted custom entries on clean extension reload or session resume', async () => {
    const sm = new FakeSessionManager('session-reload');
    const sysMsg: FakeSessionMessage = { role: 'system', content: 'System root', timestamp: 100 };
    sm.appendMessage(sysMsg);
    const user1Msg: FakeSessionMessage = { role: 'user', content: 'Pre-reload prompt', timestamp: 1000 };
    sm.appendMessage(user1Msg);

    // Instance 1: runs first task and writes custom entry
    const h1 = createTailReplayHarness({
      sessionManager: sm,
      evaluate: async () => ({
        targetSubsystems: ['persist'],
        activatedSkill: 'sop-persisted-knowledge',
        latencyMs: 9,
      }),
    });
    const ctx1 = h1.getContext();
    await h1.emit('before_agent_start', { prompt: user1Msg.content }, ctx1);
    const res1 = await h1.emit('context_with_system', { messages: [sysMsg, structuredClone(user1Msg)] }, ctx1);
    const expectedTailContent = res1.messages[1].content as string;
    expect(expectedTailContent).toContain('sop-persisted-knowledge');

    const ast1Msg: FakeSessionMessage = { role: 'assistant', content: 'Pre-reload response', timestamp: 1500 };
    sm.appendMessage(ast1Msg);
    await h1.emit('agent_settled', {}, ctx1);

    // Simulate session reload/resume: new extension instance, empty in-memory runs Map
    const h2 = createTailReplayHarness({
      sessionManager: sm,
      evaluate: async () => {
        throw new Error('evaluatePrompt should NOT be called during historical replay');
      },
    });
    const ctx2 = h2.getContext();

    // Trigger session_start (simulating Pi starting or resuming session)
    await h2.emit('session_start', {}, ctx2);

    // Trigger context_with_system without any new before_agent_start
    const resumeContext = await h2.emit('context_with_system', {
      messages: [sysMsg, structuredClone(user1Msg), ast1Msg],
    }, ctx2);

    expect(resumeContext).toBeDefined();
    expect(resumeContext.messages[1].content).toBe(expectedTailContent);
  });

  it('branch switching does not leak tails from alternate branches sharing the same timestamp', async () => {
    const sm = new FakeSessionManager('session-branching');
    const sysMsg: FakeSessionMessage = { role: 'system', content: 'System root', timestamp: 100 };
    const sysId = sm.appendMessage(sysMsg);

    const user1Msg: FakeSessionMessage = { role: 'user', content: 'Common prompt 1', timestamp: 1000 };
    const user1Id = sm.appendMessage(user1Msg);

    const ast1Msg: FakeSessionMessage = { role: 'assistant', content: 'Common reply 1', timestamp: 1500 };
    const forkPointId = sm.appendMessage(ast1Msg);

    // Branch A: User 2 on branch A with timestamp = 2000
    const user2BranchA: FakeSessionMessage = { role: 'user', content: 'Branch A specific task', timestamp: 2000 };
    const user2AId = sm.appendMessage(user2BranchA);

    const h = createTailReplayHarness({
      sessionManager: sm,
      evaluate: async (prompt) => {
        if (prompt.includes('Branch A')) {
          return {
            targetSubsystems: ['branch-a'],
            activatedSkill: 'sop-branch-a',
            latencyMs: 8,
          };
        }
        return {
          targetSubsystems: ['branch-b'],
          activatedSkill: 'sop-branch-b',
          latencyMs: 8,
        };
      },
    });
    const ctx = h.getContext();

    // Run Branch A
    await h.emit('before_agent_start', { prompt: user2BranchA.content }, ctx);
    const branchAContext = await h.emit('context_with_system', {
      messages: [sysMsg, structuredClone(user1Msg), ast1Msg, structuredClone(user2BranchA)],
    }, ctx);
    const branchATail = branchAContext.messages[3].content as string;
    expect(branchATail).toContain('sop-branch-a');
    const branchALeaf = sm.getLeafId();

    // Now branch off from forkPointId (Common reply 1) to create Branch B
    sm.branch(forkPointId);

    // User 2 on Branch B has the EXACT SAME timestamp (2000), but different content & entry ID
    const user2BranchB: FakeSessionMessage = { role: 'user', content: 'Branch B alternative task', timestamp: 2000 };
    const user2BId = sm.appendMessage(user2BranchB);

    // Verify branch B path isolation in SessionManager
    const branchBEntries = sm.getBranch();
    expect(branchBEntries.some((e) => e.id === user2AId)).toBe(false);
    expect(branchBEntries.some((e) => e.id === user2BId)).toBe(true);

    // Request context on Branch B without running evaluate (or with bypassed evaluate)
    const branchBContext = await h.emit('context_with_system', {
      messages: [sysMsg, structuredClone(user1Msg), ast1Msg, structuredClone(user2BranchB)],
    }, ctx);

    // Assert: Branch B user MUST NOT leak Branch A tail despite identical timestamp
    if (branchBContext) {
      expect(branchBContext.messages[3].content).not.toContain('sop-branch-a');
    }

    // Switch back to Branch A
    sm.branch(branchALeaf);
    const branchAReplayContext = await h.emit('context_with_system', {
      messages: [sysMsg, structuredClone(user1Msg), ast1Msg, structuredClone(user2BranchA)],
    }, ctx);
    expect(branchAReplayContext).toBeDefined();
    expect(branchAReplayContext.messages[3].content).toBe(branchATail);
  });

  it('is strictly idempotent: repeated context_with_system calls do not duplicate appendEntry or multiply tails', async () => {
    const sm = new FakeSessionManager('session-idempotent');
    const h = createTailReplayHarness({
      sessionManager: sm,
      evaluate: async () => ({
        targetSubsystems: ['core'],
        activatedSkill: 'sop-idempotent',
        latencyMs: 6,
      }),
    });
    const ctx = h.getContext();

    const sysMsg: FakeSessionMessage = { role: 'system', content: 'System instructions', timestamp: 100 };
    sm.appendMessage(sysMsg);
    const userMsg: FakeSessionMessage = { role: 'user', content: 'Idempotency test prompt', timestamp: 1000 };
    sm.appendMessage(userMsg);

    await h.emit('before_agent_start', { prompt: userMsg.content }, ctx);

    // First context call
    const firstCall = await h.emit('context_with_system', { messages: [sysMsg, structuredClone(userMsg)] }, ctx);
    expect(firstCall).toBeDefined();
    const firstText = firstCall.messages[1].content as string;
    expect(firstText).toContain('sop-idempotent');

    const firstAppendCallsCount = h.piMock.appendEntry.mock.calls.length;
    // One fixed session policy plus one frozen user tail; neither is duplicated.
    expect(firstAppendCallsCount).toBe(2);

    // Second context call (identical input)
    const secondCall = await h.emit('context_with_system', { messages: [sysMsg, structuredClone(userMsg)] }, ctx);
    expect(secondCall).toBeDefined();
    expect(secondCall.messages[1].content).toBe(firstText);
    expect(h.piMock.appendEntry.mock.calls.length).toBe(firstAppendCallsCount);

    // Third context call with previously transformed messages
    const thirdCall = await h.emit('context_with_system', { messages: secondCall.messages }, ctx);
    expect(thirdCall).toBeDefined();
    expect(thirdCall.messages[1].content).toBe(firstText);
    expect(h.piMock.appendEntry.mock.calls.length).toBe(firstAppendCallsCount);

    // Verify session tree has exactly one custom entry for this user
    const customEntries = sm.getBranch().filter(
      (e) => e.type === 'custom' && (e as any).customType === 'jev-navigation-tail-v1'
    );
    expect(customEntries).toHaveLength(1);

    // Ensure guidance header appears exactly once
    const matches = firstText.match(/\[System One Navigation Context/g);
    expect(matches).toHaveLength(1);
  });

  it('keeps system prompts, skill sections, user original text, images and tool results bit-for-bit unchanged', async () => {
    const sm = new FakeSessionManager('session-fidelity');
    const h = createTailReplayHarness({
      sessionManager: sm,
      evaluate: async () => ({
        targetSubsystems: ['multimodal'],
        activatedSkill: 'sop-vision-architect',
        latencyMs: 11,
      }),
    });
    const ctx = h.getContext();

    const complexMessages: FakeSessionMessage[] = [
      {
        role: 'system',
        content: 'System base text',
        sections: {
          skills: '<skills><skill><name>read</name><location>/SKILL.md</location></skill></skills>',
          instructions: 'Preserve all invariant instructions exactly.',
        },
        toolsAdded: [{ name: 'read', description: 'Read a file', parameters: {} }],
        timestamp: 0,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this architecture diagram: ' },
          { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png' },
        ],
        timestamp: 1000,
      },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_abc', name: 'read', arguments: { path: '/diagram.png' } }],
        timestamp: 2000,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_abc',
        content: [{ type: 'text', text: 'Binary image validated.' }],
        isError: false,
        timestamp: 3000,
      },
    ];

    for (const msg of complexMessages) {
      sm.appendMessage(msg);
    }

    const baselineSnapshot = structuredClone(complexMessages);

    await h.emit('before_agent_start', { prompt: 'Analyze this architecture diagram: ' }, ctx);
    const transformed = await h.emit('context_with_system', { messages: structuredClone(complexMessages) }, ctx);

    expect(transformed).toBeDefined();

    // 1. System message: content, sections, toolsAdded 100% untouched
    expect(transformed.messages[0]).toEqual(baselineSnapshot[0]);

    // 2. User message: original text and image content parts untouched; tail appended as distinct text part
    const userParts = transformed.messages[1].content as Array<{ type: string; [k: string]: any }>;
    expect(Array.isArray(userParts)).toBe(true);
    expect(userParts[0]).toEqual(baselineSnapshot[1].content[0]);
    expect(userParts[1]).toEqual(baselineSnapshot[1].content[1]);
    expect(userParts.length).toBeGreaterThanOrEqual(3);
    expect(userParts[2].type).toBe('text');
    expect(userParts[2].text).toContain('sop-vision-architect');

    // 3. Assistant and toolResult messages 100% untouched
    expect(transformed.messages[2]).toEqual(baselineSnapshot[2]);
    expect(transformed.messages[3]).toEqual(baselineSnapshot[3]);
  });

  it('replays tails only for messages that still exist after compaction and never resurrects pruned users', async () => {
    const sm = new FakeSessionManager('session-compaction');
    const h = createTailReplayHarness({
      sessionManager: sm,
      evaluate: async (prompt) => ({
        targetSubsystems: ['compaction-test'],
        activatedSkill: prompt.includes('User 3') ? 'sop-user-3' : 'sop-early-user',
        latencyMs: 5,
      }),
    });
    const ctx = h.getContext();

    const sysMsg: FakeSessionMessage = { role: 'system', content: 'Base system prompt', timestamp: 100 };
    sm.appendMessage(sysMsg);

    // User 1 & Assistant 1 (will be compacted away)
    const user1Msg: FakeSessionMessage = { role: 'user', content: 'User 1 old query', timestamp: 1000 };
    sm.appendMessage(user1Msg);
    await h.emit('before_agent_start', { prompt: user1Msg.content }, ctx);
    await h.emit('context_with_system', { messages: [sysMsg, structuredClone(user1Msg)] }, ctx);
    const ast1Msg: FakeSessionMessage = { role: 'assistant', content: 'Reply 1', timestamp: 1500 };
    sm.appendMessage(ast1Msg);
    await h.emit('agent_settled', {}, ctx);

    // User 2 & Assistant 2 (will also be compacted away)
    const user2Msg: FakeSessionMessage = { role: 'user', content: 'User 2 old query', timestamp: 2000 };
    sm.appendMessage(user2Msg);
    await h.emit('before_agent_start', { prompt: user2Msg.content }, ctx);
    await h.emit('context_with_system', { messages: [sysMsg, structuredClone(user1Msg), ast1Msg, structuredClone(user2Msg)] }, ctx);
    const ast2Msg: FakeSessionMessage = { role: 'assistant', content: 'Reply 2', timestamp: 2500 };
    sm.appendMessage(ast2Msg);
    await h.emit('agent_settled', {}, ctx);

    // User 3 (Kept entry after compaction boundary)
    const user3Msg: FakeSessionMessage = { role: 'user', content: 'User 3 recent query', timestamp: 3000 };
    const user3Id = sm.appendMessage(user3Msg);
    await h.emit('before_agent_start', { prompt: user3Msg.content }, ctx);
    const user3Res = await h.emit('context_with_system', {
      messages: [sysMsg, structuredClone(user1Msg), ast1Msg, structuredClone(user2Msg), ast2Msg, structuredClone(user3Msg)],
    }, ctx);
    const user3ExpectedTail = user3Res.messages[5].content as string;
    expect(user3ExpectedTail).toContain('sop-user-3');
    const ast3Msg: FakeSessionMessage = { role: 'assistant', content: 'Reply 3', timestamp: 3500 };
    sm.appendMessage(ast3Msg);
    await h.emit('agent_settled', {}, ctx);

    // Compaction occurs: summarizes User 1 and User 2; firstKeptEntryId is User 3
    const compactionEntryId = sm.appendCompaction('Summary: user 1 and user 2 discussed earlier topics.', user3Id, 45000);

    // Simulated compacted context provided by Pi SessionManager to context_with_system:
    // [system, compactionSummary, user3Raw, assistant3]
    const compactionSummaryMsg: FakeSessionMessage = {
      role: 'system',
      content: 'Summary: user 1 and user 2 discussed earlier topics.',
      timestamp: 3600,
    };
    const compactedContextInput = [sysMsg, compactionSummaryMsg, structuredClone(user3Msg), ast3Msg];

    const compactedOutput = await h.emit('context_with_system', { messages: compactedContextInput }, ctx);

    expect(compactedOutput).toBeDefined();
    // Must contain exactly 4 messages
    expect(compactedOutput.messages).toHaveLength(4);

    // Compaction summary must remain untouched
    expect(compactedOutput.messages[1]).toEqual(compactionSummaryMsg);

    // User 3 must have its tail replayed correctly
    expect(compactedOutput.messages[2].content).toBe(user3ExpectedTail);

    // Pruned User 1 and User 2 MUST NOT be resurrected
    const allText = JSON.stringify(compactedOutput.messages);
    expect(allText).not.toContain('User 1 old query');
    expect(allText).not.toContain('User 2 old query');
    expect(allText).not.toContain('sop-early-user');
  });
});
