import * as vscode from 'vscode';
import { TrueForgeClient } from '../services/trueforge';
import { SessionManager } from '../services/sessionManager';

export async function cancelAgentTurn(
  client: TrueForgeClient,
  sessionManager: SessionManager
): Promise<void> {
  const session = sessionManager.getCurrentSession();
  if (session) {
    await client.cancelTurn(session.id);
    vscode.window.showInformationMessage('ForgePilot: Active TrueForge turn cancelled.');
  } else {
    vscode.window.showInformationMessage('ForgePilot: No active session to cancel.');
  }
}
