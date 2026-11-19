import { TrueForge, TrueForgeError, TrueForgeTimeoutError } from '@truefoundry/trueforge-sdk';
import { TrueForgeConfig, TrueForgeEvent, SessionInfo } from './types';
import { McpToolHandler } from '../mcp/tools';

export class TrueForgeClient {
  private config: TrueForgeConfig;
  private sdk!: TrueForge;
  private activeAbortControllers: Map<string, AbortController> = new Map();
  private mcpHandler?: McpToolHandler;
  private pendingToolCalls: Map<string, { tool: string; input: any }> = new Map();
  private executedToolResults: Map<string, any> = new Map();

  constructor(config: TrueForgeConfig, mcpHandler?: McpToolHandler) {
    this.config = {
      timeoutMs: 60000,
      maxRetries: 3,
      ...config
    };
    this.mcpHandler = mcpHandler;
    this.initSdk();
  }

  private initSdk(): void {
    const timeoutInSeconds = Math.max(1, Math.ceil((this.config.timeoutMs || 60000) / 1000));
    this.sdk = new TrueForge({
      baseUrl: this.config.endpoint,
      token: this.config.apiKey || undefined,
      timeoutInSeconds,
      maxRetries: this.config.maxRetries ?? 2,
      stream: {
        reconnectionEnabled: true,
        maxReconnectionAttempts: 3
      }
    });
  }

  public getSdk(): TrueForge {
    return this.sdk;
  }

  public updateConfig(newConfig: Partial<TrueForgeConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.initSdk();
  }

  public setMcpHandler(handler: McpToolHandler): void {
    this.mcpHandler = handler;
  }

  public getConfig(): TrueForgeConfig {
    return { ...this.config };
  }

  /**
   * Creates a new agent session on TrueForge using the official SDK.
   */
  public async createSession(title: string = 'ForgePilot Session'): Promise<SessionInfo> {
    try {
      const response = await this.sdk.sessions.create({
        agent: {
          name: 'forgepilot-agent'
        },
        metadata: {
          title,
          source: 'forgepilot-vscode'
        }
      });

      const session = response.data;
      return {
        id: session.id || `session-${Date.now()}`,
        title: session.title || title,
        createdAt: session.createdAt ? new Date(session.createdAt).getTime() : Date.now(),
        updatedAt: session.updatedAt ? new Date(session.updatedAt).getTime() : Date.now(),
        status: 'active'
      };
    } catch (err: any) {
      const msg = err.message || 'Failed to create TrueForge session';
      throw new Error(`TrueForge createSession failed: ${msg}`);
    }
  }

  /**
   * Cancels an active turn on TrueForge using client.sessions.cancel()
   * and aborts the local stream reader signal.
   */
  public async cancelTurn(sessionId: string, _turnId?: string): Promise<void> {
    // 1. Abort local stream controller
    const controller = this.activeAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(sessionId);
    }

