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

    if (decision.activatedSkill) {
      lines.push(`• Recommended SOP Skill: \`${decision.activatedSkill}\``);
      if (decision.activatedSkillPath) {
        lines.push(`  Read the complete SKILL.md before following this SOP: ${JSON.stringify(decision.activatedSkillPath)}`);
      }
    }

    if (decision.safetyRules && decision.safetyRules.length > 0) {
      lines.push(`• Enforced Constraint: ${decision.safetyRules.join('; ')}`);
    }

    const activeGuards = decision.activatedMemoryGuards || (decision.activatedMemoryGuard ? [decision.activatedMemoryGuard] : []);
    if (activeGuards.length > 0) {
      lines.push(`• Active Memory Guard:`);
      for (const g of activeGuards) {
        lines.push(`  [${g.category}] ${g.summary}`);
      }
    }

    if (decision.riskScore !== undefined) {
      const riskText = decision.riskScore >= 2 ? 'High' : decision.riskScore >= 1 ? 'Moderate' : 'Low';
      lines.push(`• Architecture Risk Level: ${decision.riskScore} (${riskText})`);
    }

    lines.push('---');
    return lines.join('\n');
  }

  /**
   * System Prompt Purity Invariant:
   * Keep system prompt 100% bit-for-bit static. Never dynamically inject individual
   * skills into the system prompt. Activated skills are routed strictly via prompt tails.
   */
  public pruneSystemPromptSkills(systemPrompt: string, _activatedSkillName?: string): string {
    const availMatch = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
    if (availMatch) {
      return systemPrompt.replace(
        availMatch[0],
        '<available_skills>\n<!-- Skill catalog routed by TypeSafe Jev; selected SOP paths are provided in navigation context. -->\n</available_skills>'
      );
    }
    const skillsBlockMatch = systemPrompt.match(/<skills>[\s\S]*?<\/skills>/);
    if (skillsBlockMatch) {
      return systemPrompt.replace(
        skillsBlockMatch[0],
        '<skills>\n<!-- Skill catalog routed by TypeSafe Jev; selected SOP paths are provided in navigation context. -->\n</skills>'
      );
    }
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
