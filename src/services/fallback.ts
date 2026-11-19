import { TrueForgeClient } from './trueforge';
import { TrueForgeEvent } from './types';

export interface ResilienceOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  onFallback?: (fromModel: string, toModel: string, reason: string) => void;
}

export class ResilienceManager {
  private client: TrueForgeClient;
  private options: Required<ResilienceOptions>;

  constructor(client: TrueForgeClient, options?: ResilienceOptions) {
    this.client = client;
    this.options = {
      maxRetries: 3,
      initialDelayMs: 1000,
      backoffFactor: 2,
      onRetry: () => {},
      onFallback: () => {},
      ...options
    };
  }

  private isTransientError(errorMsg: string): boolean {
    const msg = errorMsg.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('fetch failed') ||
      msg.includes('econnrefused') ||
      msg.includes('timeout') ||
      msg.includes('headers timeout') ||
      msg.includes('cannot connect to api') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('504')
    );
  }

  private isModelFailure(errorMsg: string): boolean {
    const msg = errorMsg.toLowerCase();
    return (
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('quota') ||
      msg.includes('overloaded') ||
      msg.includes('model unavailable') ||
      msg.includes('model not found') ||
      msg.includes('does not exist')
    );
  }

  /**
   * Executes a turn with retry and fallback resilience.
   * Yields events from whichever model succeeds.
   */
  public async *executeWithResilience(
    sessionId: string,
    message: string,
    options?: { context?: any; systemPrompt?: string }
  ): AsyncIterable<TrueForgeEvent> {
    const config = this.client.getConfig();
    let currentModel = config.primaryModel;
    let usingFallback = false;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        let hadError = false;
        let lastErrorMessage = '';

        for await (const event of this.client.streamTurn(sessionId, message, {
          model: currentModel,
          context: options?.context,
          systemPrompt: options?.systemPrompt
        })) {
          if (event.type === 'error') {
            hadError = true;
            lastErrorMessage = event.error || 'Unknown error';
            break;
          }
          yield event;
        }

        if (!hadError) {
          // Success!
          return;
        }

        // If turn yielded error event
        throw new Error(lastErrorMessage);
      } catch (err: any) {
        const errorMsg = err.message || '';

        // If user explicitly cancelled, stop immediately without retry
        if (err.name === 'AbortError' || errorMsg.includes('cancelled')) {
          yield {
            type: 'cancelled',
            sessionId,
            error: 'Operation cancelled by user.',
            timestamp: Date.now()
          };
          return;
        }

        const isTransient = this.isTransientError(errorMsg);
        const isModel = this.isModelFailure(errorMsg);

        // Check if we should switch to fallback model
        if (!usingFallback && (isModel || attempt >= 2)) {
          usingFallback = true;
          const prevModel = currentModel;
          currentModel = config.fallbackModel;
          this.options.onFallback(prevModel, currentModel, errorMsg);

          yield {
            type: 'text_delta',
            sessionId,
            delta: `\n\n*[ForgePilot Resilience: Primary model (${prevModel}) failed: ${errorMsg}. Activating fallback model: ${currentModel}...]*\n\n`,
            timestamp: Date.now()
          };

          // Retry immediately on fallback model without consuming an extra attempt
          attempt--;
          continue;
        }

        if (attempt < this.options.maxRetries && isTransient) {
          const delay = this.options.initialDelayMs * Math.pow(this.options.backoffFactor, attempt - 1);
          this.options.onRetry(attempt, delay, errorMsg);

          yield {
            type: 'text_delta',
            sessionId,
            delta: `\n*[ForgePilot Resilience: Connection error (${errorMsg}). Retrying in ${delay / 1000}s (Attempt ${attempt}/${this.options.maxRetries})...]*\n`,
            timestamp: Date.now()
          };

          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Both primary and fallback exhausted or unrecoverable error
        yield {
          type: 'error',
          sessionId,
          error: `Execution failed after ${attempt} attempts on ${currentModel}: ${errorMsg}`,
          timestamp: Date.now()
        };
        return;
      }
    }

    // Safety fallback if loop exited
    yield {
      type: 'error',
      sessionId,
      error: `Execution failed: Unable to connect to TrueForge server.`,
      timestamp: Date.now()
    };
  }
}
