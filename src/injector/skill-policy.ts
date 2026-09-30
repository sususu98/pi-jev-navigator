import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export const SKILL_POLICY_ENTRY = 'jev-skill-policy-v1';
interface SkillPolicy { version: 1; omitNativeCatalog: boolean }
function isPolicy(value: unknown): value is SkillPolicy {
  return !!value && typeof value === 'object' && (value as SkillPolicy).version === 1
    && typeof (value as SkillPolicy).omitNativeCatalog === 'boolean';
}

/** Session-level policy, not a routing decision. Non-context entries survive reload.
 * Changing flags/config affects new sessions only; historical navigation stays branch-local.
 * Never rewrites a rendered system message, tool declaration or transcript section.
 */
export class SessionSkillPolicy {
  private policies = new Map<string, SkillPolicy>();
  constructor(private pi: ExtensionAPI) {}

  resolve(ctx: ExtensionContext, key: string, initialOmission: () => boolean): boolean {
    let policy = this.policies.get(key);
    if (!policy) {
      // Policy belongs to the entire session, not the current task/branch.
      // getEntries also retains it when navigating to before its original branch entry.
      const entries = ctx.sessionManager?.getEntries?.() ?? ctx.sessionManager?.getBranch?.() ?? [];
      const stored = entries.find(entry => entry.type === 'custom'
        && entry.customType === SKILL_POLICY_ENTRY && isPolicy(entry.data));
      if (stored?.type === 'custom' && isPolicy(stored.data)) policy = stored.data;
      else {
        // Recover an already-sent policy if a previous metadata save failed. Read
        // structured host state, never regex-prune or rewrite rendered instructions.
        const branch = ctx.sessionManager?.getBranch?.() ?? entries;
        const messages = ctx.sessionManager?.buildSessionProjection?.().messages
          ?? branch.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
        const hasHistory = messages.some(message => message.role === 'assistant');
        let nativeSkills: string | undefined;
        let hasStructuredSystem = false;
        for (const message of messages) {
          if (message.role !== 'system' || !message.sections) continue;
          hasStructuredSystem = true;
          if (Object.hasOwn(message.sections, 'skills')) nativeSkills = message.sections.skills ?? undefined;
        }
        const omitNativeCatalog = hasHistory && hasStructuredSystem ? !nativeSkills : initialOmission();
        policy = { version: 1, omitNativeCatalog };
        try { this.pi.appendEntry?.(SKILL_POLICY_ENTRY, policy); }
        catch { /* Keep this runtime stable even if the host cannot persist metadata. */ }
      }
      this.policies.set(key, policy);
    }
    return policy.omitNativeCatalog;
  }

  clear(key: string): void { this.policies.delete(key); }
}
