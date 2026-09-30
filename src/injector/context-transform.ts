import type { ContextWithSystemEvent } from '@earendil-works/pi-coding-agent';
import type { DispatchDecision, JevNavigatorConfig } from '../types.js';
import { TailInjector } from './tail-injector.js';

/** Only system skill sections and an appended user text part are owned by this extension. */
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
  const user = result[userIndex];
  if (user.role === 'user') {
    result[userIndex] = {
      ...user,
      content: typeof user.content === 'string'
        ? (user.content.endsWith(tail) ? user.content : user.content + tail)
        : (user.content.some((part) => part.type === 'text' && part.text === tail)
          ? user.content : [...user.content, { type: 'text', text: tail }]),
    };
  }
  return result;
}
