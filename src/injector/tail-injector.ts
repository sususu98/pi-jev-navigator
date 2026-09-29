import { DispatchDecision } from '../types.js';

export class TailInjector {
  /**
   * Format the dispatch decision into a compact, high-signal tail context block
   */
  public formatTailGuidance(decision: DispatchDecision): string {
    if (decision.bypassed) return '';
    const lines: string[] = [];

    lines.push('\n\n---');
    lines.push('🎯 [System One Navigation Context | Powered by TypeSafe Jev]');

    if (decision.targetSubsystems && decision.targetSubsystems.length > 0) {
      lines.push(`• 📁 Target Subsystem: \`${decision.targetSubsystems.join(', ')}\``);
    }

    if (decision.activatedSkill) {
      lines.push(`• 🛠️ Recommended SOP Skill: \`${decision.activatedSkill}\``);
      if (decision.activatedSkillPath) {
        lines.push(`  Read the complete SKILL.md before following this SOP: ${JSON.stringify(decision.activatedSkillPath)}`);
      }
    }

    if (decision.safetyRules && decision.safetyRules.length > 0) {
      lines.push(`• 🚨 Enforced Constraint: ${decision.safetyRules.join('; ')}`);
    }

    const activeGuards = decision.activatedMemoryGuards || (decision.activatedMemoryGuard ? [decision.activatedMemoryGuard] : []);
    if (activeGuards.length > 0) {
      lines.push(`• 🧠 Active Memory Guard:`);
      for (const g of activeGuards) {
        lines.push(`  ⚠️ [${g.category}] ${g.summary}`);
      }
    }

    if (decision.riskScore !== undefined) {
      const riskEmoji = decision.riskScore >= 2 ? '⚠️ High' : decision.riskScore >= 1 ? '⚡ Moderate' : '✅ Low';
      lines.push(`• 📊 Architecture Risk Level: ${decision.riskScore} (${riskEmoji})`);
    }

    if (decision.latencyMs !== undefined) {
      if (decision.pipelineMode === 'parallel' && decision.tokenBreakdown?.codeTokens && decision.tokenBreakdown?.memoryTokens) {
        const codeK = (decision.tokenBreakdown.codeTokens / 1000).toFixed(1);
        const memK = (decision.tokenBreakdown.memoryTokens / 1000).toFixed(1);
        lines.push(
          `• ⚡ Jev Decision Stats: ${decision.latencyMs.toFixed(1)}ms | Parallel Stream [Code: ${codeK}k + Mem: ${memK}k]`
        );
      } else if (decision.inputTokens) {
        lines.push(
          `• ⚡ Jev Decision Stats: ${decision.latencyMs.toFixed(1)}ms | ${decision.inputTokens.toLocaleString()} Input Tokens (${decision.pipelineMode || 'unified'})`
        );
      }
    }

    lines.push('---');
    return lines.join('\n');
  }

  /**
   * Prune unnecessary skills from System Prompt, retaining only the activated skill (if any)
   */
  public pruneSystemPromptSkills(systemPrompt: string, activatedSkillName?: string): string {
    const skillsBlockMatch = systemPrompt.match(/<skills>[\s\S]*?<\/skills>/);
    if (!skillsBlockMatch) {
      return systemPrompt;
    }

    const fullSkillsBlock = skillsBlockMatch[0];

    if (activatedSkillName && activatedSkillName !== 'none') {
      const escapedName = activatedSkillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match exactly the <skill>...</skill> element containing the activated skill name
      const skillRegex = new RegExp(`<skill>(?:(?!<skill>)[\\s\\S])*?<name>${escapedName}<\\/name>[\\s\\S]*?<\\/skill>`, 'i');
      const match = fullSkillsBlock.match(skillRegex);
      if (match) {
        const singleSkillBlock = `<skills>\nThe following skill was activated by TypeSafe Jev System One:\n<available_skills>\n  ${match[0].trim()}\n</available_skills>\n</skills>`;
        return systemPrompt.replace(fullSkillsBlock, singleSkillBlock);
      }
    }

    // 0 skills activated: strip all skills to reduce thousands of tokens
    return systemPrompt.replace(
      fullSkillsBlock,
      '<skills>\n<!-- Skill catalog routed by TypeSafe Jev; selected SOP paths are provided in navigation context. -->\n</skills>'
    );
  }

  /**
   * Append guidance to user prompt safely without mutating system prompt
   */
  public injectToPrompt(originalPrompt: string, decision: DispatchDecision): string {
    const guidance = this.formatTailGuidance(decision);
    return `${originalPrompt}${guidance}`;
  }
}
