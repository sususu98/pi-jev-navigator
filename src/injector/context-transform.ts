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
  // Never prune a catalog without somewhere to deliver the selected skill's path.
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { userIndex = i; break; }
  }
  if (userIndex < 0) return messages;
  const injector = new TailInjector();
  const tail = guidance ?? injector.formatTailGuidance(decision);
  const result = messages.slice();
  if (config.enableSystemPromptPruning !== false && config.enableSkills !== false) {
    for (let i = 0; i < result.length; i++) {
      const message = result[i];
      if (message.role !== 'system') continue;
      const updated = { ...message };
      if (typeof message.sections?.skills === 'string') {
        updated.sections = {
          ...message.sections,
          skills: injector.pruneSystemPromptSkills(message.sections.skills, decision.activatedSkill),
        };
      }
      if (typeof message.content === 'string') {
        updated.content = injector.pruneSystemPromptSkills(message.content, decision.activatedSkill);
      } else if (Array.isArray(message.content)) {
        updated.content = message.content.map((part) =>
          part.type === 'text'
            ? { ...part, text: injector.pruneSystemPromptSkills(part.text, decision.activatedSkill) }
            : part
        );
      }
      result[i] = updated;
    }
  }
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
