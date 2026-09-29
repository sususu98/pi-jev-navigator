import * as fs from 'fs';
import { DispatchDecision } from '../types.js';

export class TailInjector {
  /**
   * Format the dispatch decision into a compact, high-signal tail context block
   */
  public formatTailGuidance(decision: DispatchDecision): string {
    const lines: string[] = [];

    lines.push('\n\n---');
    lines.push('🎯 [System One Navigation Context | Powered by TypeSafe Jev]');

    if (decision.targetSubsystems && decision.targetSubsystems.length > 0) {
      lines.push(`• 📁 Target Subsystem: \`${decision.targetSubsystems.join(', ')}\``);
    }

    if (decision.activatedSkill) {
      lines.push(`• 🛠️ Recommended SOP Skill: \`${decision.activatedSkill}\``);
      if (decision.activatedSkillPath && fs.existsSync(decision.activatedSkillPath)) {
        try {
          const content = fs.readFileSync(decision.activatedSkillPath, 'utf-8');
          // Extract Procedure or summary if present
          const procedureMatch = content.match(/## Procedure([\s\S]*?)(?=##|$)/i);
          if (procedureMatch) {
            const procLines = procedureMatch[1]
              .trim()
              .split('\n')
              .slice(0, 8)
              .map((l) => `    ${l}`);
            lines.push(`  📋 SOP Checklist:\n${procLines.join('\n')}`);
          }
        } catch {
          // Ignore
        }
      }
    }

    if (decision.safetyRules && decision.safetyRules.length > 0) {
      lines.push(`• 🚨 Enforced Constraint: ${decision.safetyRules.join('; ')}`);
    }

    if (decision.riskScore !== undefined) {
      const riskEmoji = decision.riskScore >= 2 ? '⚠️ High' : decision.riskScore >= 1 ? '⚡ Moderate' : '✅ Low';
      lines.push(`• 📊 Architecture Risk Level: ${decision.riskScore} (${riskEmoji})`);
    }

    if (decision.latencyMs && decision.inputTokens) {
      lines.push(
        `• ⚡ Jev Decision Stats: ${decision.latencyMs.toFixed(1)}ms | ${decision.inputTokens.toLocaleString()} Input Tokens`
      );
    }

    lines.push('---');
    return lines.join('\n');
  }

  /**
   * Append guidance to user prompt safely without mutating system prompt
   */
  public injectToPrompt(originalPrompt: string, decision: DispatchDecision): string {
    const guidance = this.formatTailGuidance(decision);
    return `${originalPrompt}${guidance}`;
  }
}
