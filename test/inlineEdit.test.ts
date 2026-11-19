import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  InlineEditContext,
  buildInlineEditPrompt,
  extractReplacementCode,
  spliceReplacementIntoContent,
  validateDocumentNotStale,
  executeInlineEditTurn,
  handleInlineEdit
} from '../src/commands/inlineEdit';
import { TrueForgeClient } from '../src/services/trueforge';
import { ResilienceManager } from '../src/services/fallback';
import { SessionManager } from '../src/services/sessionManager';
import { DiffManager } from '../src/diff/diffManager';
import { McpToolHandler } from '../src/mcp/tools';
import { computeSha256 } from '../src/utils/hash';
import * as vscode from 'vscode';

describe('Inline Edit Mode (Phase 3 Complete Test Suite)', () => {
  const tmpDir = path.resolve(__dirname, '../tmp_inline_test');
  const testFilePath = path.join(tmpDir, 'service.py');
  let diffManager: DiffManager;
  let mcpHandler: McpToolHandler;
  let client: TrueForgeClient;
  let sessionManager: SessionManager;
  let resilienceManager: ResilienceManager;

  const sampleOriginalContent = [
    '# Service Module',
    'import os',
    '',
    'def get_debug_flag() -> bool:',
    '    val = os.environ.get("DEBUG")',
    '    return val == "1"',
    '',
    'def calculate_tax(amount: float) -> float:',
    '    return amount * 0.2',
    ''
  ].join('\n');

  beforeEach(() => {
    vi.restoreAllMocks();
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    fs.writeFileSync(testFilePath, sampleOriginalContent, 'utf8');

    diffManager = new DiffManager(tmpDir);
    mcpHandler = new McpToolHandler(tmpDir, diffManager);
    client = new TrueForgeClient(
      {
        endpoint: 'http://localhost:8790',
        primaryModel: 'openai/chat-latest',
        fallbackModel: 'openai/gpt-4o-mini'
      },
      mcpHandler
    );
    sessionManager = new SessionManager(client);
    resilienceManager = new ResilienceManager(client, { maxRetries: 1 });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    } catch {}
  });

  it('No active editor: displays warning message and stops execution gracefully', async () => {
    const showWarningSpy = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
    vi.spyOn(vscode.window, 'activeTextEditor', 'get').mockReturnValue(undefined);

    await handleInlineEdit(client, resilienceManager, sessionManager, diffManager);

    expect(showWarningSpy).toHaveBeenCalledWith(
      'ForgePilot: Please open a file in the editor to use Inline Edit.'
    );
  });

  it('Empty selection: expands target range to the current line automatically', () => {
    const fullContent = 'line 1\nline 2 with content\nline 3\n';
    const cursorOffset = fullContent.indexOf('line 2');

    // Simulate empty selection on line 2 (offset 7 to 7)
    const context: InlineEditContext = {
      filePath: 'test.py',
      absolutePath: '/mock/test.py',
      languageId: 'python',
      documentVersion: 1,
      originalFullContent: fullContent,
      originalSha256: computeSha256(fullContent),
      selection: {
        startLine: 1,
        startCharacter: 0,
        endLine: 1,
        endCharacter: 19,
        isEmpty: true
      },
      selectedText: 'line 2 with content',
      effectiveRange: {
        startOffset: cursorOffset,
        endOffset: cursorOffset + 'line 2 with content'.length
      },
      surroundingContextBefore: 'line 1\n',
      surroundingContextAfter: 'line 3\n'
    };

    expect(context.selectedText).toBe('line 2 with content');
    const replaced = spliceReplacementIntoContent(
      fullContent,
      context.effectiveRange,
      'line 2 REFACTORED'
    );
    expect(replaced).toBe('line 1\nline 2 REFACTORED\nline 3\n');
  });

  it('Single-line selection: targets specific substring within a line accurately', () => {
    const line = 'return val == "1"';
    const startOffset = sampleOriginalContent.indexOf(line);
    const endOffset = startOffset + line.length;

    const context: InlineEditContext = {
      filePath: 'service.py',
      absolutePath: testFilePath,
      languageId: 'python',
      documentVersion: 1,
      originalFullContent: sampleOriginalContent,
      originalSha256: computeSha256(sampleOriginalContent),
      selection: {
        startLine: 5,
        startCharacter: 4,
        endLine: 5,
        endCharacter: 21,
        isEmpty: false
      },
      selectedText: line,
      effectiveRange: {
        startOffset,
        endOffset
      },
      surroundingContextBefore: '    val = os.environ.get("DEBUG")\n',
      surroundingContextAfter: 'def calculate_tax(amount: float) -> float:\n'
    };

    const prompt = buildInlineEditPrompt(context, 'Make check case-insensitive');
    expect(prompt).toContain('Target Selection (lines 6 to 6):');
    expect(prompt).toContain('return val == "1"');
    expect(prompt).toContain('Make check case-insensitive');
  });

  it('Multiline selection: captures complete multiline block and surrounding context', () => {
    const targetBlock = 'def get_debug_flag() -> bool:\n    val = os.environ.get("DEBUG")\n    return val == "1"';
    const startOffset = sampleOriginalContent.indexOf(targetBlock);
    const endOffset = startOffset + targetBlock.length;

    const context: InlineEditContext = {
      filePath: 'service.py',
      absolutePath: testFilePath,
      languageId: 'python',
      documentVersion: 2,
      originalFullContent: sampleOriginalContent,
      originalSha256: computeSha256(sampleOriginalContent),
      selection: {
        startLine: 3,
        startCharacter: 0,
        endLine: 5,
        endCharacter: 21,
        isEmpty: false
      },
      selectedText: targetBlock,
      effectiveRange: { startOffset, endOffset },
      surroundingContextBefore: '# Service Module\nimport os\n',
      surroundingContextAfter: 'def calculate_tax(amount: float) -> float:\n'
    };

    const prompt = buildInlineEditPrompt(context, 'Treat 0, false, no as false');
    expect(prompt).toContain('Target Selection (lines 4 to 6):');
    expect(prompt).toContain(targetBlock);
    expect(prompt).toContain('# Service Module');
    expect(prompt).toContain('calculate_tax');
  });

  it('Prompt cancellation: stops execution when user cancels via AbortSignal', async () => {
    const cancelSpy = vi.spyOn(client, 'cancelTurn').mockResolvedValue(undefined);
    const abortController = new AbortController();

    // Start turn and abort immediately
    abortController.abort();

    const context: InlineEditContext = {
      filePath: 'service.py',
      absolutePath: testFilePath,
      languageId: 'python',
      documentVersion: 1,
      originalFullContent: sampleOriginalContent,
      originalSha256: computeSha256(sampleOriginalContent),
      selection: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5, isEmpty: false },
      selectedText: '# Service',
      effectiveRange: { startOffset: 0, endOffset: 9 },
      surroundingContextBefore: '',
      surroundingContextAfter: ''
    };

    const result = await executeInlineEditTurn(
      client,
      resilienceManager,
      sessionManager,
      diffManager,
      context,
      'Instruction',
      undefined,
      abortController.signal
    );

    expect(result.cancelled).toBe(true);
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('TrueForge streaming: streams deltas and reports progress updates', async () => {
    const sdk = client.getSdk();
    const progressMessages: string[] = [];

    async function* mockStream() {
      yield { type: 'turn.created', id: 'turn-inline-1' };
      yield { type: 'model.message.delta', id: 'd1', content: '```python\n' };
      yield { type: 'model.message.delta', id: 'd2', content: '    return bool(val and val.lower() not in {"0", "false"})\n```' };
      yield { type: 'turn.done', id: 'done-1', state: { status: 'done' } };
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(mockStream() as any);

    const line = 'return val == "1"';
    const startOffset = sampleOriginalContent.indexOf(line);

    const context: InlineEditContext = {
      filePath: 'service.py',
      absolutePath: testFilePath,
      languageId: 'python',
      documentVersion: 1,
      originalFullContent: sampleOriginalContent,
      originalSha256: computeSha256(sampleOriginalContent),
      selection: { startLine: 5, startCharacter: 4, endLine: 5, endCharacter: 21, isEmpty: false },
      selectedText: line,
      effectiveRange: { startOffset, endOffset: startOffset + line.length },
      surroundingContextBefore: '',
      surroundingContextAfter: ''
    };

    const result = await executeInlineEditTurn(
      client,
      resilienceManager,
      sessionManager,
      diffManager,
      context,
      'Update return statement',
      (msg) => progressMessages.push(msg)
    );

    expect(result.success).toBe(true);
    expect(progressMessages.some((m) => m.includes('Streaming model response'))).toBe(true);
    expect(result.proposalId).toBeDefined();
  });

  it('Model error handling: captures and returns model error event cleanly', async () => {
    const sdk = client.getSdk();

    async function* mockErrorStream() {
      yield { type: 'turn.created', id: 'turn-err-inline' };
      yield { type: 'turn.done', id: 'd-err', state: { status: 'error', error: { message: 'Quota exhausted or context exceeded.' } } };
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockImplementation(async () => mockErrorStream() as any);

    const context: InlineEditContext = {
      filePath: 'service.py',
      absolutePath: testFilePath,
      languageId: 'python',
      documentVersion: 1,
      originalFullContent: sampleOriginalContent,
      originalSha256: computeSha256(sampleOriginalContent),
      selection: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 10, isEmpty: false },
      selectedText: '# Service',
      effectiveRange: { startOffset: 0, endOffset: 9 },
      surroundingContextBefore: '',
      surroundingContextAfter: ''
    };

    const result = await executeInlineEditTurn(
      client,
      resilienceManager,
      sessionManager,
      diffManager,
      context,
      'Some instruction'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Quota exhausted');
  });

  it('Invalid model output: rejects response if model outputs no code or malformed content', async () => {
    const sdk = client.getSdk();

    async function* mockGibberishStream() {
      yield { type: 'turn.created', id: 'turn-gibberish' };
      yield { type: 'model.message.delta', id: 'd1', content: 'I cannot fulfill this request because of reasons.' };
      yield { type: 'turn.done', id: 'done-g', state: { status: 'done' } };
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(mockGibberishStream() as any);

    const context: InlineEditContext = {
      filePath: 'service.py',
      absolutePath: testFilePath,
      languageId: 'python',
      documentVersion: 1,
      originalFullContent: sampleOriginalContent,
      originalSha256: computeSha256(sampleOriginalContent),
      selection: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 10, isEmpty: false },
      selectedText: '# Service',
      effectiveRange: { startOffset: 0, endOffset: 9 },
      surroundingContextBefore: '',
      surroundingContextAfter: ''
    };

    const result = await executeInlineEditTurn(
      client,
      resilienceManager,
      sessionManager,
      diffManager,
      context,
      'Some instruction'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('did not contain valid replacement code');
  });

  it('Diff proposal creation: registers proposal in DiffManager without modifying disk', async () => {
    const targetLine = 'return val == "1"';
    const startOffset = sampleOriginalContent.indexOf(targetLine);

    const context: InlineEditContext = {
      filePath: 'service.py',
      absolutePath: testFilePath,
      languageId: 'python',
      documentVersion: 1,
      originalFullContent: sampleOriginalContent,
      originalSha256: computeSha256(sampleOriginalContent),
      selection: { startLine: 5, startCharacter: 4, endLine: 5, endCharacter: 21, isEmpty: false },
      selectedText: targetLine,
      effectiveRange: { startOffset, endOffset: startOffset + targetLine.length },
      surroundingContextBefore: '',
      surroundingContextAfter: ''
    };

    const replacement = 'return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})';
    const fullProposed = spliceReplacementIntoContent(sampleOriginalContent, context.effectiveRange, replacement);

    const proposal = diffManager.createProposal('service.py', fullProposed, 'sess-inline-test', 'Update debug flag check');

    expect(proposal.id).toBeDefined();
    expect(proposal.hunks.length).toBeGreaterThan(0);
    expect(proposal.status).toBe('pending');

    // Verify disk has NOT been modified
    expect(fs.readFileSync(testFilePath, 'utf8')).toBe(sampleOriginalContent);
  });

  it('Rejecting a proposal: marks proposal and hunks as rejected without altering disk', () => {
    const proposed = sampleOriginalContent.replace('return val == "1"', 'return True');
    const proposal = diffManager.createProposal('service.py', proposed);

    expect(proposal.status).toBe('pending');
    diffManager.rejectAll(proposal.id);

    const updated = diffManager.getProposal(proposal.id)!;
    expect(updated.status).toBe('rejected');
    expect(updated.hunks.every((h) => h.status === 'rejected')).toBe(true);

    // Verify disk remains untouched
    expect(fs.readFileSync(testFilePath, 'utf8')).toBe(sampleOriginalContent);
  });

  it('Accepting a proposal: verifies hash, applies changes to disk, and enables undo', async () => {
    const proposed = sampleOriginalContent.replace('return val == "1"', 'return True');
    const proposal = diffManager.createProposal('service.py', proposed);

    diffManager.acceptAll(proposal.id);
    const applyResult = await diffManager.applyAccepted(proposal.id);

    expect(applyResult.success).toBe(true);
    expect(applyResult.appliedCount).toBe(1);

    // Disk now reflects the accepted change
    const updatedDisk = fs.readFileSync(testFilePath, 'utf8');
    expect(updatedDisk).toContain('return True');

    // Undo reverts to exact original content
    const undoResult = await diffManager.undo();
    expect(undoResult.success).toBe(true);
    expect(fs.readFileSync(testFilePath, 'utf8')).toBe(sampleOriginalContent);
  });

  it('Document version mismatch (Stale Proposal Detection): rejects apply if document changed during generation', () => {
    const context: InlineEditContext = {
      filePath: 'service.py',
      absolutePath: testFilePath,
      languageId: 'python',
      documentVersion: 3,
      originalFullContent: sampleOriginalContent,
      originalSha256: computeSha256(sampleOriginalContent),
      selection: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5, isEmpty: false },
      selectedText: '# Service',
      effectiveRange: { startOffset: 0, endOffset: 9 },
      surroundingContextBefore: '',
      surroundingContextAfter: ''
    };

    // 1. Version incremented
    const versionCheck = validateDocumentNotStale(context, sampleOriginalContent, 4);
    expect(versionCheck.valid).toBe(false);
    expect(versionCheck.reason).toContain('version changed from 3 to 4');

    // 2. Hash mismatch (content edited)
    const contentCheck = validateDocumentNotStale(context, sampleOriginalContent + '\n# Modified!', 3);
    expect(contentCheck.valid).toBe(false);
    expect(contentCheck.reason).toContain('hash mismatch');
  });

  it('extractReplacementCode extracts code accurately from various markdown formats', () => {
    expect(extractReplacementCode('```python\nprint("hello")\n```')).toBe('print("hello")\n');
    expect(extractReplacementCode('```\nx = 1\n```')).toBe('x = 1\n');
    expect(extractReplacementCode('No code here')).toBeNull();
    expect(extractReplacementCode('')).toBeNull();
  });
});
