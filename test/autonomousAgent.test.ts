import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TrueForgeClient } from '../src/services/trueforge';
import { McpToolHandler } from '../src/mcp/tools';
import { DiffManager } from '../src/diff/diffManager';
import { ContextRetrievalEngine } from '../src/context/retrieval';
import { TrueForgeConfig } from '../src/services/types';

describe('Autonomous Agent Mode (Phase 2 Deterministic Tests)', () => {
  const flaskRoot = path.resolve(__dirname, '../flask');
  let diffManager: DiffManager;
  let mcpHandler: McpToolHandler;
  let client: TrueForgeClient;
  let contextEngine: ContextRetrievalEngine;

  const config: TrueForgeConfig = {
    endpoint: 'http://localhost:8790',
    apiKey: 'test-key',
    primaryModel: 'openai/chat-latest',
    fallbackModel: 'openai/gpt-4o-mini',
    timeoutMs: 5000,
    maxRetries: 2
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    diffManager = new DiffManager(flaskRoot);
    mcpHandler = new McpToolHandler(flaskRoot, diffManager);
    client = new TrueForgeClient(config, mcpHandler);
    contextEngine = new ContextRetrievalEngine(flaskRoot, 25000);
  });

  afterEach(() => {
    diffManager.clear();
  });

  it('Autonomous file discovery: discovers CLI, tests, and docs for Task B without hardcoded filenames', async () => {
    const prompt = `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;

    // No filenames are mentioned in prompt
    expect(prompt.includes('cli.py')).toBe(false);
    expect(prompt.includes('test_cli.py')).toBe(false);
    expect(prompt.includes('cli.rst')).toBe(false);

    const context = await contextEngine.retrieveContext(prompt);
    const allocatedPaths = context.allocations.map((a) => a.filePath.replace(/\\/g, '/'));

    // 1. Implementation file discovered
    expect(allocatedPaths.some((p) => p === 'src/flask/cli.py')).toBe(true);

    // 2. Test file discovered
    expect(allocatedPaths.some((p) => p === 'tests/test_cli.py')).toBe(true);

    // 3. Documentation file discovered
    expect(allocatedPaths.some((p) => p === 'docs/cli.rst')).toBe(true);

    // Verify structured explanation covers categories
    const categories = new Set(context.explanation.map((e) => e.category));
    expect(categories.has('source')).toBe(true);
    expect(categories.has('test')).toBe(true);
    expect(categories.has('documentation')).toBe(true);
  });

  it('Token budget enforcement: compacts and truncates lower-ranked files when exceeding budget', async () => {
    const tightEngine = new ContextRetrievalEngine(flaskRoot, 12000);
    const prompt = 'flask config cli test and documentation';

    const context = await tightEngine.retrieveContext(prompt);
    expect(context.totalTokens).toBeLessThanOrEqual(12000);
    expect(context.allocations.length).toBeGreaterThan(0);
  });

  it('Multiple sequential MCP tool calls in one turn with tool-response submission', async () => {
    const sdk = client.getSdk();
    const createTurnEventsSpy = vi.spyOn(sdk.sessions, 'createTurnEvents').mockResolvedValue({} as any);

    // Mock an autonomous agent stream that issues:
    // 1. search_workspace
    // 2. read_file
    // 3. propose_edit
    async function* multiToolTurnStream() {
      yield {
        type: 'turn.created',
        id: 'turn-multi-1',
        createdAt: '2026-11-19T00:00:00Z'
      };

      // Tool call 1: search_workspace
      yield {
        type: 'model.message',
        id: 'msg-search',
        toolCalls: [
          {
            id: 'call-search-1',
            function: {
              name: 'search_workspace',
              arguments: JSON.stringify({ query: 'FlaskGroup' })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'req-search',
        threadId: 'main',
        toolCalls: [{ id: 'call-search-1', sourceEventId: 'msg-search' }]
      };

      // Tool call 2: read_file
      yield {
        type: 'model.message',
        id: 'msg-read',
        toolCalls: [
          {
            id: 'call-read-1',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'src/flask/__init__.py', startLine: 1, endLine: 10 })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'req-read',
        threadId: 'main',
        toolCalls: [{ id: 'call-read-1', sourceEventId: 'msg-read' }]
      };

      // Tool call 3: propose_edit
      yield {
        type: 'model.message',
        id: 'msg-propose',
        toolCalls: [
          {
            id: 'call-prop-1',
            function: {
              name: 'propose_edit',
              arguments: JSON.stringify({
                path: 'src/flask/__init__.py',
                proposedContent: '# Mock edit\n',
                summary: 'Add test comment'
              })
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'req-prop',
        threadId: 'main',
        toolCalls: [{ id: 'call-prop-1', sourceEventId: 'msg-propose' }]
      };

      // Final assistant summary delta and turn.done
      yield {
        type: 'model.message.delta',
        id: 'delta-done',
        content: 'Proposed changes across workspace files.'
      };
      yield {
        type: 'turn.done',
        id: 'done-multi',
        state: { status: 'done' }
      };
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(multiToolTurnStream() as any);

    const events: any[] = [];
    for await (const evt of client.streamTurn('sess-auto-1', 'Perform autonomous inspection')) {
      events.push(evt);
    }

    // Verify all tool calls and results were captured
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls.length).toBe(3);
    expect(toolCalls[0].toolCall.tool).toBe('search_workspace');
    expect(toolCalls[1].toolCall.tool).toBe('read_file');
    expect(toolCalls[2].toolCall.tool).toBe('propose_edit');

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.length).toBe(3);

    // Verify createTurnEvents was called 3 times to return tool outputs to TrueForge
    expect(createTurnEventsSpy).toHaveBeenCalledTimes(3);
    expect(createTurnEventsSpy).toHaveBeenLastCalledWith(
      'sess-auto-1',
      'turn-multi-1',
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            type: 'user.tool_response',
            toolCallId: 'call-prop-1'
          })
        ])
      })
    );

    // Verify propose_edit registered proposal in DiffManager without modifying disk
    const proposals = diffManager.listProposals();
    expect(proposals.length).toBe(1);
    expect(proposals[0].filePath).toBe('src/flask/__init__.py');
  });

  it('Tool validation errors: handles invalid arguments cleanly without crashing turn', async () => {
    const sdk = client.getSdk();
    const createTurnEventsSpy = vi.spyOn(sdk.sessions, 'createTurnEvents').mockResolvedValue({} as any);

    async function* invalidToolTurnStream() {
      yield { type: 'turn.created', id: 'turn-err-1' };
      yield {
        type: 'model.message',
        id: 'msg-bad',
        toolCalls: [
          {
            id: 'call-bad-1',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({}) // Missing required 'path'
            }
          }
        ]
      };
      yield {
        type: 'tool.response_required',
        id: 'req-bad',
        threadId: 'main',
        toolCalls: [{ id: 'call-bad-1', sourceEventId: 'msg-bad' }]
      };
      yield { type: 'turn.done', id: 'done-err', state: { status: 'done' } };
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(invalidToolTurnStream() as any);

    const events: any[] = [];
    for await (const evt of client.streamTurn('sess-err-1', 'Do action')) {
      events.push(evt);
    }

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult?.toolResult?.result?.error).toContain("Missing or invalid required argument 'path'");

    // Error is transmitted back to TrueForge so agent can correct itself
    expect(createTurnEventsSpy).toHaveBeenCalledWith(
      'sess-err-1',
      'turn-err-1',
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            type: 'user.tool_response',
            toolCallId: 'call-bad-1',
            content: expect.stringContaining("Missing or invalid required argument 'path'")
          })
        ])
      })
    );
  });

  it('Multi-file edit safety: never writes to disk before approval, supports per-hunk review', async () => {
    const cliPath = path.join(flaskRoot, 'src/flask/cli.py');
    const originalContent = fs.readFileSync(cliPath, 'utf8');

    // Create a 2-hunk proposal
    const proposedContent = originalContent
      .replace('def get_version', 'def get_version_custom')
      .replace('class FlaskGroup', 'class FlaskGroupCustom');

    const proposal = diffManager.createProposal('src/flask/cli.py', proposedContent);
    expect(proposal.hunks.length).toBeGreaterThanOrEqual(2);

    // Verify disk is completely untouched
    const diskContent = fs.readFileSync(cliPath, 'utf8');
    expect(diskContent).toBe(originalContent);

    // Accept only hunk 0, reject hunk 1
    diffManager.acceptHunk(proposal.id, proposal.hunks[0].id);
    diffManager.rejectHunk(proposal.id, proposal.hunks[1].id);

    const updatedProposal = diffManager.getProposal(proposal.id)!;
    expect(updatedProposal.status).toBe('partially_accepted');
    expect(updatedProposal.hunks[0].status).toBe('accepted');
    expect(updatedProposal.hunks[1].status).toBe('rejected');
  });

  it('Stale-file detection: rejects apply if file was modified externally after proposal', async () => {
    const tmpFile = path.join(flaskRoot, 'tests', 'temp_stale_test.py');
    fs.writeFileSync(tmpFile, 'initial_content = True\n', 'utf8');

    try {
      const proposal = diffManager.createProposal(
        'tests/temp_stale_test.py',
        'initial_content = False\n'
      );
      diffManager.acceptAll(proposal.id);

      // Externally modify file on disk before applying
      fs.writeFileSync(tmpFile, 'external_collision_write = True\n', 'utf8');

      const applyRes = await diffManager.applyAccepted(proposal.id);
      expect(applyRes.success).toBe(false);
      expect(applyRes.staleFiles).toContain('tests/temp_stale_test.py');
      expect(proposal.status).toBe('stale');

      // Verify the external collision file was NOT overwritten
      expect(fs.readFileSync(tmpFile, 'utf8')).toBe('external_collision_write = True\n');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('Cancellation during active tool workflow aborts turn and halts execution', async () => {
    const sdk = client.getSdk();
    const cancelSpy = vi.spyOn(sdk.sessions, 'cancel').mockResolvedValue({} as any);

    let streamStopped = false;
    async function* endlessToolStream() {
      yield { type: 'turn.created', id: 'turn-cancel-mid' };
      yield {
        type: 'model.message',
        id: 'msg-cancel-1',
        toolCalls: [
          {
            id: 'call-hang',
            function: {
              name: 'search_workspace',
              arguments: JSON.stringify({ query: 'slow' })
            }
          }
        ]
      };
      // Hang waiting for cancel
      await new Promise((resolve) => setTimeout(resolve, 5000));
      streamStopped = true;
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockImplementation(async (_s, _r, opts: any) => {
      opts?.abortSignal?.addEventListener('abort', () => {
        streamStopped = true;
      });
      return endlessToolStream() as any;
    });

    const iterator = client.streamTurn('sess-cancel-wf', 'Perform task');
    await iterator[Symbol.asyncIterator]().next(); // turn_start
    const secondPromise = iterator[Symbol.asyncIterator]().next(); // initiates createTurnStream

    // Cancel while active
    await client.cancelTurn('sess-cancel-wf');
    const result = await secondPromise;

    expect(cancelSpy).toHaveBeenCalledWith('sess-cancel-wf');
    expect(streamStopped).toBe(true);
    expect(result.value.type).toBe('cancelled');
  });
});

