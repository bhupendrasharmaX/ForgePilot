export type TrueForgeEventType =
  | 'session'
  | 'turn_start'
  | 'text_delta'
  | 'tool_call'
  | 'tool_result'
  | 'approval_required'
  | 'turn_complete'
  | 'error'
  | 'cancelled';

export interface TrueForgeEvent {
  type: TrueForgeEventType;
  sessionId: string;
  turnId?: string;
  delta?: string;
  text?: string;
  toolCall?: {
    tool: string;
    callId: string;
    input: any;
  };
  toolResult?: {
    callId: string;
    result: any;
  };
  approval?: {
    tool: string;
    callId: string;
    input: any;
    description: string;
  };
  error?: string;
  timestamp: number;
}

export interface TrueForgeConfig {
  endpoint: string;
  apiKey?: string;
  primaryModel: string;
  fallbackModel: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'idle' | 'archived';
}

