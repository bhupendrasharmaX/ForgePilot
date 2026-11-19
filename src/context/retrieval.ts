import * as fs from 'fs';
import * as path from 'path';
import { TokenBudgetManager, TokenAllocation } from './tokenBudget';
import { SymbolIndex, CodeSymbol } from './symbolIndex';
import { calculateScore, RankingFactor } from './ranking';
import { resolveSafePath, toWorkspaceRelative } from '../utils/pathValidation';

export interface RetrievedContext {
  allocations: TokenAllocation[];
  totalTokens: number;
  explicitFiles: string[];
  explicitSymbols: string[];
  discoveredSymbols: CodeSymbol[];
  explanation: {
    filePath: string;
    category: 'source' | 'test' | 'documentation' | 'configuration' | 'other';
    reason: string;
    score: number;
  }[];
}

export class ContextRetrievalEngine {
  private workspaceRoot: string;
  private budgetManager: TokenBudgetManager;
  private symbolIndex: SymbolIndex;

  constructor(workspaceRoot: string, maxTokens: number = 20000) {
    this.workspaceRoot = workspaceRoot;
    this.budgetManager = new TokenBudgetManager(maxTokens);
    this.symbolIndex = new SymbolIndex();
  }

  public setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  public setMaxTokens(tokens: number): void {
    this.budgetManager.setMaxTokens(tokens);
  }

  public getMaxTokens(): number {
    return this.budgetManager.getMaxTokens();
  }

