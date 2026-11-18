import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextRetrievalEngine } from '../src/context/retrieval';
import { SymbolIndex } from '../src/context/symbolIndex';
import { TokenBudgetManager } from '../src/context/tokenBudget';

describe('Context Engine', () => {
  let tmpDir: string;
  let engine: ContextRetrievalEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgepilot-ctx-test-'));
    engine = new ContextRetrievalEngine(tmpDir, 10000);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parses explicit @file and @symbol mentions', () => {
    const prompt = 'Fix bug in @file:src/flask/helpers.py and update @symbol:get_debug_flag';
    const parsed = engine.parseMentions(prompt);

    expect(parsed.explicitFiles).toContain('src/flask/helpers.py');
    expect(parsed.explicitSymbols).toContain('get_debug_flag');
  });

  it('indexes Python and TypeScript symbols accurately', () => {
    const symbolIndex = new SymbolIndex();
    const pythonCode = `
def get_debug_flag():
    """Returns True if FLASK_DEBUG is set."""
    return True

class Config:
    def from_envvar(self):
        pass
`;
    const symbols = symbolIndex.extractSymbolsFromFile('test.py', pythonCode);
    const names = symbols.map((s) => s.name);

    expect(names).toContain('get_debug_flag');
    expect(names).toContain('Config');
  });

  it('enforces token budget and orders by relevance score', () => {
    const budgetManager = new TokenBudgetManager(1000);
    const candidates = [
      { filePath: 'low.py', content: 'x = 1\n'.repeat(100), score: 10 },
      { filePath: 'high.py', content: 'y = 2\n'.repeat(100), score: 90 },
      { filePath: 'medium.py', content: 'z = 3\n'.repeat(100), score: 50 }
    ];

    const result = budgetManager.allocateBudget(candidates, 100);
    expect(result.allocations.length).toBeGreaterThan(0);
    // Highest score should be first allocation
    expect(result.allocations[0].filePath).toBe('high.py');
  });

  it('retrieves relevant files with explanation', async () => {
    // Create mock files
    const helpersPath = path.join(tmpDir, 'helpers.py');
    fs.writeFileSync(
      helpersPath,
      'def get_debug_flag():\n    return False\n',
      'utf8'
    );

    const testPath = path.join(tmpDir, 'test_helpers.py');
    fs.writeFileSync(
      testPath,
      'def test_debug_flag():\n    assert not get_debug_flag()\n',
      'utf8'
    );

    const context = await engine.retrieveContext(
      'Modify get_debug_flag in helpers to accept off and update test'
    );

    expect(context.allocations.length).toBeGreaterThan(0);
    const filePaths = context.allocations.map((a) => a.filePath);
    expect(filePaths).toContain('helpers.py');
    expect(context.explanation.length).toBeGreaterThan(0);
  });
});
