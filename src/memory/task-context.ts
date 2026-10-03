export interface TaskContextMessage { role: 'user' | 'assistant'; text: string }
const MAX_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 1200;

/** Bound recent branch-local text; never include system, tools, custom entries or images. */
export function boundTaskContext(messages: TaskContextMessage[] = []): TaskContextMessage[] {
  return messages.filter(message => (message.role === 'user' || message.role === 'assistant')
    && typeof message.text === 'string' && message.text.trim()).slice(-MAX_MESSAGES).map(message => {
    const text = message.text.trim();
    return { role: message.role, text: text.length <= MAX_MESSAGE_CHARS ? text
      : `${text.slice(0, 600)}\n[bounded context]\n${text.slice(-560)}` };
  });
}

export function collectTaskContext(entries: readonly { type?: string; message?: { role?: string; content?: unknown } }[]): TaskContextMessage[] {
  const messages: TaskContextMessage[] = [];
  for (let i = entries.length - 1; i >= 0 && messages.length < MAX_MESSAGES; i--) {
    const entry = entries[i];
    const message = entry.type === 'message' ? entry.message : undefined;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
    if (text.trim()) messages.push({ role: message.role, text });
  }
  return boundTaskContext(messages.reverse());
}

/** Used only for routing; does not mutate messages or historical guidance. */
export function contextualRoutingTask(currentRequest: string, recentContext: TaskContextMessage[]): string {
  if (!recentContext.length) return currentRequest;
  return 'Evaluate the current_request. Recent context only resolves its references; an explicit new topic overrides old topics. Do not treat background as additional tasks.\n'
    + JSON.stringify({ current_request: currentRequest, recent_context: recentContext });
}
