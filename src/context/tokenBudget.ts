/**
 * Token budgeting and estimation utilities.
 */

export interface TokenAllocation {
  filePath: string;
  tokens: number;
  content: string;
  truncated: boolean;
  score: number;
}

export class TokenBudgetManager {
  private maxTokens: number;

  constructor(maxTokens: number = 20000) {
    this.maxTokens = maxTokens;
  }

  public setMaxTokens(limit: number): void {
    this.maxTokens = limit;
  }

  public getMaxTokens(): number {
    return this.maxTokens;
  }

  /**
   * Approximates token count for code / text.
   * Standard estimation: 1 token ~= 3.8 to 4 characters in code/prose.
   */
  public estimateTokens(text: string): number {
    if (!text) return 0;
    // Account for whitespace/punctuation tokens
    return Math.ceil(text.length / 3.8);
  }

  /**
   * Selects and compacts files to fit within the token budget.
   * Higher scoring files get priority.
   */
  public allocateBudget(
    candidates: Array<{ filePath: string; content: string; score: number }>,
    reservedTokens: number = 3000 // Reserved for system prompt, history, tool defs
  ): { allocations: TokenAllocation[]; totalTokens: number; budgetRemaining: number } {
    const usableBudget = Math.max(1000, this.maxTokens - reservedTokens);
    let currentTokens = 0;
    const allocations: TokenAllocation[] = [];

    // Sort by descending score
    const sorted = [...candidates].sort((a, b) => b.score - a.score);

    for (const item of sorted) {
      const fileTokens = this.estimateTokens(item.content);

      if (currentTokens + fileTokens <= usableBudget) {
        allocations.push({
          filePath: item.filePath,
          tokens: fileTokens,
          content: item.content,
          truncated: false,
          score: item.score
        });
        currentTokens += fileTokens;
      } else {
        // Can we include a truncated portion?
        const remaining = usableBudget - currentTokens;
        if (remaining > 200) {
          const maxChars = Math.floor(remaining * 3.8);
          const truncatedContent =
            item.content.slice(0, maxChars) +
            '\n\n# ... [ForgePilot: Remaining lines truncated due to token budget] ...';
          const truncatedTokens = this.estimateTokens(truncatedContent);

          allocations.push({
            filePath: item.filePath,
            tokens: truncatedTokens,
            content: truncatedContent,
            truncated: true,
            score: item.score
          });
          currentTokens += truncatedTokens;
        }
        break;
      }
    }

    return {
      allocations,
      totalTokens: currentTokens,
      budgetRemaining: Math.max(0, usableBudget - currentTokens)
    };
  }
}

