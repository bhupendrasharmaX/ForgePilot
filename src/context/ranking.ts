export interface RankingFactor {
  filePath: string;
  exactPathMatch?: boolean;
  fileNameMatch?: boolean;
  explicitMention?: boolean;
  symbolMatchCount: number;
  keywordMatchCount: number;
  isTestFile: boolean;
  isDocFile: boolean;
  fileDepth: number;
}

export function calculateScore(
  factor: RankingFactor,
  queryHasTestIntent: boolean = false,
  queryHasDocIntent: boolean = false
): number {
  let score = 0;

  if (factor.explicitMention) {
    score += 150;
  }
  if (factor.exactPathMatch) {
    score += 100;
  }
  if (factor.fileNameMatch) {
    score += 80;
  }

  score += factor.symbolMatchCount * 30;
  score += Math.min(60, factor.keywordMatchCount * 5);

  // Intent alignment
  if (queryHasTestIntent && factor.isTestFile) {
    score += 40;
  }
  if (queryHasDocIntent && factor.isDocFile) {
    score += 40;
  }

  // Bonus for src/ directory source files
  if (factor.filePath.startsWith('src/')) {
    score += 25;
  }

  // Shallow file depth bonus
  score += Math.max(0, 20 - factor.fileDepth * 2);

  // Penalties
  if (factor.filePath.includes('node_modules') || factor.filePath.includes('.git')) {
    score -= 200;
  }
  if (factor.filePath.endsWith('.min.js') || factor.filePath.endsWith('.map')) {
    score -= 100;
  }

  return Math.max(1, score);
}
