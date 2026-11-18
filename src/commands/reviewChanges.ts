import * as vscode from 'vscode';
import { DiffManager } from '../diff/diffManager';

export async function reviewChanges(diffManager: DiffManager): Promise<void> {
  const proposals = diffManager.listProposals();
  if (proposals.length === 0) {
    vscode.window.showInformationMessage('ForgePilot: No proposed changes pending review.');
    return;
  }

  // Open sidebar view tab for diffs
  await vscode.commands.executeCommand('forgepilot.agentView.focus');
}
