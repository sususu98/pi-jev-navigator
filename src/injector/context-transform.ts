import type { ContextWithSystemEvent } from '@earendil-works/pi-coding-agent';
import type { DispatchDecision, JevNavigatorConfig } from '../types.js';
import { TailInjector } from './tail-injector.js';

/** Only appended user text parts are owned by this extension; system/skills stay untouched. */
export function appendNavigationTail(message: ContextWithSystemEvent['messages'][number], tail: string): ContextWithSystemEvent['messages'][number] {
  if (message.role !== 'user' || !tail) return message;
  if (typeof message.content === 'string' ? message.content.endsWith(tail)
    : message.content.some(part => part.type === 'text' && part.text === tail)) return message;
  return {
    ...message,
    content: typeof message.content === 'string' ? message.content + tail
      : [...message.content, { type: 'text', text: tail }],
  };
}

export function transformNavigationContext(
  messages: ContextWithSystemEvent['messages'],
  decision: DispatchDecision | null | undefined,
  config: JevNavigatorConfig,
  guidance?: string
): ContextWithSystemEvent['messages'] {
  if (!decision || decision.bypassed || config.enableTailInjection === false) return messages;
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { userIndex = i; break; }
  }
  if (userIndex < 0) return messages;
  const injector = new TailInjector();
  const tail = guidance ?? injector.formatTailGuidance(decision);
  const result = messages.slice();
  result[userIndex] = appendNavigationTail(result[userIndex], tail);
  return result;
}
