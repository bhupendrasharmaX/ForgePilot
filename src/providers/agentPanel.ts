import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TrueForgeClient } from '../services/trueforge';
import { ResilienceManager } from '../services/fallback';
import { SessionManager } from '../services/sessionManager';
import { DiffManager } from '../diff/diffManager';
import { ContextRetrievalEngine } from '../context/retrieval';
import { ProposedEdit, DiffHunk } from '../diff/types';
import { computeSha256 } from '../utils/hash';

export interface SerializedProposal {
  id: string;
  filePath: string;
  absolutePath: string;
  status: string;
  isStale: boolean;
  staleReason?: string;
  mode: 'Autonomous Agent' | 'Inline Edit';
  summary?: string;
  addedLines: number;
  deletedLines: number;
  totalHunks: number;
  acceptedHunks: number;
  rejectedHunks: number;
  pendingHunks: number;
  hunks: {
    id: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
    status: 'pending' | 'accepted' | 'rejected';
  }[];
}

export interface TimelineEvent {
  id: string;
  eventType:
    | 'agent_started'
    | 'context_retrieval'
    | 'files_discovered'
    | 'tool_call'
    | 'tool_result'
    | 'diff_proposal'
    | 'turn_complete'
    | 'cancelled'
    | 'error';
  title: string;
  detail: string;
  data?: any;
  status: 'running' | 'completed' | 'warning' | 'error';
  timestamp: number;
}

export function sanitizeToolInput(tool: string, input: any): any {
  if (!input || typeof input !== 'object') return input;
  const clone = JSON.parse(JSON.stringify(input));
  const sensitiveKeys = ['apikey', 'secret', 'password', 'token', 'key', 'auth', 'credentials'];

  function maskObject(obj: any): void {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (sensitiveKeys.some((s) => k.toLowerCase().includes(s))) {
        obj[k] = '***';
      } else if (typeof obj[k] === 'object') {
        maskObject(obj[k]);
      }
    }
  }

  maskObject(clone);
  return clone;
}

export function formatToolSummary(tool: string, result: any): string {
  if (!result) return 'Completed with empty result';
  if (result.error) return `Error: ${result.error}`;
  if (tool === 'list_files') {
    const count = Array.isArray(result.files) ? result.files.length : Array.isArray(result) ? result.length : 0;
    return `Discovered ${count} file(s) in workspace`;
  }
  if (tool === 'search_workspace') {
    const count = Array.isArray(result.matches) ? result.matches.length : Array.isArray(result) ? result.length : 0;
    return `Found ${count} matching code segment(s)`;
  }
  if (tool === 'read_file') {
    const lineCount = typeof result.content === 'string' ? result.content.split('\n').length : 0;
    return `Read file content (${lineCount} lines)`;
  }
  if (tool === 'get_symbols') {
    const count = Array.isArray(result.symbols) ? result.symbols.length : 0;
    return `Extracted ${count} symbol definition(s)`;
  }
  if (tool === 'get_references') {
    const count = Array.isArray(result.references) ? result.references.length : 0;
    return `Found ${count} symbol reference(s)`;
  }
  if (tool === 'propose_edit') {
    return `Created diff proposal for ${result.filePath || 'file'}`;
  }
  return 'MCP tool execution completed successfully';
}

export function checkProposalStale(proposal: ProposedEdit): { isStale: boolean; reason?: string } {
  if (proposal.status === 'applied') {
    return { isStale: false };
  }
  if (!fs.existsSync(proposal.absolutePath)) {
    if (proposal.originalContent.length > 0) {
      return { isStale: true, reason: 'File has been deleted from disk since proposal creation.' };
    }
    return { isStale: false };
  }
  try {
    const currentDiskContent = fs.readFileSync(proposal.absolutePath, 'utf8');
    const currentHash = computeSha256(currentDiskContent);
    if (currentHash !== proposal.originalSha256) {
      return {
        isStale: true,
        reason: 'File on disk has been modified since this proposal was created. Applying may conflict.'
      };
    }
  } catch {
    // Disk read fallback
  }
  return { isStale: false };
}

