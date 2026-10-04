/** `anchor` marks the branch's opening request when it falls outside the recent-turn window. */
export interface TaskContextMessage { role: 'user' | 'assistant'; text: string; anchor?: boolean }
export interface TaskContextStats { turns: number; messages: number; chars: number; anchor: boolean }

const MAX_TURNS = 4;
const MAX_MESSAGES = MAX_TURNS * 2 + 1;
const MAX_MESSAGE_CHARS = 1200;
const MAX_CONTEXT_CHARS = 6000;

function clip(text: string): string {
  const value = text.trim();
  return value.length <= MAX_MESSAGE_CHARS ? value : `${value.slice(0, 600)}\n[bounded context]\n${value.slice(-560)}`;
}

/** Bound branch-local text; idempotent. Never includes system, tools, custom entries or images. */
export function boundTaskContext(messages: TaskContextMessage[] = []): TaskContextMessage[] {
  const valid = messages.filter(message => (message.role === 'user' || message.role === 'assistant')
    && typeof message.text === 'string' && message.text.trim())
    .map(message => ({ role: message.role, text: clip(message.text), ...(message.anchor === true ? { anchor: true } : {}) }));
  const anchor = valid[0]?.anchor ? valid[0] : undefined;
  const recent = valid.filter(message => !message.anchor);
  const kept = recent.slice(-(anchor ? MAX_MESSAGES - 1 : MAX_MESSAGES));
  const size = () => kept.reduce((sum, message) => sum + message.text.length, anchor?.text.length ?? 0);
  // The newest exchanges resolve references best; drop the oldest recent message first.
  while (kept.length > 1 && size() > MAX_CONTEXT_CHARS) kept.shift();
  return anchor && size() <= MAX_CONTEXT_CHARS ? [anchor, ...kept] : kept;
}

function messageText(content: unknown): string {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
}

/**
 * Deterministic turn selection: each user request plus that turn's final assistant text.
 * Intermediate assistant progress notes and tool traffic do not consume context slots.
 */
export function collectTaskContext(entries: readonly { type?: string; message?: { role?: string; content?: unknown } }[]): TaskContextMessage[] {
  const turns: Array<{ user: string; assistant?: string }> = [];
  for (const entry of entries) {
    const message = entry.type === 'message' ? entry.message : undefined;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = messageText(message.content);
    if (!text.trim()) continue;
    if (message.role === 'user') turns.push({ user: text });
    else if (turns.length) turns[turns.length - 1].assistant = text;
  }
  const recent = turns.slice(-MAX_TURNS);
  const messages: TaskContextMessage[] = turns.length > MAX_TURNS ? [{ role: 'user', text: turns[0].user, anchor: true }] : [];
  for (const turn of recent) {
    messages.push({ role: 'user', text: turn.user });
    if (turn.assistant) messages.push({ role: 'assistant', text: turn.assistant });
  }
  return boundTaskContext(messages);
}

export function taskContextStats(messages: TaskContextMessage[]): TaskContextStats {
  return {
    turns: messages.filter(message => message.role === 'user' && !message.anchor).length,
    messages: messages.length,
    chars: messages.reduce((sum, message) => sum + message.text.length, 0),
    anchor: messages.some(message => message.anchor === true),
  };
}

/** Used only for routing; does not mutate messages or historical guidance. */
export function contextualRoutingTask(currentRequest: string, recentContext: TaskContextMessage[]): string {
  if (!recentContext.length) return currentRequest;
  return 'Evaluate the current_request. Recent context only resolves its references; an explicit new topic overrides old topics. An anchor item is the branch\'s opening request, relevant only if the current request continues it. Do not treat background as additional tasks.\n'
    + JSON.stringify({ current_request: currentRequest, recent_context: recentContext });
}
