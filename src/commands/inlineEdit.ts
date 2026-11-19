import * as vscode from 'vscode';
import * as path from 'path';
import { TrueForgeClient } from '../services/trueforge';
import { ResilienceManager } from '../services/fallback';
import { SessionManager } from '../services/sessionManager';
import { DiffManager } from '../diff/diffManager';
import { computeSha256 } from '../utils/hash';
import { toWorkspaceRelative } from '../utils/pathValidation';

export interface InlineEditSelection {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  isEmpty: boolean;
}

export interface InlineEditContext {
  filePath: string;
  absolutePath: string;
  languageId: string;
  documentVersion: number;
  originalFullContent: string;
  originalSha256: string;
  selection: InlineEditSelection;
  selectedText: string;
  effectiveRange: {
    startOffset: number;
    endOffset: number;
  };
  surroundingContextBefore: string;
  surroundingContextAfter: string;
}

export interface InlineEditResult {
  success: boolean;
  proposalId?: string;
  proposedContent?: string;
  hunksCount?: number;
  error?: string;
  cancelled?: boolean;
}

/**
 * Builds a structured, context-rich prompt for TrueForge.
 */
export function buildInlineEditPrompt(context: InlineEditContext, instruction: string): string {
  return `[FORGEPILOT INLINE EDIT REQUEST]
File: ${context.filePath} (Language: ${context.languageId})
Target Selection (lines ${context.selection.startLine + 1} to ${context.selection.endLine + 1}):
\`\`\`${context.languageId}
${context.selectedText}
\`\`\`

Surrounding Context Before:
\`\`\`${context.languageId}
${context.surroundingContextBefore || '# (Start of file)'}
\`\`\`

Surrounding Context After:
\`\`\`${context.languageId}
${context.surroundingContextAfter || '# (End of file)'}
\`\`\`

User Instruction:
${instruction}

Execution Requirements:
1. Apply the user instruction accurately to the target selection.
2. Preserve all surrounding code outside the target selection without modification.
3. Maintain existing formatting, styling, and indentation.
4. Call the \`propose_edit\` tool with path "${context.filePath}" or provide the replacement code block in \`\`\`${context.languageId} ... \`\`\`.
`;
}

/**
 * Extracts code block content from model response text.
 */
export function extractReplacementCode(responseText: string): string | null {
  if (!responseText || !responseText.trim()) {
    return null;
  }

  // Check for fenced markdown code block
  const match = responseText.match(/```(?:[a-zA-Z0-9_\-]+)?\r?\n([\s\S]*?)```/);
  if (match && match[1] !== undefined) {
    return match[1];
  }

  // Check for triple backticks without newline
  const fallbackMatch = responseText.match(/```([\s\S]*?)```/);
  if (fallbackMatch && fallbackMatch[1] !== undefined) {
    return fallbackMatch[1].trim();
  }

  return null;
}

/**
 * Splices replacement code into original content at effective selection range.
 */
export function spliceReplacementIntoContent(
  originalFullContent: string,
  effectiveRange: { startOffset: number; endOffset: number },
  replacement: string
): string {
  // If replacement appears to be the entire file (same length or contains full structure)
  if (replacement.length >= originalFullContent.length * 0.9 && replacement.includes('\n')) {
    const firstOrigLine = originalFullContent.split(/\r?\n/)[0]?.trim();
    if (firstOrigLine && replacement.includes(firstOrigLine)) {
      return replacement;
    }
  }

  const before = originalFullContent.slice(0, effectiveRange.startOffset);
  const after = originalFullContent.slice(effectiveRange.endOffset);
  return before + replacement + after;
}

/**
 * Checks whether document has been modified on disk or in editor since generation began.
 */
export function validateDocumentNotStale(
  context: InlineEditContext,
  currentContent: string,
  currentVersion?: number
): { valid: boolean; reason?: string } {
  if (currentVersion !== undefined && currentVersion !== context.documentVersion) {
    return {
      valid: false,
      reason: `Document version changed from ${context.documentVersion} to ${currentVersion}.`
    };
  }

  const currentHash = computeSha256(currentContent);
  if (currentHash !== context.originalSha256) {
    return {
      valid: false,
      reason: 'Document content was modified during generation (hash mismatch).'
    };
  }

  return { valid: true };
}

