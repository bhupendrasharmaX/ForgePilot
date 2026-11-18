import * as fs from 'fs';
import * as path from 'path';

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'variable' | 'constant';
  line: number;
  filePath: string;
  signature?: string;
}

export class SymbolIndex {
  private symbols: CodeSymbol[] = [];
  private symbolMap: Map<string, CodeSymbol[]> = new Map();

  /**
   * Extracts symbols from a single file by inspecting its text patterns.
   */
  public extractSymbolsFromFile(filePath: string, content: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split(/\r?\n/);
    const ext = path.extname(filePath).toLowerCase();

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const trimmed = lineText.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }

      // Python parsing
      if (ext === '.py') {
        const defMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\((.*?)\):/);
        if (defMatch) {
          symbols.push({
            name: defMatch[1],
            kind: 'function',
            line: i + 1,
            filePath,
            signature: defMatch[0]
          });
          continue;
        }

        const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)(?:\((.*?)\))?:/);
        if (classMatch) {
          symbols.push({
            name: classMatch[1],
            kind: 'class',
            line: i + 1,
            filePath,
            signature: classMatch[0]
          });
          continue;
        }
      }

      // JS / TS parsing
      if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        const fnMatch = trimmed.match(
          /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\((.*?)\)/
        );
        if (fnMatch) {
          symbols.push({
            name: fnMatch[1],
            kind: 'function',
            line: i + 1,
            filePath,
            signature: fnMatch[0]
          });
          continue;
        }

        const arrowFnMatch = trimmed.match(
          /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\((.*?)\)\s*=>/
        );
        if (arrowFnMatch) {
          symbols.push({
            name: arrowFnMatch[1],
            kind: 'function',
            line: i + 1,
            filePath,
            signature: arrowFnMatch[0]
          });
          continue;
        }

        const classMatch = trimmed.match(/(?:export\s+)?class\s+([a-zA-Z0-9_]+)/);
        if (classMatch) {
          symbols.push({
            name: classMatch[1],
            kind: 'class',
            line: i + 1,
            filePath,
            signature: classMatch[0]
          });
          continue;
        }

        const interfaceMatch = trimmed.match(/(?:export\s+)?interface\s+([a-zA-Z0-9_]+)/);
        if (interfaceMatch) {
          symbols.push({
            name: interfaceMatch[1],
            kind: 'interface',
            line: i + 1,
            filePath,
            signature: interfaceMatch[0]
          });
          continue;
        }
      }
    }

    return symbols;
  }

  public indexWorkspaceFiles(files: Array<{ filePath: string; content: string }>): void {
    this.symbols = [];
    this.symbolMap.clear();

    for (const f of files) {
      const extracted = this.extractSymbolsFromFile(f.filePath, f.content);
      this.symbols.push(...extracted);

      for (const sym of extracted) {
        const lowerName = sym.name.toLowerCase();
        const existing = this.symbolMap.get(lowerName) || [];
        existing.push(sym);
        this.symbolMap.set(lowerName, existing);
      }
    }
  }

  public findSymbols(nameQuery: string): CodeSymbol[] {
    const q = nameQuery.toLowerCase().trim();
    if (!q) return [];

    const exact = this.symbolMap.get(q);
    if (exact) return exact;

    // Substring match
    return this.symbols.filter((s) => s.name.toLowerCase().includes(q));
  }

  public getAllSymbols(): CodeSymbol[] {
    return [...this.symbols];
  }
}
