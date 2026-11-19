export interface RankingFactor {
  filePath: string;
  exactPathMatch?: boolean;
  fileNameMatch?: boolean;
  stemMatch?: boolean;
  explicitMention?: boolean;
  symbolMatchCount: number;
  keywordMatchCount: number;
  isSourceFile: boolean;
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

  // 1. Explicit mention in prompt (@file:..., @path)
  if (factor.explicitMention) {
    score += 200;
  }

  // 2. Exact relative path match
  if (factor.exactPathMatch) {
    score += 150;
  }

  // 3. Exact filename or stem match (e.g. "cli" matching "cli.py", "test_cli.py", "cli.rst")
  if (factor.stemMatch) {
    score += 140;
  } else if (factor.fileNameMatch) {
    score += 90;
  }

  // 4. Symbol matches (bounded sublinear to prevent single high-count file from dominating)
  score += Math.min(180, factor.symbolMatchCount * 25);

  // 5. Keyword occurrences in content (bounded)
  score += Math.min(80, factor.keywordMatchCount * 5);

  // 6. Domain intent alignment
  if (factor.isSourceFile) {
    score += 35;
  }
  if (queryHasTestIntent && factor.isTestFile) {
    score += 60;
  }
  if (queryHasDocIntent && factor.isDocFile) {
    score += 60;
  }

  // 7. Shallow file depth bonus
  score += Math.max(0, 20 - factor.fileDepth * 2);

  // 8. Penalties for irrelevant paths
  const lowerPath = factor.filePath.toLowerCase();
  if (lowerPath.includes('node_modules') || lowerPath.includes('.git') || lowerPath.includes('__pycache__')) {
    score -= 300;
  }
  if (lowerPath.endsWith('.min.js') || lowerPath.endsWith('.map') || lowerPath.endsWith('.lock')) {
    score -= 100;
  }

  return Math.max(1, score);
}