  /**
   * Parses explicit @file and @symbol mentions from prompt.
   */
  public parseMentions(prompt: string): {
    explicitFiles: string[];
    explicitSymbols: string[];
    cleanPrompt: string;
  } {
    const fileMatches = prompt.match(/@file:([^\s]+)|@([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)/g) || [];
    const symbolMatches = prompt.match(/@symbol:([a-zA-Z0-9_]+)|@#([a-zA-Z0-9_]+)/g) || [];

    const explicitFiles = fileMatches.map((m) =>
      m.startsWith('@file:') ? m.slice(6) : m.slice(1)
    );
    const explicitSymbols = symbolMatches.map((m) =>
      m.startsWith('@symbol:') ? m.slice(8) : m.slice(2)
    );

    return {
      explicitFiles,
      explicitSymbols,
      cleanPrompt: prompt
    };
  }

  /**
   * Scans workspace files recursively, respecting common ignores.
   */
  public scanWorkspaceFiles(maxFiles: number = 1000): string[] {
    const result: string[] = [];
    const ignoredDirs = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      '__pycache__',
      '.pytest_cache',
      '.tox',
      '.venv',
      'venv',
      '.idea',
      '.vscode'
    ]);

    const traverse = (dir: string) => {
      if (result.length >= maxFiles) return;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      // Prioritize src/ and tests/ before docs/
      entries.sort((a, b) => {
        if (a.name === 'src') return -1;
        if (b.name === 'src') return 1;
        if (a.name === 'tests') return -1;
        if (b.name === 'tests') return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (result.length >= maxFiles) break;

        if (entry.isDirectory()) {
          if (!ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) {
            traverse(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const validExts = [
            '.py',
            '.ts',
            '.js',
            '.tsx',
            '.jsx',
            '.json',
            '.md',
            '.rst',
            '.yaml',
            '.yml',
            '.toml',
            '.html',
            '.css'
          ];
          if (validExts.includes(ext) || entry.name === 'Makefile' || entry.name === 'Dockerfile') {
            result.push(path.join(dir, entry.name));
          }
        }
      }
    };

    traverse(this.workspaceRoot);
    return result;
  }

  /**
   * Categorizes a file path into its architectural role.
   */
  private categorizeFile(relPath: string): 'source' | 'test' | 'documentation' | 'configuration' | 'other' {
    const lower = relPath.toLowerCase().replace(/\\/g, '/');
    if (lower.includes('test') || lower.includes('spec')) {
      return 'test';
    }
    if (lower.startsWith('docs/') || lower.endsWith('.rst') || lower.endsWith('.md')) {
      return 'documentation';
    }
    if (
      lower.endsWith('.json') ||
      lower.endsWith('.toml') ||
      lower.endsWith('.yaml') ||
      lower.endsWith('.yml') ||
      lower.includes('config')
    ) {
      return 'configuration';
    }
    if (lower.startsWith('src/') || lower.endsWith('.py') || lower.endsWith('.ts') || lower.endsWith('.js')) {
      return 'source';
    }
    return 'other';
  }

  /**
   * Retrieves context tailored to the user's task.
   */
  public async retrieveContext(userPrompt: string): Promise<RetrievedContext> {
    const { explicitFiles, explicitSymbols } = this.parseMentions(userPrompt);

    // Extract significant keywords (exclude tiny stop words)
    const keywords = userPrompt
      .toLowerCase()
      .replace(/[^a-zA-Z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'this', 'must', 'from'].includes(w));

    const testIntent =
      userPrompt.toLowerCase().includes('test') ||
      userPrompt.toLowerCase().includes('pytest') ||
      userPrompt.toLowerCase().includes('coverage');

    const docIntent =
      userPrompt.toLowerCase().includes('doc') ||
      userPrompt.toLowerCase().includes('documented') ||
      userPrompt.toLowerCase().includes('documentation') ||
      userPrompt.toLowerCase().includes('readme');

    // Scan workspace files
    const allFilePaths = this.scanWorkspaceFiles();
    const loadedFiles: Array<{ filePath: string; relativePath: string; content: string }> = [];

    for (const p of allFilePaths) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        const rel = toWorkspaceRelative(this.workspaceRoot, p);
        loadedFiles.push({ filePath: p, relativePath: rel, content });
      } catch {
        // Skip unreadable
      }
    }

    // Index code symbols
    this.symbolIndex.indexWorkspaceFiles(
      loadedFiles.map((f) => ({ filePath: f.relativePath, content: f.content }))
    );

    // Match symbols from mentions and prominent keywords
    const discoveredSymbols: CodeSymbol[] = [];
    for (const symName of explicitSymbols) {
      discoveredSymbols.push(...this.symbolIndex.findSymbols(symName));
    }
    for (const kw of keywords) {
      discoveredSymbols.push(...this.symbolIndex.findSymbols(kw));
    }

    // Rank candidates
    const scoredCandidates: Array<{
      filePath: string;
      content: string;
      score: number;
      category: 'source' | 'test' | 'documentation' | 'configuration' | 'other';
      reason: string;
    }> = [];

    for (const file of loadedFiles) {
      const normalizedPath = file.relativePath.replace(/\\/g, '/');
      const isExplicit = explicitFiles.some((ef) =>
        normalizedPath.toLowerCase().endsWith(ef.toLowerCase())
      );

      const baseName = path.basename(normalizedPath).toLowerCase();
      const baseStem = path.basename(normalizedPath, path.extname(normalizedPath)).toLowerCase();
      const cleanStem = baseStem.replace(/^test_/, '').replace(/_test$/, '');

      // Check if keyword matches exact file name or stem (e.g. "cli" matching "cli.py", "test_cli.py", "cli.rst")
      const isStemMatch = keywords.some(
        (kw) => kw === baseStem || kw === cleanStem
      );
      const isFileNameMatch = isStemMatch || keywords.some(
        (kw) => kw === baseName || baseName.includes(kw)
      );

      // Symbol matches in this file
      const fileSymbols = discoveredSymbols.filter(
        (s) => s.filePath.replace(/\\/g, '/') === normalizedPath
      );

      // Keyword matches in content
      const lowerContent = file.content.toLowerCase();
      let kwCount = 0;
      for (const kw of keywords) {
        if (lowerContent.includes(kw)) kwCount++;
      }

      const category = this.categorizeFile(normalizedPath);
      const isTest = category === 'test';
      const isDoc = category === 'documentation';
      const isSource = category === 'source' || normalizedPath.startsWith('src/');
      const depth = normalizedPath.split('/').length;

      const factor: RankingFactor = {
        filePath: normalizedPath,
        explicitMention: isExplicit,
        exactPathMatch: explicitFiles.some((ef) => normalizedPath.toLowerCase() === ef.toLowerCase()),
        fileNameMatch: isFileNameMatch,
        stemMatch: isStemMatch,
        symbolMatchCount: fileSymbols.length,
        keywordMatchCount: kwCount,
        isSourceFile: isSource,
        isTestFile: isTest,
        isDocFile: isDoc,
        fileDepth: depth
      };

      const score = calculateScore(factor, testIntent, docIntent);

      const reasons: string[] = [];
      if (isExplicit) reasons.push('Explicitly mentioned in prompt');
      if (isStemMatch) reasons.push(`Matches query target stem ("${cleanStem}")`);
      else if (isFileNameMatch) reasons.push(`Matches file name query ("${baseName}")`);
      if (fileSymbols.length > 0)
        reasons.push(`Contains matching symbols: ${fileSymbols.slice(0, 3).map((s) => s.name).join(', ')}`);
      if (kwCount > 0) reasons.push(`Matches ${kwCount} query keywords`);
      if (testIntent && isTest) reasons.push('Relevant test suite');
      if (docIntent && isDoc) reasons.push('Relevant documentation');

      if (score > 10 || isExplicit || fileSymbols.length > 0) {
        scoredCandidates.push({
          filePath: normalizedPath,
          content: file.content,
          score,
          category,
          reason: reasons.join('; ') || 'Workspace relevance match'
        });
      }
    }

    // Multi-domain balanced prioritization:
    // When the prompt calls for implementation, testing, and documentation,
    // ensure the top representative candidate from each domain is guaranteed priority.
    const priorityCandidates: typeof scoredCandidates = [];
    const remainingCandidates: typeof scoredCandidates = [];

    const bestSource = scoredCandidates
      .filter((c) => c.category === 'source')
      .sort((a, b) => b.score - a.score)[0];
    const bestTest = testIntent
      ? scoredCandidates
          .filter((c) => c.category === 'test')
          .sort((a, b) => b.score - a.score)[0]
      : undefined;
    const bestDoc = docIntent
      ? scoredCandidates
          .filter((c) => c.category === 'documentation')
          .sort((a, b) => b.score - a.score)[0]
      : undefined;

    const prioritizedPaths = new Set<string>();
    if (bestSource) {
      priorityCandidates.push(bestSource);
      prioritizedPaths.add(bestSource.filePath);
    }
    if (bestTest && !prioritizedPaths.has(bestTest.filePath)) {
      priorityCandidates.push(bestTest);
      prioritizedPaths.add(bestTest.filePath);
    }
    if (bestDoc && !prioritizedPaths.has(bestDoc.filePath)) {
      priorityCandidates.push(bestDoc);
      prioritizedPaths.add(bestDoc.filePath);
    }

    for (const c of scoredCandidates) {
      if (!prioritizedPaths.has(c.filePath)) {
        remainingCandidates.push(c);
      }
    }

    // Sort remaining by score
    remainingCandidates.sort((a, b) => b.score - a.score);

    // Combine prioritized first, then remainder
    const orderedCandidates = [...priorityCandidates, ...remainingCandidates];

    // Allocate budget (preserve deliberate multi-domain prioritization order)
    const budgetResult = this.budgetManager.allocateBudget(orderedCandidates, 3000, true);

    const explanation = budgetResult.allocations.map((alloc) => {
      const match = scoredCandidates.find((c) => c.filePath === alloc.filePath);
      return {
        filePath: alloc.filePath,
        category: match?.category || 'other',
        reason: match?.reason || 'Relevance score ranking',
        score: alloc.score
      };
    });

    return {
      allocations: budgetResult.allocations,
      totalTokens: budgetResult.totalTokens,
      explicitFiles,
      explicitSymbols,
      discoveredSymbols,
      explanation
    };
  }
}