/**
 * Pure testable core execution logic for Inline Edit turns.
 */
export async function executeInlineEditTurn(
  trueforgeClient: TrueForgeClient,
  resilienceManager: ResilienceManager,
  sessionManager: SessionManager,
  diffManager: DiffManager,
  context: InlineEditContext,
  instruction: string,
  onProgress?: (message: string) => void,
  abortSignal?: AbortSignal
): Promise<InlineEditResult> {
  const session = await sessionManager.getOrCreateSession('Inline Edit Session');
  const prompt = buildInlineEditPrompt(context, instruction);

  let accumulatedText = '';
  let proposalFromToolId: string | undefined;

  for await (const event of resilienceManager.executeWithResilience(
    session.id,
    prompt
  )) {
    if (abortSignal?.aborted) {
      await trueforgeClient.cancelTurn(session.id);
      return { success: false, cancelled: true };
    }

    if (event.type === 'text_delta' && event.delta) {
      accumulatedText += event.delta;
      if (onProgress) onProgress('Streaming model response...');
    } else if (event.type === 'tool_call' && event.toolCall) {
      if (onProgress) onProgress(`Executing tool ${event.toolCall.tool}...`);
    } else if (event.type === 'tool_result' && event.toolResult) {
      if (event.toolResult.result && event.toolResult.result.proposalId) {
        proposalFromToolId = event.toolResult.result.proposalId;
      }
    } else if (event.type === 'error') {
      return { success: false, error: event.error || 'Turn failed' };
    } else if (event.type === 'cancelled') {
      return { success: false, cancelled: true };
    }
  }

  // 1. Check if proposal was created via propose_edit tool
  if (proposalFromToolId) {
    const prop = diffManager.getProposal(proposalFromToolId);
    if (prop) {
      return {
        success: true,
        proposalId: prop.id,
        proposedContent: prop.proposedContent,
        hunksCount: prop.hunks.length
      };
    }
  }

  // 2. Check if DiffManager already recorded proposals for this file during turn
  const fileProposals = diffManager.listProposals().filter((p) => p.filePath === context.filePath);
  if (fileProposals.length > 0) {
    const latest = fileProposals[fileProposals.length - 1];
    return {
      success: true,
      proposalId: latest.id,
      proposedContent: latest.proposedContent,
      hunksCount: latest.hunks.length
    };
  }

  // 3. Fallback: Parse code block from accumulated text
  const extracted = extractReplacementCode(accumulatedText);
  if (!extracted || !extracted.trim()) {
    return {
      success: false,
      error: 'Model output did not contain valid replacement code or propose_edit call.'
    };
  }

  const fullProposedContent = spliceReplacementIntoContent(
    context.originalFullContent,
    context.effectiveRange,
    extracted
  );

  const proposal = diffManager.createProposal(
    context.filePath,
    fullProposedContent,
    session.id,
    instruction
  );

  return {
    success: true,
    proposalId: proposal.id,
    proposedContent: fullProposedContent,
    hunksCount: proposal.hunks.length
  };
}

