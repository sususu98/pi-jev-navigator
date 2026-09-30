import { DispatchDecision } from '../types.js';

export class TailInjector {
  /**
   * Format the dispatch decision into a compact, high-signal tail context block
   */
  public formatTailGuidance(decision: DispatchDecision): string {
    if (decision.bypassed) return '';
    const lines: string[] = [];

    lines.push('\n\n---');
    lines.push('[System One Navigation Context | Powered by TypeSafe Jev]');

    if (decision.targetSubsystems && decision.targetSubsystems.length > 0) {
      lines.push(`• Target Subsystem: \`${decision.targetSubsystems.join(', ')}\``);
    }

    const skills = decision.activatedSkills ?? (decision.activatedSkill
      ? [{ name: decision.activatedSkill, path: decision.activatedSkillPath }] : []);
    for (const skill of skills) {
      lines.push(`• Recommended SOP Skill: \`${skill.name}\``);
      if (skill.path) {
        lines.push(`  Read the complete SKILL.md before following this SOP: ${JSON.stringify(skill.path)}`);
      }
    }

    if (decision.safetyRules && decision.safetyRules.length > 0) {
      lines.push(`• Enforced Constraint: ${decision.safetyRules.join('; ')}`);
    }

    const activeGuards = decision.activatedMemoryGuards || (decision.activatedMemoryGuard ? [decision.activatedMemoryGuard] : []);
    if (activeGuards.length > 0) {
      lines.push(`• Active Memory Guard:`);
      for (const g of activeGuards) {
        lines.push(`  [${g.category}] ${g.summary}${g.summary.includes(g.rule) ? '' : '\n  ' + g.rule}`);
      }
    }

    if (decision.riskScore !== undefined) {
      const riskText = decision.riskScore >= 2 ? 'High' : decision.riskScore >= 1 ? 'Moderate' : 'Low';
      lines.push(`• Architecture Risk Level: ${decision.riskScore} (${riskText})`);
    }

    lines.push('---');
    return lines.join('\n');
  }

  /** @deprecated Rendered system instructions must never be pruned. Kept as a
   * no-op for API compatibility; native catalog policy is fixed by the runtime.
   */
  public pruneSystemPromptSkills(systemPrompt: string, _activatedSkillName?: string): string {
    return systemPrompt;
  }

  /**
   * Append guidance to user prompt safely without mutating system prompt
   */
  public injectToPrompt(originalPrompt: string, decision: DispatchDecision): string {
    const guidance = this.formatTailGuidance(decision);
    return `${originalPrompt}${guidance}`;
  }
}