    // 2. Perform official server-side cancellation via SDK
    try {
      await this.sdk.sessions.cancel(sessionId);
    } catch {
      // Ignore if session/turn already completed or cancelled on server
    }
  }

  /**
   * Executes a turn on TrueForge and yields structured streaming events.
   * Uses client.sessions.createTurnStream() from the official SDK.
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

    yield {
      type: 'turn_start',
      sessionId,
      timestamp: Date.now()
    };

    let activeTurnId: string | undefined;

    try {
      const stream = await this.sdk.sessions.createTurnStream(
        sessionId,
        {
          input: [
            {
              type: 'user.message',
              content: message
            }
          ]
        },
        {
          abortSignal: abortController.signal
        }
      );

      for await (const event of stream) {
        if (abortController.signal.aborted) {
          yield {
            type: 'cancelled',
            sessionId,
            turnId: activeTurnId,
            error: 'Turn was cancelled by user.',
            timestamp: Date.now()
          };
          return;
        }

        const rawEvent = event as any;

        switch (rawEvent.type) {
          case 'turn.created': {
            activeTurnId = rawEvent.id;
            yield {
              type: 'turn_start',
              sessionId,
              turnId: rawEvent.id,
              timestamp: rawEvent.createdAt ? new Date(rawEvent.createdAt).getTime() : Date.now()
            };
            break;
          }

          case 'model.message.delta': {
            if (rawEvent.content) {
              yield {
                type: 'text_delta',
                sessionId,
                turnId: activeTurnId,
                delta: rawEvent.content,
                timestamp: rawEvent.createdAt ? new Date(rawEvent.createdAt).getTime() : Date.now()
              };
            }
            break;
          }

          case 'model.message': {
            // Process model tool calls if present
            if (rawEvent.toolCalls && Array.isArray(rawEvent.toolCalls)) {
              for (const tc of rawEvent.toolCalls) {
                let parsedInput: any = {};
                if (tc.function?.arguments) {
                  try {
                    parsedInput = typeof tc.function.arguments === 'string'
                      ? JSON.parse(tc.function.arguments)
                      : tc.function.arguments;
                  } catch {
                    parsedInput = tc.function.arguments;
                  }
                }

                const toolName = tc.function?.name || tc.name || 'unknown_tool';
                const callId = tc.id || `call-${Date.now()}`;

                this.pendingToolCalls.set(callId, { tool: toolName, input: parsedInput });

                yield {
                  type: 'tool_call',
                  sessionId,
                  turnId: activeTurnId,
                  toolCall: {
                    tool: toolName,
                    callId,
                    input: parsedInput
                  },
                  timestamp: rawEvent.createdAt ? new Date(rawEvent.createdAt).getTime() : Date.now()
                };

                // If MCP handler is configured and not yet executed, execute once
                if (this.mcpHandler && !this.executedToolResults.has(callId)) {
                  const result = await this.executeToolCall({
                    tool: toolName,
                    callId,
                    input: parsedInput
                  }, sessionId);

                  this.executedToolResults.set(callId, result);

                  yield {
                    type: 'tool_result',
                    sessionId,
                    turnId: activeTurnId,
                    toolResult: {
                      callId,
                      result
                    },
                    timestamp: Date.now()
                  };
                }
              }
            } else if (rawEvent.content) {
              const textContent = typeof rawEvent.content === 'string'
                ? rawEvent.content
                : Array.isArray(rawEvent.content)
                  ? rawEvent.content.map((c: any) => c.text || '').join('')
                  : '';
              if (textContent) {
                yield {
                  type: 'text_delta',
                  sessionId,
                  turnId: activeTurnId,
                  delta: textContent,
                  text: textContent,
                  timestamp: rawEvent.createdAt ? new Date(rawEvent.createdAt).getTime() : Date.now()
                };
              }
            }
            break;
          }

          case 'tool.approval_required': {
            const toolCalls = rawEvent.toolCalls || [];
            for (const ref of toolCalls) {
              const pending = this.pendingToolCalls.get(ref.id);
              yield {
                type: 'approval_required',
                sessionId,
                turnId: activeTurnId,
                approval: {
                  tool: pending?.tool || 'system_command',
                  callId: ref.id,
                  input: pending?.input || {},
                  description: `Action requires explicit user confirmation: ${pending?.tool || ref.id}`
                },
                timestamp: rawEvent.createdAt ? new Date(rawEvent.createdAt).getTime() : Date.now()
              };
            }
            break;
          }

          case 'tool.response_required': {
            const toolCalls = rawEvent.toolCalls || [];
            const responseEvents: any[] = [];

            for (const ref of toolCalls) {
              let result = this.executedToolResults.get(ref.id);

              if (result === undefined) {
                const pending = this.pendingToolCalls.get(ref.id);
                const toolName = pending?.tool || 'unknown_tool';
                const toolInput = pending?.input || {};

                if (this.mcpHandler) {
                  result = await this.executeToolCall({
                    tool: toolName,
                    callId: ref.id,
                    input: toolInput
                  }, sessionId);
                } else {
                  result = { status: 'executed' };
                }

                this.executedToolResults.set(ref.id, result);

                yield {
                  type: 'tool_result',
                  sessionId,
                  turnId: activeTurnId,
                  toolResult: {
                    callId: ref.id,
                    result
                  },
                  timestamp: Date.now()
                };
              }

              responseEvents.push({
                type: 'user.tool_response',
                threadId: rawEvent.threadId || 'main',
                toolCallId: ref.id,
                content: typeof result === 'string' ? result : JSON.stringify(result)
              });
            }

            // Submit tool responses back to TrueForge server turn events
            if (activeTurnId && responseEvents.length > 0) {
              try {
                await this.sdk.sessions.createTurnEvents(sessionId, activeTurnId, {
                  events: responseEvents
                });
              } catch {
                // Non-fatal if turn has already transitioned
              }
            }
            break;
          }

          case 'turn.done': {
            if (rawEvent.state?.status === 'cancelled') {
              yield {
                type: 'cancelled',
                sessionId,
                turnId: activeTurnId,
                error: 'Turn was cancelled on server.',
                timestamp: Date.now()
              };
            } else if (rawEvent.state?.status === 'error') {
              yield {
                type: 'error',
                sessionId,
                turnId: activeTurnId,
                error: rawEvent.state?.error?.message || 'Turn execution failed.',
                timestamp: Date.now()
              };
            } else {
              yield {
                type: 'turn_complete',
                sessionId,
                turnId: activeTurnId,
                timestamp: Date.now()
              };
            }
            return;
          }

          // Backwards compatibility for raw text_delta or custom SSE payloads
          case 'text_delta': {
            yield {
              type: 'text_delta',
              sessionId,
              turnId: activeTurnId,
              delta: rawEvent.delta || '',
              timestamp: Date.now()
            };
            break;
          }

          case 'turn_complete': {
            yield {
              type: 'turn_complete',
              sessionId,
              turnId: activeTurnId,
              timestamp: Date.now()
            };
            return;
          }

          default: {
            break;
          }
        }
      }

      yield {
        type: 'turn_complete',
        sessionId,
        turnId: activeTurnId,
        timestamp: Date.now()
      };
    } catch (err: any) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        yield {
          type: 'cancelled',
          sessionId,
          error: 'Turn was cancelled by user.',
          timestamp: Date.now()
        };
      } else if (err instanceof TrueForgeTimeoutError) {
        yield {
          type: 'error',
          sessionId,
          error: `TrueForge request timed out: ${err.message}`,
          timestamp: Date.now()
        };
      } else if (err instanceof TrueForgeError) {
        yield {
          type: 'error',
          sessionId,
          error: `TrueForge SDK error (${err.statusCode || 'unknown'}): ${err.message}`,
          timestamp: Date.now()
        };
      } else {
        yield {
          type: 'error',
          sessionId,
          error: err.message || 'TrueForge turn execution error',
          timestamp: Date.now()
        };
      }
    } finally {
      this.activeAbortControllers.delete(sessionId);
      this.pendingToolCalls.clear();
      this.executedToolResults.clear();
    }
  }

  private async executeToolCall(
    toolCall: { tool: string; callId: string; input: any },
    sessionId?: string
  ): Promise<any> {
    if (!this.mcpHandler) {
      return { error: 'No MCP tool handler connected to TrueForge client.' };
    }

    try {
      const input = toolCall.input || {};

      switch (toolCall.tool) {
        case 'search_workspace':
          if (typeof input.query !== 'string' || !input.query.trim()) {
            return { error: "Missing or invalid required argument 'query' for search_workspace." };
          }
          return await this.mcpHandler.searchWorkspace(input);

        case 'list_files':
          return await this.mcpHandler.listFiles(input);

        case 'read_file':
          if (typeof input.path !== 'string' || !input.path.trim()) {
            return { error: "Missing or invalid required argument 'path' for read_file." };
          }
          return await this.mcpHandler.readFile(input);

        case 'get_symbols':
          return await this.mcpHandler.getSymbols(input);

        case 'get_references':
          if (typeof input.symbol !== 'string' || !input.symbol.trim()) {
            return { error: "Missing or invalid required argument 'symbol' for get_references." };
          }
          return await this.mcpHandler.getReferences(input);

        case 'get_workspace_context':
          return await this.mcpHandler.getWorkspaceContext();

        case 'propose_edit':
          if (typeof input.path !== 'string' || typeof input.proposedContent !== 'string') {
            return { error: "Missing required arguments 'path' and 'proposedContent' for propose_edit." };
          }
          return await this.mcpHandler.proposeEdit(input, sessionId);

        case 'run_command':
          if (typeof input.command !== 'string' || !input.command.trim()) {
            return { error: "Missing or invalid required argument 'command' for run_command." };
          }
          return await this.mcpHandler.runCommand(input);

        case 'run_tests':
          return await this.mcpHandler.runTests(input);

        case 'get_git_status':
          return await this.mcpHandler.getGitStatus();

        case 'get_file_diff':
          return await this.mcpHandler.getFileDiff(input);

        case 'inspect_project':
          return await this.mcpHandler.inspectProject();

        default:
          return { error: `Unsupported tool: "${toolCall.tool}". Supported tools: search_workspace, list_files, read_file, get_symbols, get_references, get_workspace_context, propose_edit, run_command, run_tests, get_git_status, get_file_diff, inspect_project.` };
      }
    } catch (err: any) {
      return { error: err.message || 'Tool execution failed' };
    }
  }
}
