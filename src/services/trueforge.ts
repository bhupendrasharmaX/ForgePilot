import { TrueForgeConfig, TrueForgeEvent, SessionInfo } from './types';
import { McpToolHandler } from '../mcp/tools';

export class TrueForgeClient {
  private config: TrueForgeConfig;
  private activeAbortControllers: Map<string, AbortController> = new Map();
  private mcpHandler?: McpToolHandler;

  constructor(config: TrueForgeConfig, mcpHandler?: McpToolHandler) {
    this.config = {
      timeoutMs: 60000,
      maxRetries: 3,
      ...config
    };
    this.mcpHandler = mcpHandler;
  }

  public updateConfig(newConfig: Partial<TrueForgeConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public setMcpHandler(handler: McpToolHandler): void {
    this.mcpHandler = handler;
  }

  public getConfig(): TrueForgeConfig {
    return { ...this.config };
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json'
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /**
   * Creates a new agent session on TrueForge.
   */
  public async createSession(title: string = 'ForgePilot Session'): Promise<SessionInfo> {
    const url = `${this.config.endpoint.replace(/\/+$/, '')}/api/v1/sessions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        title,
        agent: 'forgepilot-agent',
        model: this.config.primaryModel
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs || 30000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`TrueForge createSession failed (${response.status}): ${errText || response.statusText}`);
    }

    const data: any = await response.json();
    return {
      id: data.id || data.session_id || `session-${Date.now()}`,
      title: data.title || title,
      createdAt: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
      updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now(),
      status: 'active'
    };
  }

  /**
   * Cancels an active turn on TrueForge.
   */
  public async cancelTurn(sessionId: string, turnId?: string): Promise<void> {
    const controller = this.activeAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(sessionId);
    }

    // Also notify TrueForge server endpoint if available
    try {
      const cancelUrl = turnId
        ? `${this.config.endpoint}/api/v1/sessions/${sessionId}/turns/${turnId}/cancel`
        : `${this.config.endpoint}/api/v1/sessions/${sessionId}/cancel`;

      await fetch(cancelUrl, {
        method: 'POST',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000)
      }).catch(() => {});
    } catch {}
  }

  /**
   * Executes a turn on TrueForge and yields structured streaming events.
   * If modelOverride is provided, uses it (e.g. for fallback).
   */
  public async *streamTurn(
    sessionId: string,
    message: string,
    options?: {
      model?: string;
      context?: any;
      systemPrompt?: string;
    }
  ): AsyncIterable<TrueForgeEvent> {
    const abortController = new AbortController();
    this.activeAbortControllers.set(sessionId, abortController);

    const modelToUse = options?.model || this.config.primaryModel;
    const url = `${this.config.endpoint.replace(/\/+$/, '')}/api/v1/sessions/${sessionId}/turns`;

    yield {
      type: 'turn_start',
      sessionId,
      timestamp: Date.now()
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          message,
          model: modelToUse,
          context: options?.context,
          system_prompt: options?.systemPrompt
        }),
        signal: abortController.signal
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        yield {
          type: 'cancelled',
          sessionId,
          error: 'Turn was cancelled by user.',
          timestamp: Date.now()
        };
        return;
      }
      throw err;
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`TrueForge turn execution error (${response.status}): ${errBody || response.statusText}`);
    }

    // Process SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('TrueForge response body is not readable.');
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data:')) {
            const rawData = trimmed.slice(5).trim();
            if (rawData === '[DONE]') {
              yield {
                type: 'turn_complete',
                sessionId,
                timestamp: Date.now()
              };
              return;
            }

            try {
              const eventPayload = JSON.parse(rawData);
              const event = this.normalizeEvent(sessionId, eventPayload);

              // If the event is a tool call and we have an MCP handler, execute it!
              if (event.type === 'tool_call' && event.toolCall && this.mcpHandler) {
                yield event;
                const toolResult = await this.executeToolCall(event.toolCall);
                yield {
                  type: 'tool_result',
                  sessionId,
                  toolResult: {
                    callId: event.toolCall.callId,
                    result: toolResult
                  },
                  timestamp: Date.now()
                };
                continue;
              }

              yield event;
            } catch (parseErr) {
              // Yield raw delta if JSON parse fails
              yield {
                type: 'text_delta',
                sessionId,
                delta: rawData,
                timestamp: Date.now()
              };
            }
          }
        }
      }

      yield {
        type: 'turn_complete',
        sessionId,
        timestamp: Date.now()
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        yield {
          type: 'cancelled',
          sessionId,
          error: 'Generation cancelled.',
          timestamp: Date.now()
        };
      } else {
        yield {
          type: 'error',
          sessionId,
          error: err.message,
          timestamp: Date.now()
        };
      }
    } finally {
      this.activeAbortControllers.delete(sessionId);
    }
  }

  private normalizeEvent(sessionId: string, payload: any): TrueForgeEvent {
    const type = payload.type || (payload.delta ? 'text_delta' : payload.tool ? 'tool_call' : 'text_delta');
    return {
      type,
      sessionId,
      turnId: payload.turn_id || payload.turnId,
      delta: payload.delta || (payload.choices?.[0]?.delta?.content),
      text: payload.text || payload.content,
      toolCall: payload.tool_call || (payload.tool ? { tool: payload.tool, callId: payload.call_id || payload.id, input: payload.input || payload.arguments } : undefined),
      approval: payload.approval,
      error: payload.error,
      timestamp: Date.now()
    };
  }

  private async executeToolCall(toolCall: { tool: string; callId: string; input: any }): Promise<any> {
    if (!this.mcpHandler) {
      return { error: 'No MCP tool handler connected to TrueForge client.' };
    }

    try {
      switch (toolCall.tool) {
        case 'search_workspace':
          return await this.mcpHandler.searchWorkspace(toolCall.input);
        case 'list_files':
          return await this.mcpHandler.listFiles(toolCall.input);
        case 'read_file':
          return await this.mcpHandler.readFile(toolCall.input);
        case 'get_symbols':
          return await this.mcpHandler.getSymbols(toolCall.input);
        case 'get_references':
          return await this.mcpHandler.getReferences(toolCall.input);
        case 'get_workspace_context':
          return await this.mcpHandler.getWorkspaceContext();
        case 'propose_edit':
          return await this.mcpHandler.proposeEdit(toolCall.input);
        case 'run_command':
          return await this.mcpHandler.runCommand(toolCall.input);
        case 'run_tests':
          return await this.mcpHandler.runTests(toolCall.input);
        case 'get_git_status':
          return await this.mcpHandler.getGitStatus();
        case 'get_file_diff':
          return await this.mcpHandler.getFileDiff(toolCall.input);
        case 'inspect_project':
          return await this.mcpHandler.inspectProject();
        default:
          return { error: `Unsupported tool: ${toolCall.tool}` };
      }
    } catch (err: any) {
      return { error: err.message };
    }
  }
}

