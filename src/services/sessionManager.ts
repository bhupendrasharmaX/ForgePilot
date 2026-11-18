import { TrueForgeClient } from './trueforge';
import { SessionInfo } from './types';

export class SessionManager {
  private client: TrueForgeClient;
  private currentSession: SessionInfo | null = null;
  private sessionHistory: Map<string, SessionInfo> = new Map();

  constructor(client: TrueForgeClient) {
    this.client = client;
  }

  public getCurrentSession(): SessionInfo | null {
    return this.currentSession;
  }

  public async getOrCreateSession(title?: string): Promise<SessionInfo> {
    if (this.currentSession) {
      return this.currentSession;
    }
    return this.createNewSession(title);
  }

  public async createNewSession(title: string = 'ForgePilot Session'): Promise<SessionInfo> {
    try {
      const session = await this.client.createSession(title);
      this.currentSession = session;
      this.sessionHistory.set(session.id, session);
      return session;
    } catch (err: any) {
      // In offline / fallback test situations, provide a local session wrapper
      const fallbackSession: SessionInfo = {
        id: `local-session-${Date.now()}`,
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active'
      };
      this.currentSession = fallbackSession;
      this.sessionHistory.set(fallbackSession.id, fallbackSession);
      return fallbackSession;
    }
  }

  public listSessions(): SessionInfo[] {
    return Array.from(this.sessionHistory.values());
  }

  public clearCurrentSession(): void {
    this.currentSession = null;
  }
}
