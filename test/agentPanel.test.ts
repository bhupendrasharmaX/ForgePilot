import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  AgentPanelProvider,
  sanitizeToolInput,
  formatToolSummary,
  checkProposalStale,
  serializeProposal,
  TimelineEvent,
  SerializedProposal
} from '../src/providers/agentPanel';
import { TrueForgeClient } from '../src/services/trueforge';
import { ResilienceManager } from '../src/services/fallback';
import { SessionManager } from '../src/services/sessionManager';
import { DiffManager } from '../src/diff/diffManager';
import { ContextRetrievalEngine } from '../src/context/retrieval';
import { computeSha256 } from '../src/utils/hash';
import * as vscode from 'vscode';

describe('Phase 4: Professional Agent Chat & Diff Review Interface', () => {
  const tmpDir = path.resolve(__dirname, '../tmp_panel_test');
  const testFilePath = path.join(tmpDir, 'app.py');
  let diffManager: DiffManager;
  let client: TrueForgeClient;
  let sessionManager: SessionManager;
  let resilienceManager: ResilienceManager;
  let contextEngine: ContextRetrievalEngine;
  let provider: AgentPanelProvider;
  let postedMessages: any[] = [];

  const sampleCode = `def hello():\n    print("Hello World")\n`;

  beforeEach(() => {
    postedMessages = [];
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    fs.writeFileSync(testFilePath, sampleCode, 'utf8');

    diffManager = new DiffManager(tmpDir);
    client = new TrueForgeClient({
      endpoint: 'http://localhost:8790',
      primaryModel: 'gemini-2.5-pro',
      fallbackModel: 'gemini-2.5-flash'
    });
    sessionManager = new SessionManager(client);
    resilienceManager = new ResilienceManager(client);
    contextEngine = new ContextRetrievalEngine(tmpDir, 20000);

    const mockExtensionUri = vscode.Uri.file(__dirname);
    provider = new AgentPanelProvider(
      mockExtensionUri,
      client,
      resilienceManager,
      sessionManager,
      diffManager,
      contextEngine
    );

    // Spy on provider.postMessage
    vi.spyOn(provider, 'postMessage').mockImplementation((msg: any) => {
      postedMessages.push(msg);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Chat rendering: generates complete, branded HTML with sidebar tabs and header', () => {
    const mockWebview = {
      asWebviewUri: (uri: any) => uri,
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: async () => true
    } as any;

    const html = provider.getHtmlForWebview(mockWebview);

    expect(html).toContain('ForgePilot');
    expect(html).toContain('statusDot');
    expect(html).toContain('tab-chat');
    expect(html).toContain('tab-diff');
    expect(html).toContain('tab-context');
    expect(html).toContain('promptInput');
    expect(html).toContain('sendBtn');
    expect(html).toContain('newSessionBtn');
    expect(html).toContain('Copy Response');
    expect(html).toContain('Ctrl+Enter to send');
  });

  it('Tool input sanitization: masks sensitive keys without destroying non-sensitive data', () => {
    const inputWithSecrets = {
      filePath: 'src/config.py',
      apiKey: 'sk-secret-123456789',
      password: 'supersecretpassword',
      authToken: 'bearer-xyz',
      nested: {
        db_key: 'db-pass-999',
        normalField: 'hello'
      }
    };

    const sanitized = sanitizeToolInput('read_file', inputWithSecrets);

    expect(sanitized.filePath).toBe('src/config.py');
    expect(sanitized.apiKey).toBe('***');
    expect(sanitized.password).toBe('***');
    expect(sanitized.authToken).toBe('***');
    expect(sanitized.nested.db_key).toBe('***');
    expect(sanitized.nested.normalField).toBe('hello');
  });

  it('Tool summary formatting: produces concise human-readable summaries for MCP tools', () => {
    expect(formatToolSummary('list_files', { files: ['a.py', 'b.py', 'c.py'] })).toBe(
      'Discovered 3 file(s) in workspace'
    );
    expect(formatToolSummary('search_workspace', { matches: [{ file: 'a.py' }] })).toBe(
      'Found 1 matching code segment(s)'
    );
    expect(formatToolSummary('read_file', { content: 'line1\nline2\nline3\n' })).toBe(
      'Read file content (4 lines)'
    );
    expect(formatToolSummary('get_symbols', { symbols: [{ name: 'test' }] })).toBe(
      'Extracted 1 symbol definition(s)'
    );
    expect(formatToolSummary('propose_edit', { filePath: 'app.py' })).toBe(
      'Created diff proposal for app.py'
    );
  });

  it('Live timeline and message streaming: emits agent_started, delta, tool_call, and turn_complete', async () => {
    const sdk = client.getSdk();

    async function* mockTimelineStream() {
      yield { type: 'turn.created', id: 'turn-tl-1' };
      yield {
        type: 'model.message',
        id: 'msg-101',
        toolCalls: [
          {
            id: 'call-101',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: { path: 'app.py' }
            }
          }
        ]
      };
      yield {
        type: 'model.message.delta',
        id: 'delta-101',
        content: 'I have inspected the file.'
      };
      yield {
        type: 'turn.done',
        id: 'done-101',
        state: { status: 'done' }
      };
    }

    vi.spyOn(sdk.sessions, 'create').mockResolvedValue({ id: 'sess-tl-1' } as any);
    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(mockTimelineStream() as any);

    await provider.handleUserMessage('Inspect app.py and plan changes');

    const timelineEvents = postedMessages
      .filter((m) => m.type === 'timelineEvent')
      .map((m) => m.event);

    expect(timelineEvents.some((e: TimelineEvent) => e.eventType === 'agent_started')).toBe(true);
    expect(timelineEvents.some((e: TimelineEvent) => e.eventType === 'context_retrieval')).toBe(true);
    expect(timelineEvents.some((e: TimelineEvent) => e.eventType === 'tool_call')).toBe(true);
    expect(timelineEvents.some((e: TimelineEvent) => e.eventType === 'turn_complete')).toBe(true);

    const deltas = postedMessages.filter((m) => m.type === 'agentDelta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0].delta).toBe('I have inspected the file.');
  });

  it('Context Explorer: posts context breakdown with token budget, percentage, and file reasons', async () => {
    const sdk = client.getSdk();
    async function* emptyStream() {
      yield { type: 'turn.created', id: 'turn-ctx-1' };
      yield { type: 'turn.done', id: 'done-ctx-1', state: { status: 'done' } };
    }
    vi.spyOn(sdk.sessions, 'create').mockResolvedValue({ id: 'sess-ctx-1' } as any);
    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(emptyStream() as any);

    await provider.handleUserMessage('What does app.py do?');

    const ctxMsg = postedMessages.find((m) => m.type === 'contextRetrieved');
    expect(ctxMsg).toBeDefined();
    expect(ctxMsg.context.tokenBudget).toBe(20000);
    expect(ctxMsg.context.totalTokens).toBeGreaterThanOrEqual(0);
    expect(ctxMsg.context.percentage).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(ctxMsg.context.files)).toBe(true);
  });

  it('Unified diff proposal serialization: correctly calculates additions, deletions, and hunks', () => {
    const modifiedCode = `def hello():\n    print("Hello ForgePilot")\n    print("New Line")\n`;
    const proposal = diffManager.createProposal('app.py', modifiedCode, 'sess-1', 'Test Proposal');

    const serialized = serializeProposal(proposal);

    expect(serialized.filePath).toBe('app.py');
    expect(serialized.isStale).toBe(false);
    expect(serialized.mode).toBe('Autonomous Agent');
    expect(serialized.addedLines).toBeGreaterThan(0);
    expect(serialized.totalHunks).toBeGreaterThan(0);
    expect(serialized.hunks[0].status).toBe('pending');
  });

  it('Per-hunk acceptance and rejection: updates proposal and hunk status in unified manager', () => {
    const modifiedCode = `def hello():\n    print("Hello Universe")\n`;
    const proposal = diffManager.createProposal('app.py', modifiedCode);
    const hunkId = proposal.hunks[0].id;

    expect(proposal.hunks[0].status).toBe('pending');

    // Accept hunk
    diffManager.acceptHunk(proposal.id, hunkId);
    let serialized = serializeProposal(diffManager.getProposal(proposal.id)!);
    expect(serialized.acceptedHunks).toBe(1);
    expect(serialized.hunks[0].status).toBe('accepted');

    // Reject hunk
    diffManager.rejectHunk(proposal.id, hunkId);
    serialized = serializeProposal(diffManager.getProposal(proposal.id)!);
    expect(serialized.rejectedHunks).toBe(1);
    expect(serialized.hunks[0].status).toBe('rejected');
  });

  it('Accept All and Reject All: bulk updates all hunks across the proposal', () => {
    const modifiedCode = `def hello():\n    print("Changed")\n`;
    const proposal = diffManager.createProposal('app.py', modifiedCode);

    diffManager.acceptAll(proposal.id);
    let serialized = serializeProposal(diffManager.getProposal(proposal.id)!);
    expect(serialized.acceptedHunks).toBe(serialized.totalHunks);
    expect(serialized.status).toBe('accepted');

    diffManager.rejectAll(proposal.id);
    serialized = serializeProposal(diffManager.getProposal(proposal.id)!);
    expect(serialized.rejectedHunks).toBe(serialized.totalHunks);
    expect(serialized.status).toBe('rejected');
  });

  it('Stale proposal detection: flags proposal as stale when disk content changes after generation', () => {
    const modifiedCode = `def hello():\n    print("Proposed Edit")\n`;
    const proposal = diffManager.createProposal('app.py', modifiedCode);

    expect(checkProposalStale(proposal).isStale).toBe(false);

    // Modify file on disk externally
    fs.writeFileSync(testFilePath, 'def hello():\n    # Externally modified\n', 'utf8');

    const staleResult = checkProposalStale(proposal);
    expect(staleResult.isStale).toBe(true);
    expect(staleResult.reason).toContain('File on disk has been modified');

    const serialized = serializeProposal(proposal);
    expect(serialized.isStale).toBe(true);
    expect(serialized.status).toBe('stale');
  });

  it('Inline Edit opens unified diff review: showProposal broadcasts proposal focus event', () => {
    const inlineProposal = diffManager.createProposal(
      'app.py',
      `def hello():\n    print("Inline Change")\n`,
      'inline-sess-1',
      'Inline Edit'
    );

    const serialized = serializeProposal(inlineProposal);
    expect(serialized.mode).toBe('Inline Edit');

    provider.showProposal(inlineProposal.id);

    const showMsg = postedMessages.find((m) => m.type === 'showProposal');
    expect(showMsg).toBeDefined();
    expect(showMsg.proposalId).toBe(inlineProposal.id);
  });

  it('Cancellation and Error states: cancels active turn and updates UI status', async () => {
    const sdk = client.getSdk();
    vi.spyOn(sdk.sessions, 'cancel').mockResolvedValue({} as any);

    // Simulate session exists
    const session = await sessionManager.getOrCreateSession();
    await provider.handleCancelTurn();

    expect(sdk.sessions.cancel).toHaveBeenCalledWith(session.id);
    expect(postedMessages.some((m) => m.type === 'agentCancelled')).toBe(true);
    expect(postedMessages.some((m) => m.type === 'statusChange' && m.status === 'idle')).toBe(true);
  });

  it('Apply Changes and Undo: writes changes to disk safely and rolls back cleanly', async () => {
    const newContent = `def hello():\n    print("Applied Version")\n`;
    const proposal = diffManager.createProposal('app.py', newContent);
    diffManager.acceptAll(proposal.id);

    await provider.handleApplyChanges(proposal.id);

    expect(fs.readFileSync(testFilePath, 'utf8')).toBe(newContent);
    expect(diffManager.canUndo()).toBe(true);

    const applyMsg = postedMessages.find((m) => m.type === 'applyResult');
    expect(applyMsg).toBeDefined();
    expect(applyMsg.result.success).toBe(true);

    // Perform Undo
    await provider.handleUndo();
    expect(fs.readFileSync(testFilePath, 'utf8')).toBe(sampleCode);

    const undoMsg = postedMessages.find((m) => m.type === 'undoResult');
    expect(undoMsg).toBeDefined();
    expect(undoMsg.result.success).toBe(true);
  });
});
