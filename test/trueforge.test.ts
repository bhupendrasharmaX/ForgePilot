import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrueForgeClient } from '../src/services/trueforge';
import { ResilienceManager } from '../src/services/fallback';
import { TrueForgeConfig } from '../src/services/types';

describe('TrueForge Integration & Resilience', () => {
  const config: TrueForgeConfig = {
    endpoint: 'http://localhost:8790',
    apiKey: 'test-key',
    primaryModel: 'gemini-2.5-pro',
    fallbackModel: 'gemini-2.5-flash',
    timeoutMs: 5000,
    maxRetries: 3
  };

  let client: TrueForgeClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new TrueForgeClient(config);
  });

  it('creates a TrueForge session with correct headers and payload', async () => {
    const mockSession = { id: 'tf-session-123', title: 'Test Session', created_at: new Date().toISOString() };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSession
    } as any);

    const session = await client.createSession('Test Session');
    expect(session.id).toBe('tf-session-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:8790/api/v1/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json'
        })
      })
    );
  });

  it('streams SSE text deltas from turn execution', async () => {
    const sseData = 'data: {"type":"text_delta","delta":"Hello "}\n\ndata: {"type":"text_delta","delta":"World!"}\n\ndata: [DONE]\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseData));
        controller.close();
      }
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream
    } as any);

    const events: any[] = [];
    for await (const event of client.streamTurn('tf-session-123', 'Hi')) {
      events.push(event);
    }

    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.delta);
    expect(deltas).toEqual(['Hello ', 'World!']);
    expect(events.some((e) => e.type === 'turn_complete')).toBe(true);
  });

  it('resilience switches to fallback model when primary model fails with quota error', async () => {
    let callCount = 0;
    const fallbackSpy = vi.fn();

    const resilience = new ResilienceManager(client, {
      maxRetries: 2,
      initialDelayMs: 10,
      onFallback: fallbackSpy
    });

    // Mock fetch: first call fails with rate limit / quota, second call succeeds
    global.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      callCount++;
      const body = JSON.parse(init.body);
      if (body.model === 'gemini-2.5-pro') {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => 'Rate limit exceeded: quota exhausted for gemini-2.5-pro'
        };
      } else {
        // Fallback model success
        const sseData = 'data: {"type":"text_delta","delta":"Recovered via fallback!"}\n\ndata: [DONE]\n\n';
        const encoder = new TextEncoder();
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sseData));
              controller.close();
            }
          })
        };
      }
    });

    const events: any[] = [];
    for await (const event of resilience.executeWithResilience('tf-123', 'Do task')) {
      events.push(event);
    }

    expect(fallbackSpy).toHaveBeenCalledWith('gemini-2.5-pro', 'gemini-2.5-flash', expect.any(String));
    const textOutputs = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
    expect(textOutputs).toContain('Recovered via fallback!');
  });
});
