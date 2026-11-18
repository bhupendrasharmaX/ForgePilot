import * as vscode from 'vscode';

export async function openAgentSidebar(): Promise<void> {
  await vscode.commands.executeCommand('forgepilot.agentView.focus');
}