export function serializeProposal(proposal: ProposedEdit): SerializedProposal {
  const staleCheck = checkProposalStale(proposal);

  let addedLines = 0;
  let deletedLines = 0;
  let acceptedHunks = 0;
  let rejectedHunks = 0;
  let pendingHunks = 0;

  for (const hunk of proposal.hunks) {
    if (hunk.status === 'accepted') acceptedHunks++;
    else if (hunk.status === 'rejected') rejectedHunks++;
    else pendingHunks++;

    for (const line of hunk.lines) {
      if (line.startsWith('+')) addedLines++;
      else if (line.startsWith('-')) deletedLines++;
    }
  }

  const isInline =
    proposal.summary?.includes('Inline Edit') ||
    proposal.id.includes('inline') ||
    proposal.sessionId?.includes('inline');

  return {
    id: proposal.id,
    filePath: proposal.filePath,
    absolutePath: proposal.absolutePath,
    status: staleCheck.isStale ? 'stale' : proposal.status,
    isStale: staleCheck.isStale,
    staleReason: staleCheck.reason,
    mode: isInline ? 'Inline Edit' : 'Autonomous Agent',
    summary: proposal.summary,
    addedLines,
    deletedLines,
    totalHunks: proposal.hunks.length,
    acceptedHunks,
    rejectedHunks,
    pendingHunks,
    hunks: proposal.hunks.map((h) => ({
      id: h.id,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
      status: h.status
    }))
  };
}

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgepilot.agentView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly trueforgeClient: TrueForgeClient,
    private readonly resilienceManager: ResilienceManager,
    private readonly sessionManager: SessionManager,
    private readonly diffManager: DiffManager,
    private readonly contextEngine: ContextRetrievalEngine
  ) {
    this.diffManager.onDidChangeProposals(() => {
      this.broadcastProposals();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this.handleUserMessage(data.text, data.mode);
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'newSession':
          await this.handleNewSession();
          break;
        case 'acceptHunk':
          this.diffManager.acceptHunk(data.proposalId, data.hunkId);
          break;
        case 'rejectHunk':
          this.diffManager.rejectHunk(data.proposalId, data.hunkId);
          break;
        case 'acceptAll':
          this.diffManager.acceptAll(data.proposalId);
          break;
        case 'rejectAll':
          this.diffManager.rejectAll(data.proposalId);
          break;
        case 'applyChanges':
          await this.handleApplyChanges(data.proposalId);
          break;
        case 'undo':
          await this.handleUndo();
          break;
        case 'openFile':
          this.openFileInEditor(data.filePath);
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'forgepilot');
          break;
      }
    });

    // Send initial status
    this.postMessage({
      type: 'init',
      proposals: this.getSerializedProposals(),
      canUndo: this.diffManager.canUndo(),
      config: this.trueforgeClient.getConfig()
    });
  }

  public postMessage(message: any): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public showProposal(proposalId: string): void {
    this.postMessage({
      type: 'showProposal',
      proposalId
    });
  }

  public getSerializedProposals(): SerializedProposal[] {
    return this.diffManager.listProposals().map((p) => serializeProposal(p));
  }

  public broadcastProposals(): void {
    this.postMessage({
      type: 'proposalsUpdated',
      proposals: this.getSerializedProposals(),
      canUndo: this.diffManager.canUndo()
    });
  }

  public async handleUserMessage(promptText: string, mode: string = 'agent'): Promise<void> {
    if (!promptText.trim()) return;

    const startTime = Date.now();

    this.postMessage({
      type: 'userMessage',
      text: promptText,
      mode,
      timestamp: startTime
    });

    this.postMessage({ type: 'statusChange', status: 'busy' });

    try {
      const session = await this.sessionManager.getOrCreateSession(
        mode === 'inline' ? 'Inline Edit Session' : 'Autonomous Agent Session'
      );

      this.postMessage({
        type: 'timelineEvent',
        event: {
          id: `start-${Date.now()}`,
          eventType: 'agent_started',
          title: 'Agent Turn Initialized',
          detail: `Connected to TrueForge session ${session.id}`,
          status: 'running',
          timestamp: Date.now()
        } as TimelineEvent
      });

      // Retrieve repository context
      const context = await this.contextEngine.retrieveContext(promptText);

      const tokenBudget = this.contextEngine.getMaxTokens();
      this.postMessage({
        type: 'contextRetrieved',
        context: {
          totalTokens: context.totalTokens,
          tokenBudget,
          percentage: Math.min(100, Math.round((context.totalTokens / tokenBudget) * 100)),
          files: context.allocations.map((a) => a.filePath),
          allocations: context.allocations,
          explanation: context.explanation
        }
      });

      this.postMessage({
        type: 'timelineEvent',
        event: {
          id: `ctx-${Date.now()}`,
          eventType: 'context_retrieval',
          title: 'Context Retrieval Engine',
          detail: `Analyzed codebase & assembled ${context.allocations.length} file(s) (${context.totalTokens} tokens)`,
          data: context.allocations.map((a) => a.filePath),
          status: 'completed',
          timestamp: Date.now()
        } as TimelineEvent
      });

      // Stream turn through TrueForge with resilience fallback
      let fullResponse = '';
      const callToolMap = new Map<string, string>();
      for await (const event of this.resilienceManager.executeWithResilience(
        session.id,
        promptText,
        { context }
      )) {
        if (event.type === 'text_delta' && event.delta) {
          fullResponse += event.delta;
          this.postMessage({
            type: 'agentDelta',
            delta: event.delta
          });
        } else if (event.type === 'tool_call' && event.toolCall) {
          callToolMap.set(event.toolCall.callId, event.toolCall.tool);
          const sanitizedInput = sanitizeToolInput(event.toolCall.tool, event.toolCall.input);
          this.postMessage({
            type: 'toolCall',
            toolCall: {
              ...event.toolCall,
              input: sanitizedInput
            }
          });

          this.postMessage({
            type: 'timelineEvent',
            event: {
              id: `call-${event.toolCall.callId}`,
              eventType: 'tool_call',
              title: `MCP Tool: ${event.toolCall.tool}`,
              detail: JSON.stringify(sanitizedInput, null, 2),
              status: 'running',
              timestamp: Date.now()
            } as TimelineEvent
          });
        } else if (event.type === 'tool_result' && event.toolResult) {
          const toolName = callToolMap.get(event.toolResult.callId) || 'tool';
          const summary = formatToolSummary(toolName, event.toolResult.result);
          this.postMessage({
            type: 'toolResult',
            toolResult: {
              ...event.toolResult,
              tool: toolName
            },
            summary
          });

          this.postMessage({
            type: 'timelineEvent',
            event: {
              id: `res-${event.toolResult.callId}`,
              eventType: 'tool_result',
              title: `MCP Tool Result: ${toolName}`,
              detail: summary,
              status: 'completed',
              timestamp: Date.now()
            } as TimelineEvent
          });

          if (toolName === 'propose_edit' && event.toolResult.result?.proposalId) {
            this.postMessage({
              type: 'timelineEvent',
              event: {
                id: `prop-${event.toolResult.result.proposalId}`,
                eventType: 'diff_proposal',
                title: 'Diff Proposal Created',
                detail: `Registered proposed modification for ${event.toolResult.result.filePath || 'file'} pending review`,
                data: { proposalId: event.toolResult.result.proposalId },
                status: 'completed',
                timestamp: Date.now()
              } as TimelineEvent
            });
          }
        } else if (event.type === 'error') {
          this.postMessage({
            type: 'agentError',
            error: event.error
          });

          this.postMessage({
            type: 'timelineEvent',
            event: {
              id: `err-${Date.now()}`,
              eventType: 'error',
              title: 'Execution Error',
              detail: event.error || 'Turn execution failed',
              status: 'error',
              timestamp: Date.now()
            } as TimelineEvent
          });
        } else if (event.type === 'cancelled') {
          this.postMessage({
            type: 'agentCancelled',
            message: event.error || 'Turn cancelled by user'
          });

          this.postMessage({
            type: 'timelineEvent',
            event: {
              id: `canc-${Date.now()}`,
              eventType: 'cancelled',
              title: 'Execution Cancelled',
              detail: 'Turn was stopped on server',
              status: 'warning',
              timestamp: Date.now()
            } as TimelineEvent
          });
        }
      }

      const durationMs = Date.now() - startTime;
      this.postMessage({
        type: 'turnComplete',
        response: fullResponse,
        durationMs
      });

      this.postMessage({
        type: 'timelineEvent',
        event: {
          id: `done-${Date.now()}`,
          eventType: 'turn_complete',
          title: 'Turn Completed',
          detail: `TrueForge agent finished in ${(durationMs / 1000).toFixed(1)}s`,
          status: 'completed',
          timestamp: Date.now()
        } as TimelineEvent
      });
    } catch (err: any) {
      this.postMessage({
        type: 'agentError',
        error: err.message
      });
    } finally {
      this.postMessage({ type: 'statusChange', status: 'idle' });
    }
  }

  public async handleCancelTurn(): Promise<void> {
    const session = this.sessionManager.getCurrentSession();
    if (session) {
      await this.trueforgeClient.cancelTurn(session.id);
      this.postMessage({ type: 'agentCancelled', message: 'Cancelled by user.' });
      this.postMessage({ type: 'statusChange', status: 'idle' });
    }
  }

  public async handleNewSession(): Promise<void> {
    const session = await this.sessionManager.createNewSession();
    this.diffManager.clear();
    this.postMessage({
      type: 'newSessionCreated',
      session,
      proposals: []
    });
  }

  public async handleApplyChanges(proposalId?: string): Promise<void> {
    const result = await this.diffManager.applyAccepted(proposalId);
    if (result.success) {
      vscode.window.showInformationMessage(
        `ForgePilot: Applied ${result.appliedCount} file modification(s) successfully.`
      );
    } else {
      const errMsg = result.errors.join('; ') || 'Failed applying changes.';
      vscode.window.showErrorMessage(`ForgePilot Apply Failed: ${errMsg}`);
    }
    this.postMessage({
      type: 'applyResult',
      result,
      canUndo: this.diffManager.canUndo()
    });
    this.broadcastProposals();
  }

  public async handleUndo(): Promise<void> {
    const result = await this.diffManager.undo();
    if (result.success) {
      vscode.window.showInformationMessage(`ForgePilot: ${result.message}`);
    } else {
      vscode.window.showWarningMessage(`ForgePilot Undo: ${result.message}`);
    }
    this.postMessage({
      type: 'undoResult',
      result,
      canUndo: this.diffManager.canUndo()
    });
    this.broadcastProposals();
  }

  private async openFileInEditor(filePath: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    const fullUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(fullUri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Could not open file: ${err.message}`);
    }
  }

  public getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css')
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'icons', 'forgepilot.svg')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>ForgePilot</title>
</head>
<body>
  <!-- Header -->
  <div class="fp-header">
    <div class="fp-brand">
      <img src="${logoUri}" alt="ForgePilot" class="fp-logo-icon" />
      <span>ForgePilot</span>
      <span class="fp-status-badge">
        <span class="fp-status-dot" id="statusDot"></span>
        <span id="statusText">Ready</span>
      </span>
    </div>
    <div class="fp-header-actions">
      <button class="fp-icon-btn" id="newSessionBtn" title="Start New Conversation">+ New</button>
      <button class="fp-icon-btn" id="settingsBtn" title="Settings">&#9881;</button>
    </div>
  </div>

  <!-- Tabs -->
  <div class="fp-tabs">
    <button class="fp-tab active" data-tab="chat">
      Agent Chat
    </button>
    <button class="fp-tab" data-tab="diff">
      Diff Review <span class="fp-badge-counter" id="diffCountBadge">0</span>
    </button>
    <button class="fp-tab" data-tab="context">
      Context <span class="fp-badge-counter" id="ctxTokensBadge">0k</span>
    </button>
  </div>

  <!-- Tab 1: Chat Conversation -->
  <div class="fp-tab-content active" id="tab-chat">
    <div class="fp-chat-history" id="chatHistory">
      <div class="fp-message agent">
        <div class="fp-message-header">
          <span>ForgePilot Assistant</span>
          <button class="fp-copy-btn" onclick="copyMessageText(this)">Copy Response</button>
        </div>
        <div class="fp-message-body">
          <p>Welcome to <strong>ForgePilot</strong>. I am your autonomous coding assistant powered by TrueForge.</p>
          <p style="margin-top: 6px; font-size: 11px; color: var(--text-secondary);">
            Describe a task to discover files and propose multi-file changes, or use <code>Ctrl+Alt+I</code> for inline editing.
          </p>
        </div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="fp-input-container">
      <div class="fp-input-toolbar">
        <div>
          <select class="fp-mode-select" id="modeSelect">
            <option value="agent">Autonomous Agent</option>
            <option value="inline">Inline Edit</option>
          </select>
        </div>
        <div class="fp-mentions-hint">@file and @symbol supported</div>
      </div>
      <textarea
        class="fp-textarea"
        id="promptInput"
        placeholder="Ask ForgePilot to plan, edit files, or run tests... (Ctrl+Enter to send)"
      ></textarea>
      <div class="fp-actions-row">
        <span class="fp-keyboard-hint">Ctrl+Enter to send</span>
        <button class="fp-btn fp-btn-primary" id="sendBtn">Send</button>
      </div>
    </div>
  </div>

  <!-- Tab 2: Unified Diff Review Panel -->
  <div class="fp-tab-content" id="tab-diff">
    <div class="fp-diff-toolbar">
      <button class="fp-btn fp-btn-secondary" id="acceptAllBtn">Accept All</button>
      <button class="fp-btn fp-btn-secondary" id="rejectAllBtn">Reject All</button>
      <button class="fp-btn fp-btn-primary" id="applyBtn">Apply Approved Changes</button>
      <button class="fp-btn fp-btn-secondary" id="undoBtn" disabled>Undo</button>
    </div>
    <div class="fp-diff-container" id="diffContainer">
      <div style="text-align: center; color: var(--text-secondary); padding: 40px 15px; font-size: 12px;">
        No proposed edits. Changes proposed by Autonomous Agent or Inline Edit will appear here for safe review.
      </div>
    </div>
  </div>

  <!-- Tab 3: Context Explorer -->
  <div class="fp-tab-content" id="tab-context">
    <div class="fp-context-panel" id="contextPanel">
      <div class="fp-stat-card">
        <div class="fp-stat-title">Token Budget Usage</div>
        <div class="fp-stat-value">
          <span id="ctxTokensDisplay">0 / 20,000 tokens</span>
          <span id="ctxTokensPct" style="font-size: 12px; color: var(--text-secondary);">0%</span>
        </div>
        <div class="fp-progress-bar-bg">
          <div class="fp-progress-bar-fill" id="ctxProgressFill" style="width: 0%;"></div>
        </div>
      </div>
      <div class="fp-stat-card">
        <div class="fp-stat-title">Configured Agent Harness</div>
        <div style="font-size: 12px; color: var(--text-primary);" id="ctxModel">TrueForge Local Engine</div>
      </div>
      <div class="fp-stat-card">
        <div class="fp-stat-title">Retrieved Context Files</div>
        <div id="ctxFilesList" style="margin-top: 8px;">
          <div style="font-size: 11px; color: var(--text-secondary);">No context retrieved yet. Send a prompt to trigger context retrieval.</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Client Script -->
  <script>
    const vscode = acquireVsCodeApi();
    let currentProposals = [];
    let isWorking = false;

    // Elements
    const chatHistory = document.getElementById('chatHistory');
    const promptInput = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const modeSelect = document.getElementById('modeSelect');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const diffContainer = document.getElementById('diffContainer');
    const diffCountBadge = document.getElementById('diffCountBadge');
    const ctxTokensBadge = document.getElementById('ctxTokensBadge');
    const ctxTokensDisplay = document.getElementById('ctxTokensDisplay');
    const ctxTokensPct = document.getElementById('ctxTokensPct');
    const ctxProgressFill = document.getElementById('ctxProgressFill');
    const ctxFilesList = document.getElementById('ctxFilesList');
    const acceptAllBtn = document.getElementById('acceptAllBtn');
    const rejectAllBtn = document.getElementById('rejectAllBtn');
    const applyBtn = document.getElementById('applyBtn');
    const undoBtn = document.getElementById('undoBtn');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const settingsBtn = document.getElementById('settingsBtn');

    // Tab switching
    document.querySelectorAll('.fp-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.fp-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Send Message / Stop Generation
    function handleActionClick() {
      if (isWorking) {
        vscode.postMessage({ type: 'cancelTurn' });
        return;
      }
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      vscode.postMessage({
        type: 'sendMessage',
        text,
        mode: modeSelect.value
      });
    }

    sendBtn.addEventListener('click', handleActionClick);
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        handleActionClick();
      }
    });

    newSessionBtn.addEventListener('click', () => {
      chatHistory.innerHTML = '';
      appendAgentMessage('Started a new TrueForge session. How can I help you today?');
      vscode.postMessage({ type: 'newSession' });
    });

    settingsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openSettings' });
    });

    acceptAllBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'acceptAll' });
    });

    rejectAllBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'rejectAll' });
    });

    applyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'applyChanges' });
    });

    undoBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'undo' });
    });

    // Handle messages from Extension
    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'init':
          if (msg.proposals) {
            currentProposals = msg.proposals;
            renderDiffs(currentProposals);
          }
          if (msg.canUndo !== undefined) undoBtn.disabled = !msg.canUndo;
          if (msg.config) {
            const mEl = document.getElementById('ctxModel');
            if (mEl) mEl.textContent = (msg.config.primaryModel || 'gemini-2.5-pro') + ' via TrueForge (' + (msg.config.endpoint || 'local') + ')';
          }
          break;

        case 'userMessage':
          appendUserMessage(msg.text);
          break;

        case 'timelineEvent':
          appendTimelineItem(msg.event);
          break;

        case 'agentDelta':
          appendAgentDelta(msg.delta);
          break;

        case 'toolResult':
          updateTimelineToolResult(msg.toolResult, msg.summary);
          break;

        case 'agentError':
          appendErrorMessage(msg.error);
          break;

        case 'agentCancelled':
          appendWarningMessage(msg.message || 'Turn cancelled');
          break;

        case 'statusChange':
          updateStatus(msg.status);
          break;

        case 'proposalsUpdated':
          currentProposals = msg.proposals;
          renderDiffs(currentProposals);
          if (msg.canUndo !== undefined) undoBtn.disabled = !msg.canUndo;
          break;

        case 'contextRetrieved':
          renderContext(msg.context);
          break;

        case 'showProposal':
          switchToDiffsTabAndScroll(msg.proposalId);
          break;

        case 'applyResult':
          if (msg.canUndo !== undefined) undoBtn.disabled = !msg.canUndo;
          break;

        case 'undoResult':
          if (msg.canUndo !== undefined) undoBtn.disabled = !msg.canUndo;
          break;

        case 'newSessionCreated':
          currentProposals = [];
          renderDiffs([]);
          undoBtn.disabled = true;
          break;
      }
    });

    let activeAgentMsgBody = null;

    function appendUserMessage(text) {
      const msg = document.createElement('div');
      msg.className = 'fp-message user';
      msg.innerHTML = '<div class="fp-message-header"><span>You</span><span>' + formatTime() + '</span></div><div class="fp-message-body">' + escapeHtml(text).replace(/\\n/g, '<br/>') + '</div>';
      chatHistory.appendChild(msg);
      chatHistory.scrollTop = chatHistory.scrollHeight;
      activeAgentMsgBody = null;
    }

    function appendAgentMessage(text) {
      const msg = document.createElement('div');
      msg.className = 'fp-message agent';
      msg.innerHTML = '<div class="fp-message-header"><span>ForgePilot Assistant</span><button class="fp-copy-btn" onclick="copyMessageText(this)">Copy Response</button></div><div class="fp-message-body"><p>' + escapeHtml(text) + '</p></div>';
      chatHistory.appendChild(msg);
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function appendAgentDelta(delta) {
      if (!activeAgentMsgBody) {
        const msg = document.createElement('div');
        msg.className = 'fp-message agent';
        msg.innerHTML = '<div class="fp-message-header"><span>ForgePilot Assistant</span><button class="fp-copy-btn" onclick="copyMessageText(this)">Copy Response</button></div><div class="fp-message-body"></div>';
        chatHistory.appendChild(msg);
        activeAgentMsgBody = msg.querySelector('.fp-message-body');
      }
      activeAgentMsgBody.innerHTML += escapeHtml(delta).replace(/\\n/g, '<br/>');
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function appendTimelineItem(evt) {
      const item = document.createElement('div');
      item.className = 'fp-timeline-item';
      item.id = 'timeline-' + evt.id;

      let iconClass = 'tool';
      if (evt.eventType === 'context_retrieval') iconClass = 'context';
      else if (evt.eventType === 'diff_proposal') iconClass = 'proposal';
      else if (evt.eventType === 'error') iconClass = 'error';

      item.innerHTML = \`
        <div class="fp-timeline-header">
          <span class="fp-timeline-icon \${iconClass}">
            <span>&gt;</span>
            <span>\${escapeHtml(evt.title)}</span>
          </span>
          <span class="fp-timeline-status \${evt.status}">\${evt.status}</span>
        </div>
        <div class="fp-timeline-body">\${escapeHtml(evt.detail)}</div>
      \`;
      chatHistory.appendChild(item);
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function updateTimelineToolResult(toolResult, summary) {
      const item = document.getElementById('timeline-call-' + toolResult.callId);
      if (item) {
        const badge = item.querySelector('.fp-timeline-status');
        if (badge) {
          badge.className = 'fp-timeline-status completed';
          badge.textContent = 'completed';
        }
        const body = item.querySelector('.fp-timeline-body');
        if (body && summary) {
          body.textContent += '\\n\\nResult: ' + summary;
        }
      }
    }

    function appendErrorMessage(err) {
      const msg = document.createElement('div');
      msg.className = 'fp-message agent';
      msg.style.borderColor = 'var(--color-error)';
      msg.innerHTML = '<div class="fp-message-header" style="color: var(--color-error);"><span>Error</span><span>' + formatTime() + '</span></div><div class="fp-message-body" style="color: #FFB0B0;">' + escapeHtml(err) + '</div>';
      chatHistory.appendChild(msg);
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function appendWarningMessage(warn) {
      const msg = document.createElement('div');
      msg.className = 'fp-message agent';
      msg.style.borderColor = 'var(--color-warning)';
      msg.innerHTML = '<div class="fp-message-header" style="color: var(--color-warning);"><span>Notice</span><span>' + formatTime() + '</span></div><div class="fp-message-body" style="color: var(--color-warning);">' + escapeHtml(warn) + '</div>';
      chatHistory.appendChild(msg);
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function updateStatus(status) {
      isWorking = status === 'busy';
      if (isWorking) {
        statusDot.className = 'fp-status-dot busy';
        statusText.textContent = 'Executing...';
        sendBtn.className = 'fp-btn fp-btn-danger';
        sendBtn.textContent = '■ Stop';
      } else {
        statusDot.className = 'fp-status-dot';
        statusText.textContent = 'Ready';
        sendBtn.className = 'fp-btn fp-btn-primary';
        sendBtn.textContent = 'Send';
        activeAgentMsgBody = null;
      }
    }

    function renderDiffs(proposals) {
      diffCountBadge.textContent = proposals.length;
      if (proposals.length === 0) {
        diffContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 40px 15px; font-size: 12px;">No proposed edits pending review. Changes proposed by Autonomous Agent or Inline Edit will appear here.</div>';
        applyBtn.disabled = true;
        return;
      }

      applyBtn.disabled = false;
      diffContainer.innerHTML = '';

      proposals.forEach(p => {
        const card = document.createElement('div');
        card.className = 'fp-diff-card';
        card.id = 'proposal-' + p.id;

        const staleBannerHtml = p.isStale
          ? '<div class="fp-stale-banner">⚠️ ' + escapeHtml(p.staleReason || 'File modified on disk since proposal creation.') + '</div>'
          : '';

        card.innerHTML = \`
          <div class="fp-diff-header">
            <div class="fp-diff-file-title" onclick="openFile('\${escapeHtml(p.filePath)}')">
              <span>📄 \${escapeHtml(p.filePath)}</span>
              <span class="fp-diff-mode-badge">\${escapeHtml(p.mode)}</span>
              <span class="fp-diff-stats">
                <span class="fp-stat-add">+\${p.addedLines}</span>
                <span class="fp-stat-del">-\${p.deletedLines}</span>
              </span>
            </div>
            <div class="fp-diff-actions">
              <button class="fp-icon-btn" onclick="acceptAllProposal('\${p.id}')">Accept All</button>
              <button class="fp-icon-btn" onclick="rejectAllProposal('\${p.id}')">Reject All</button>
            </div>
          </div>
          \${staleBannerHtml}
        \`;

        p.hunks.forEach((h, idx) => {
          const hunkDiv = document.createElement('div');
          hunkDiv.className = 'fp-hunk';

          const linesHtml = h.lines.map(l => {
            const cls = l.startsWith('+') ? 'fp-line fp-line-add' : l.startsWith('-') ? 'fp-line fp-line-del' : 'fp-line fp-line-ctx';
            return \`<div class="\${cls}">\${escapeHtml(l)}</div>\`;
          }).join('');

          const statusColor = h.status === 'accepted' ? 'var(--color-success)' : h.status === 'rejected' ? 'var(--color-error)' : 'var(--text-secondary)';

          hunkDiv.innerHTML = \`
            <div class="fp-hunk-meta">
              <span>Hunk #\${idx + 1}: Lines -\${h.oldStart},\${h.oldLines} +\${h.newStart},\${h.newLines}</span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="color: \${statusColor}; font-weight: 600; text-transform: uppercase; font-size: 10px;">
                  [\${h.status}]
                </span>
                <button class="fp-icon-btn" onclick="acceptHunk('\${p.id}', '\${h.id}')">&#10003; Accept</button>
                <button class="fp-icon-btn" onclick="rejectHunk('\${p.id}', '\${h.id}')">&#10005; Reject</button>
              </div>
            </div>
            <div class="fp-hunk-lines">\${linesHtml}</div>
          \`;
          card.appendChild(hunkDiv);
        });

        diffContainer.appendChild(card);
      });
    }

    function acceptHunk(proposalId, hunkId) {
      vscode.postMessage({ type: 'acceptHunk', proposalId, hunkId });
    }

    function rejectHunk(proposalId, hunkId) {
      vscode.postMessage({ type: 'rejectHunk', proposalId, hunkId });
    }

    function acceptAllProposal(proposalId) {
      vscode.postMessage({ type: 'acceptAll', proposalId });
    }

    function rejectAllProposal(proposalId) {
      vscode.postMessage({ type: 'rejectAll', proposalId });
    }

    function openFile(filePath) {
      vscode.postMessage({ type: 'openFile', filePath });
    }

    function switchToDiffsTabAndScroll(proposalId) {
      document.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.fp-tab-content').forEach(c => c.classList.remove('active'));
      const diffTab = document.querySelector('.fp-tab[data-tab="diff"]');
      if (diffTab) diffTab.classList.add('active');
      const diffContent = document.getElementById('tab-diff');
      if (diffContent) diffContent.classList.add('active');

      setTimeout(() => {
        const card = document.getElementById('proposal-' + proposalId);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          card.style.borderColor = 'var(--primary-accent)';
          card.style.boxShadow = '0 0 12px rgba(62, 214, 196, 0.4)';
          setTimeout(() => {
            card.style.borderColor = '';
            card.style.boxShadow = '';
          }, 2500);
        }
      }, 100);
    }

    function renderContext(ctx) {
      const budget = ctx.tokenBudget || 20000;
      const tokens = ctx.totalTokens || 0;
      const pct = ctx.percentage || Math.min(100, Math.round((tokens / budget) * 100));

      ctxTokensBadge.textContent = Math.round(tokens / 1000) + 'k';
      ctxTokensDisplay.textContent = tokens.toLocaleString() + ' / ' + budget.toLocaleString() + ' tokens';
      ctxTokensPct.textContent = pct + '%';
      ctxProgressFill.style.width = pct + '%';
      if (pct > 90) ctxProgressFill.style.backgroundColor = 'var(--color-error)';
      else if (pct > 75) ctxProgressFill.style.backgroundColor = 'var(--color-warning)';
      else ctxProgressFill.style.backgroundColor = 'var(--primary-accent)';

      if (ctx.explanation && ctx.explanation.length > 0) {
        ctxFilesList.innerHTML = ctx.explanation.map(e => \`
          <div class="fp-context-file-item" onclick="openFile('\${escapeHtml(e.filePath)}')">
            <div class="fp-ctx-file-header">
              <span>📄 \${escapeHtml(e.filePath)}</span>
              <span>Score: \${e.score}</span>
            </div>
            <div class="fp-ctx-file-reason">\${escapeHtml(e.reason)}</div>
          </div>
        \`).join('');
      } else {
        ctxFilesList.innerHTML = '<div style="font-size: 11px; color: var(--text-secondary);">No context files retrieved.</div>';
      }
    }

    function copyMessageText(btn) {
      const msgBody = btn.closest('.fp-message').querySelector('.fp-message-body');
      if (!msgBody) return;
      const text = msgBody.innerText || msgBody.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        btn.style.color = 'var(--color-success)';
        setTimeout(() => {
          btn.textContent = orig;
          btn.style.color = '';
        }, 2000);
      });
    }

    function formatTime() {
      const d = new Date();
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>`;
  }
}
