import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrueForgeClient } from '../src/services/trueforge';
import { ResilienceManager } from '../src/services/fallback';
import { TrueForgeConfig } from '../src/services/types';
import { TrueForge, TrueForgeError, TrueForgeTimeoutError } from '@truefoundry/trueforge-sdk';

describe('TrueForge Official SDK Integration (Mocked Unit Tests)', () => {
  const config: TrueForgeConfig = {
    endpoint: 'http://localhost:8790',
    apiKey: 'test-key',
    primaryModel: 'openai/gpt-4o',
    fallbackModel: 'openai/gpt-4o-mini',
    timeoutMs: 5000,
    maxRetries: 3
  };

  let client: TrueForgeClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new TrueForgeClient(config);
  });

  it('initializes official TrueForge SDK with configured options', () => {
    const sdk = client.getSdk();
    expect(sdk).toBeInstanceOf(TrueForge);
    expect(client.getConfig().endpoint).toBe('http://localhost:8790');
    expect(client.getConfig().apiKey).toBe('test-key');
  });

  it('creates a TrueForge session via client.sessions.create()', async () => {
    const sdk = client.getSdk();
    const mockSession = {
      data: {
        id: 'sess-official-sdk-123',
        title: 'ForgePilot Session 1',
        createdAt: '2026-11-19T00:00:00.000Z',
        updatedAt: '2026-11-19T00:00:01.000Z'
      }
    };

    const createSpy = vi.spyOn(sdk.sessions, 'create').mockResolvedValue(mockSession as any);

    const session = await client.createSession('ForgePilot Session 1');

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: { name: 'forgepilot-agent' },
        metadata: expect.objectContaining({
          title: 'ForgePilot Session 1',
          source: 'forgepilot-vscode'
        })
      })
    );
    expect(session.id).toBe('sess-official-sdk-123');
    expect(session.title).toBe('ForgePilot Session 1');
    expect(session.status).toBe('active');
  });

  it('handles createSession error when server returns an error', async () => {
    const sdk = client.getSdk();
    vi.spyOn(sdk.sessions, 'create').mockRejectedValue(new Error('Connection refused'));

    await expect(client.createSession('Test')).rejects.toThrow(
      'TrueForge createSession failed: Connection refused'
    );
  });

  it('processes official SDK turn stream events: turn.created, model.message.delta, and turn.done', async () => {
    const sdk = client.getSdk();

    async function* mockStreamGenerator() {
      yield {
        type: 'turn.created',
        id: 'turn-999',
        createdAt: '2026-11-19T00:00:00Z',
        state: { status: 'running' }
      };
      yield {
        type: 'model.message.delta',
        id: 'delta-1',
        content: 'Hello '
      };
      yield {
        type: 'model.message.delta',
        id: 'delta-2',
        content: 'from TrueForge SDK!'
      };
      yield {
        type: 'turn.done',
        id: 'done-1',
        state: { status: 'done' }
      };
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(mockStreamGenerator() as any);

    const events: any[] = [];
    for await (const event of client.streamTurn('sess-1', 'Hello')) {
      events.push(event);
    }

    expect(events[0].type).toBe('turn_start');
    const startEvents = events.filter((e) => e.type === 'turn_start');
    expect(startEvents.some((e) => e.turnId === 'turn-999')).toBe(true);

    const textDeltas = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
    expect(textDeltas).toBe('Hello from TrueForge SDK!');

    const completed = events.find((e) => e.type === 'turn_complete');
    expect(completed).toBeDefined();
    expect(completed?.turnId).toBe('turn-999');
  });

  it('processes model.message with tool calls and executes them via MCP handler', async () => {
    const sdk = client.getSdk();
    const mockMcpHandler = {
      readFile: vi.fn().mockResolvedValue({ content: 'def test(): pass' }),
      searchWorkspace: vi.fn(),
      listFiles: vi.fn(),
      getSymbols: vi.fn(),
      getReferences: vi.fn(),
      getWorkspaceContext: vi.fn(),
      proposeEdit: vi.fn(),
      runCommand: vi.fn(),
      runTests: vi.fn(),
      getGitStatus: vi.fn(),
      getFileDiff: vi.fn(),
      inspectProject: vi.fn()
    };
    client.setMcpHandler(mockMcpHandler as any);

    async function* mockStreamWithToolCall() {
      yield {
        type: 'turn.created',
        id: 'turn-tc-1',
        createdAt: '2026-11-19T00:00:00Z'
      };
      yield {
        type: 'model.message',
        id: 'msg-1',
        toolCalls: [
          {
            id: 'call-read-file-1',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'test.py' })
            }
          }
        ]
      };
      yield {
        type: 'turn.done',
        id: 'done-1',
        state: { status: 'done' }
      };
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(mockStreamWithToolCall() as any);

    const events: any[] = [];
    for await (const event of client.streamTurn('sess-1', 'Read test.py')) {
      events.push(event);
    }

    expect(mockMcpHandler.readFile).toHaveBeenCalledWith({ path: 'test.py' });
    const toolCallEvent = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvent?.toolCall?.tool).toBe('read_file');
    expect(toolCallEvent?.toolCall?.callId).toBe('call-read-file-1');

    const toolResultEvent = events.find((e) => e.type === 'tool_result');
    expect(toolResultEvent?.toolResult?.callId).toBe('call-read-file-1');
    expect(toolResultEvent?.toolResult?.result).toEqual({ content: 'def test(): pass' });
  });

  it('processes tool.approval_required and tool.response_required events', async () => {
    const sdk = client.getSdk();
    const createTurnEventsSpy = vi.spyOn(sdk.sessions, 'createTurnEvents').mockResolvedValue({} as any);

    async function* mockStreamWithApprovalAndResponse() {
      yield {
        type: 'turn.created',
        id: 'turn-approval-1',
        createdAt: '2026-11-19T00:00:00Z'
      };
      yield {
        type: 'tool.approval_required',
        id: 'appr-evt-1',
        threadId: 'main',
        toolCalls: [{ id: 'tc-dangerous-cmd-1', sourceEventId: 'src-1' }]
      };
      yield {
        type: 'tool.response_required',
        id: 'resp-evt-1',
        threadId: 'main',
        toolCalls: [{ id: 'tc-dangerous-cmd-1', sourceEventId: 'src-1' }]
      };
      yield {
        type: 'turn.done',
        id: 'done-1',
        state: { status: 'done' }
      };
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockResolvedValue(mockStreamWithApprovalAndResponse() as any);

    const events: any[] = [];
    for await (const event of client.streamTurn('sess-1', 'Run action')) {
      events.push(event);
    }

    const approval = events.find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    expect(approval?.approval?.callId).toBe('tc-dangerous-cmd-1');

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toBeDefined();
    expect(result?.toolResult?.callId).toBe('tc-dangerous-cmd-1');

    // Verified that SDK's createTurnEvents was called to return tool response
    expect(createTurnEventsSpy).toHaveBeenCalledWith(
      'sess-1',
      'turn-approval-1',
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            type: 'user.tool_response',
            toolCallId: 'tc-dangerous-cmd-1'
          })
        ])
      })
    );
  });

  it('executes server-side cancellation via client.sessions.cancel(sessionId) and aborts local stream', async () => {
    const sdk = client.getSdk();
    const cancelSpy = vi.spyOn(sdk.sessions, 'cancel').mockResolvedValue({} as any);

    // Start a stream that will be cancelled
    let streamAborted = false;
    async function* hangingStream() {
      try {
        yield { type: 'turn.created', id: 'turn-hang', createdAt: '2026-11-19T00:00:00Z' };
        yield { type: 'model.message.delta', id: 'd-1', content: 'Starting...' };
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 5000);
          // When aborted, the abort signal should fire
        });
      } catch {
        streamAborted = true;
      }
    }

    vi.spyOn(sdk.sessions, 'createTurnStream').mockImplementation(async (_sess, _req, opts: any) => {
      opts?.abortSignal?.addEventListener('abort', () => {
        streamAborted = true;
      });
      return hangingStream() as any;
    });

    const streamIterator = client.streamTurn('sess-cancel-test', 'Start long task');
    const firstEvent = await streamIterator[Symbol.asyncIterator]().next();
    expect(firstEvent.value.type).toBe('turn_start');

    // Advance to trigger createTurnStream invocation
    const nextEventPromise = streamIterator[Symbol.asyncIterator]().next();

    // Cancel turn while stream is active
    await client.cancelTurn('sess-cancel-test');
    const cancelledEvent = await nextEventPromise;

    expect(cancelSpy).toHaveBeenCalledWith('sess-cancel-test');
    expect(streamAborted).toBe(true);
    expect(cancelledEvent.value.type).toBe('cancelled');
  });

  it('handles server timeout error cleanly', async () => {
    const sdk = client.getSdk();
    vi.spyOn(sdk.sessions, 'createTurnStream').mockRejectedValue(
      new TrueForgeTimeoutError('Request exceeded timeout threshold of 5 seconds')
    );

    const events: any[] = [];
    for await (const event of client.streamTurn('sess-1', 'Hi')) {
      events.push(event);
    }

    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err?.error).toContain('TrueForge request timed out');
  });

  it('resilience switches to fallback model on quota error with official SDK client', async () => {
    const sdk = client.getSdk();
    const fallbackSpy = vi.fn();

    const resilience = new ResilienceManager(client, {
      maxRetries: 2,
      initialDelayMs: 10,
      onFallback: fallbackSpy
    });

    let callCount = 0;
    vi.spyOn(sdk.sessions, 'createTurnStream').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Rate limit exceeded: 429 quota exhausted on primaryModel');
      }

      async function* fallbackSuccess() {
        yield {
          type: 'model.message.delta',
          id: 'fb-1',
          content: 'Recovered via fallback model!'
        };
        yield {
          type: 'turn.done',
          id: 'fb-done',
          state: { status: 'done' }
        };
      }
      return fallbackSuccess() as any;
    });

    const events: any[] = [];
    for await (const event of resilience.executeWithResilience('sess-fallback-test', 'Task prompt')) {
      events.push(event);
    }

    expect(fallbackSpy).toHaveBeenCalledWith('openai/gpt-4o', 'openai/gpt-4o-mini', expect.any(String));
    const textOutputs = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
    expect(textOutputs).toContain('Recovered via fallback model!');
  });
});

describe('TrueForge Live Server Integration Test Suite', () => {
  const liveEndpoint = 'http://localhost:8790';
  let isServerLive = false;

  beforeEach(async () => {
    try {
      const res = await fetch(`${liveEndpoint}/api/v1/capabilities`, { signal: AbortSignal.timeout(1000) });
      isServerLive = res.ok;
    } catch {
      isServerLive = false;
    }
  });

  it('connects to live local TrueForge instance if running, or gracefully skips', async () => {
    if (!isServerLive) {
      console.log('Skipping live TrueForge integration tests: local server on port 8790 is offline. Real integration suite ready for live testing.');
      expect(true).toBe(true);
      return;
    }

    // Live test execution against local TrueForge server
    const liveClient = new TrueForgeClient({
      endpoint: liveEndpoint,
      primaryModel: 'openai/gpt-4o',
      fallbackModel: 'openai/gpt-4o-mini',
      timeoutMs: 15000
    });

    const session = await liveClient.createSession('Live Test Session');
    expect(session.id).toBeDefined();

    const events: any[] = [];
    for await (const event of liveClient.streamTurn(session.id, 'Echo "ForgePilot SDK ready"')) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    await liveClient.cancelTurn(session.id);
  });
});