/**
 * Main VS Code Command Handler for forgepilot.inlineEdit.
 */
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
  const fullContent = document.getText();

  // Handle empty selection by expanding to current line
  let targetSelection = selection;
  let selectedText = document.getText(selection);
  let startOffset = document.offsetAt(selection.start);
  let endOffset = document.offsetAt(selection.end);

  if (selection.isEmpty) {
    const line = document.lineAt(selection.start.line);
    targetSelection = new vscode.Selection(line.range.start, line.range.end);
    selectedText = line.text;
    startOffset = document.offsetAt(line.range.start);
    endOffset = document.offsetAt(line.range.end);
  }

  // Capture surrounding context (up to 25 lines before and after)
  const startLine = targetSelection.start.line;
  const endLine = targetSelection.end.line;
  const contextStartLine = Math.max(0, startLine - 25);
  const contextEndLine = Math.min(document.lineCount - 1, endLine + 25);

  const surroundingContextBefore = contextStartLine < startLine
    ? document.getText(new vscode.Range(contextStartLine, 0, startLine, 0))
    : '';
  const surroundingContextAfter = contextEndLine > endLine
    ? document.getText(new vscode.Range(endLine + 1, 0, contextEndLine + 1, 0))
    : '';

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(document.uri.fsPath);
  const relativeFilePath = toWorkspaceRelative(workspaceRoot, document.uri.fsPath);

  const context: InlineEditContext = {
    filePath: relativeFilePath,
    absolutePath: document.uri.fsPath,
    languageId: document.languageId,
    documentVersion: document.version,
    originalFullContent: fullContent,
    originalSha256: computeSha256(fullContent),
    selection: {
      startLine: targetSelection.start.line,
      startCharacter: targetSelection.start.character,
      endLine: targetSelection.end.line,
      endCharacter: targetSelection.end.character,
      isEmpty: selection.isEmpty
    },
    selectedText,
    effectiveRange: {
      startOffset,
      endOffset
    },
    surroundingContextBefore,
    surroundingContextAfter
  };

  // Prompt developer for natural language instruction
  const instruction = await vscode.window.showInputBox({
    prompt: `ForgePilot Inline Edit — ${path.basename(document.uri.fsPath)} (Lines ${startLine + 1}–${endLine + 1})`,
    placeHolder: "E.g. Refactor function to use case-insensitive check and update docstring...",
    ignoreFocusOut: true
  });

  if (!instruction || !instruction.trim()) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ForgePilot: Generating inline edit with TrueForge...',
      cancellable: true
    },
    async (progress, token) => {
      const abortController = new AbortController();
      token.onCancellationRequested(() => {
        abortController.abort();
      });

      const result = await executeInlineEditTurn(
        trueforgeClient,
        resilienceManager,
        sessionManager,
        diffManager,
        context,
        instruction,
        (msg) => progress.report({ message: msg }),
        abortController.signal
      );

      if (result.cancelled) {
        vscode.window.showInformationMessage('ForgePilot: Inline edit was cancelled.');
        return;
      }

      if (!result.success || !result.proposalId) {
        vscode.window.showErrorMessage(`ForgePilot Inline Edit Failed: ${result.error || 'Unknown error'}`);
        return;
      }

      // Check for stale document before notifying
      const staleCheck = validateDocumentNotStale(
        context,
        document.getText(),
        document.version
      );

      if (!staleCheck.valid) {
        vscode.window.showErrorMessage(
          `ForgePilot: ${staleCheck.reason} Proposed edit rejected to protect workspace.`
        );
        return;
      }

      const proposal = diffManager.getProposal(result.proposalId);
      const hunksCount = proposal ? proposal.hunks.length : result.hunksCount || 1;

      const action = await vscode.window.showInformationMessage(
        `ForgePilot: Proposed inline edit ready with ${hunksCount} diff hunk(s).`,
        'Accept All & Apply',
        'Review in ForgePilot',
        'Reject'
      );

      if (action === 'Accept All & Apply') {
        // Re-validate freshness immediately before applying
        const finalCheck = validateDocumentNotStale(
          context,
          document.getText(),
          document.version
        );

        if (!finalCheck.valid) {
          vscode.window.showErrorMessage(
            `ForgePilot Apply Aborted: ${finalCheck.reason}`
          );
          return;
        }

        diffManager.acceptAll(result.proposalId);
        const applyResult = await diffManager.applyAccepted(result.proposalId);
        if (applyResult.success) {
          vscode.window.showInformationMessage(`ForgePilot: Applied changes to ${path.basename(document.uri.fsPath)}.`);
        } else {
          vscode.window.showErrorMessage(`ForgePilot: Failed to apply edits: ${applyResult.errors.join('; ')}`);
        }
      } else if (action === 'Review in ForgePilot') {
        await vscode.commands.executeCommand('forgepilot.agentView.focus');
        if (result.proposalId) {
          await vscode.commands.executeCommand('forgepilot.showDiffProposal', result.proposalId);
        }
      } else if (action === 'Reject') {
        diffManager.rejectAll(result.proposalId);
        vscode.window.showInformationMessage('ForgePilot: Proposed edit rejected.');
      }
    }
  );
}
