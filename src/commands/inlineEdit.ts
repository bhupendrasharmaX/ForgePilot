import * as vscode from 'vscode';
import * as path from 'path';
import { TrueForgeClient } from '../services/trueforge';
import { ResilienceManager } from '../services/fallback';
import { SessionManager } from '../services/sessionManager';
import { DiffManager } from '../diff/diffManager';
import { toWorkspaceRelative } from '../utils/pathValidation';

export async function handleInlineEdit(
  trueforgeClient: TrueForgeClient,
  resilienceManager: ResilienceManager,
  sessionManager: SessionManager,
  diffManager: DiffManager
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('ForgePilot: Please open a file in the editor to use Inline Edit.');
    return;
  }

  const document = editor.document;
  const selection = editor.selection;
  const selectedText = document.getText(selection);

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(document.uri.fsPath);
  const relativeFilePath = toWorkspaceRelative(workspaceRoot, document.uri.fsPath);

  // Prompt the developer for natural language instruction
  const instruction = await vscode.window.showInputBox({
    prompt: `ForgePilot Inline Edit — ${path.basename(document.uri.fsPath)}`,
    placeHolder: "E.g. Treat 'off' and 'n' as false case-insensitively, and update docstring...",
    ignoreFocusOut: true
  });

  if (!instruction || !instruction.trim()) {
    return;
  }

  // Capture surrounding context (up to 40 lines above and below)
  const fullContent = document.getText();
  const startLine = selection.start.line;
  const endLine = selection.end.line;

  const promptMessage = `
[FORGEPILOT INLINE EDIT REQUEST]
File: ${relativeFilePath}
Target selection (lines ${startLine + 1} to ${endLine + 1}):
\`\`\`
${selectedText || fullContent}
\`\`\`

User Instruction:
${instruction}

Instructions:
You must provide the complete replacement code for ${relativeFilePath} with the requested changes applied accurately.
Do not invent nonexistent symbols. Maintain existing styling and indentation.
Call the \`propose_edit\` tool with path "${relativeFilePath}" and the complete proposedContent.
`;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ForgePilot: Generating inline edit with TrueForge...',
      cancellable: true
    },
    async (progress, token) => {
      const session = await sessionManager.getOrCreateSession('Inline Edit Session');

      token.onCancellationRequested(async () => {
        await trueforgeClient.cancelTurn(session.id);
        vscode.window.showInformationMessage('ForgePilot: Inline edit generation cancelled.');
      });

      let accumulatedText = '';

      for await (const event of resilienceManager.executeWithResilience(
        session.id,
        promptMessage
      )) {
        if (token.isCancellationRequested) break;

        if (event.type === 'text_delta' && event.delta) {
          accumulatedText += event.delta;
          progress.report({ message: 'Streaming response...' });
        } else if (event.type === 'tool_call' && event.toolCall) {
          progress.report({ message: `Executing tool ${event.toolCall.tool}...` });
        }
      }

      // Check if a proposal was registered for this file
      const proposals = diffManager.listProposals().filter((p) => p.filePath === relativeFilePath);
      if (proposals.length > 0) {
        const latestProposal = proposals[proposals.length - 1];
        vscode.window.showInformationMessage(
          `ForgePilot: Proposed edit ready with ${latestProposal.hunks.length} diff hunk(s). Review in ForgePilot sidebar.`,
          'Review Diffs',
          'Accept All & Apply'
        ).then(async (action) => {
          if (action === 'Review Diffs') {
            await vscode.commands.executeCommand('forgepilot.agentView.focus');
          } else if (action === 'Accept All & Apply') {
            diffManager.acceptAll(latestProposal.id);
            await diffManager.applyAccepted(latestProposal.id);
            vscode.window.showInformationMessage(`ForgePilot: Applied changes to ${relativeFilePath}`);
          }
        });
      } else {
        // If the model output markdown code block directly instead of calling tool
        const codeBlockMatch = accumulatedText.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
        if (codeBlockMatch && codeBlockMatch[1].trim()) {
          const proposedContent = codeBlockMatch[1];
          const proposal = diffManager.createProposal(
            relativeFilePath,
            proposedContent,
            session.id,
            instruction
          );
          vscode.window.showInformationMessage(
            `ForgePilot: Proposed edit generated with ${proposal.hunks.length} hunk(s).`,
            'Review Diffs'
          ).then(async (action) => {
            if (action === 'Review Diffs') {
              await vscode.commands.executeCommand('forgepilot.agentView.focus');
            }
          });
        }
      }
    }
  );
}

