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
   * Retrieves context tailored to the user's task.
   */
  public async retrieveContext(userPrompt: string): Promise<RetrievedContext> {
    const { explicitFiles, explicitSymbols } = this.parseMentions(userPrompt);

    // Extract keywords (filter small words)
    const keywords = userPrompt
      .toLowerCase()
      .replace(/[^a-zA-Z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'this'].includes(w));

    const testIntent =
      userPrompt.toLowerCase().includes('test') ||
      userPrompt.toLowerCase().includes('pytest') ||
      userPrompt.toLowerCase().includes('coverage');

    const docIntent =
      userPrompt.toLowerCase().includes('doc') ||
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

    // Index symbols
    this.symbolIndex.indexWorkspaceFiles(
      loadedFiles.map((f) => ({ filePath: f.relativePath, content: f.content }))
    );

    // Match symbols
    const discoveredSymbols: CodeSymbol[] = [];
    for (const symName of explicitSymbols) {
      discoveredSymbols.push(...this.symbolIndex.findSymbols(symName));
    }
    // Also search keywords for symbol names
    for (const kw of keywords) {
      discoveredSymbols.push(...this.symbolIndex.findSymbols(kw));
    }

    // Rank candidates
    const scoredCandidates: Array<{
      filePath: string;
      content: string;
      score: number;
      reason: string;
    }> = [];

    for (const file of loadedFiles) {
      const isExplicit = explicitFiles.some((ef) =>
        file.relativePath.toLowerCase().endsWith(ef.toLowerCase())
      );

      const baseName = path.basename(file.relativePath).toLowerCase();
      const baseStem = path.basename(file.relativePath, path.extname(file.relativePath)).toLowerCase();
      const isFileNameMatch = keywords.some(
        (kw) => kw === baseName || kw === baseStem || baseName.includes(kw)
      );

      // Symbol matches in this file
      const fileSymbols = discoveredSymbols.filter((s) => s.filePath === file.relativePath);

      // Keyword matches in content
      const lowerContent = file.content.toLowerCase();
      let kwCount = 0;
      for (const kw of keywords) {
        if (lowerContent.includes(kw)) kwCount++;
      }

      const isTest = file.relativePath.includes('test') || file.relativePath.includes('spec');
      const isDoc =
        file.relativePath.includes('doc') ||
        file.relativePath.endsWith('.md') ||
        file.relativePath.endsWith('.rst');
      const depth = file.relativePath.split('/').length;

      const factor: RankingFactor = {
        filePath: file.relativePath,
        explicitMention: isExplicit,
        fileNameMatch: isFileNameMatch,
        symbolMatchCount: fileSymbols.length,
        keywordMatchCount: kwCount,
        isTestFile: isTest,
        isDocFile: isDoc,
        fileDepth: depth
      };

      const score = calculateScore(factor, testIntent, docIntent);

      const reasons: string[] = [];
      if (isExplicit) reasons.push('Explicitly mentioned in prompt');
      if (isFileNameMatch) reasons.push(`Matches file name in query (${baseName})`);
      if (fileSymbols.length > 0)
        reasons.push(`Contains matching symbols: ${fileSymbols.map((s) => s.name).join(', ')}`);
      if (kwCount > 0) reasons.push(`Matches ${kwCount} query keywords`);
      if (testIntent && isTest) reasons.push('Relevant test suite');
      if (docIntent && isDoc) reasons.push('Relevant documentation');

      if (score > 10 || isExplicit || fileSymbols.length > 0) {
        scoredCandidates.push({
          filePath: file.relativePath,
          content: file.content,
          score,
          reason: reasons.join('; ') || 'Workspace relevance match'
        });
      }
    }

    // Allocate budget
    const budgetResult = this.budgetManager.allocateBudget(scoredCandidates);

    const explanation = budgetResult.allocations.map((alloc) => {
      const match = scoredCandidates.find((c) => c.filePath === alloc.filePath);
      return {
        filePath: alloc.filePath,
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
