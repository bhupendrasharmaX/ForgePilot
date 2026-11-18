import * as vscode from 'vscode';
import { TrueForgeClient } from '../services/trueforge';
import { ResilienceManager } from '../services/fallback';
import { SessionManager } from '../services/sessionManager';
import { DiffManager } from '../diff/diffManager';
import { ContextRetrievalEngine } from '../context/retrieval';

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
    this.diffManager.onDidChangeProposals((proposals) => {
      this.postMessage({
        type: 'proposalsUpdated',
        proposals
      });
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
      proposals: this.diffManager.listProposals(),
      canUndo: this.diffManager.canUndo(),
      config: this.trueforgeClient.getConfig()
    });
  }

  public postMessage(message: any): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public async handleUserMessage(promptText: string, mode: string = 'agent'): Promise<void> {
    if (!promptText.trim()) return;

    this.postMessage({
      type: 'userMessage',
      text: promptText,
      mode
    });

    this.postMessage({ type: 'statusChange', status: 'busy' });

    try {
      const session = await this.sessionManager.getOrCreateSession();

      // Retrieve repository context
      const context = await this.contextEngine.retrieveContext(promptText);

      this.postMessage({
        type: 'contextRetrieved',
        context: {
          totalTokens: context.totalTokens,
          files: context.allocations.map((a) => a.filePath),
          explanation: context.explanation
        }
      });

      // Stream turn through TrueForge with resilience fallback
      let fullResponse = '';
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
          this.postMessage({
            type: 'toolCall',
            toolCall: event.toolCall
          });
        } else if (event.type === 'tool_result' && event.toolResult) {
          this.postMessage({
            type: 'toolResult',
            toolResult: event.toolResult
          });
        } else if (event.type === 'error') {
          this.postMessage({
            type: 'agentError',
            error: event.error
          });
        } else if (event.type === 'cancelled') {
          this.postMessage({
            type: 'agentCancelled',
            message: event.error || 'Turn cancelled'
          });
        }
      }

      this.postMessage({
        type: 'turnComplete',
        response: fullResponse
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
      session
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

  private getHtmlForWebview(webview: vscode.Webview): string {
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
        <span id="statusText">TrueForge</span>
      </span>
    </div>
    <div class="fp-header-actions">
      <button class="fp-icon-btn" id="newSessionBtn" title="Start New Session">+ New</button>
      <button class="fp-icon-btn" id="settingsBtn" title="Settings">&#9881;</button>
    </div>
  </div>

  <!-- Tabs -->
  <div class="fp-tabs">
    <button class="fp-tab active" data-tab="chat">Agent</button>
    <button class="fp-tab" data-tab="diff">Diffs (<span id="diffCountBadge">0</span>)</button>
    <button class="fp-tab" data-tab="context">Context</button>
  </div>

  <!-- Tab 1: Chat Conversation -->
  <div class="fp-tab-content active" id="tab-chat">
    <div class="fp-chat-history" id="chatHistory">
      <div class="fp-message agent">
        <div class="fp-message-header">
          <span>ForgePilot Assistant</span>
          <span>TrueForge Active</span>
        </div>
        <div class="fp-message-body">
          <p>Welcome to <strong>ForgePilot</strong>. I am your autonomous coding assistant powered by TrueForge.</p>
          <p style="margin-top: 6px; font-size: 11px; color: var(--text-secondary);">
            Use <code>@file</code> or <code>@symbol</code> to attach specific code, or describe your task and I will discover files and propose safe edits.
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
        <div class="fp-mentions-hint">Type @file or @symbol</div>
      </div>
      <textarea
        class="fp-textarea"
        id="promptInput"
        placeholder="Ask ForgePilot to plan, edit files, or run tests..."
      ></textarea>
      <div class="fp-actions-row">
        <button class="fp-btn fp-btn-secondary" id="cancelBtn" style="display: none;">Cancel</button>
        <button class="fp-btn fp-btn-primary" id="sendBtn">Send</button>
      </div>
    </div>
  </div>

  <!-- Tab 2: Diff Review Panel -->
  <div class="fp-tab-content" id="tab-diff">
    <div class="fp-diff-toolbar">
      <button class="fp-btn fp-btn-secondary" id="acceptAllBtn">Accept All</button>
      <button class="fp-btn fp-btn-secondary" id="rejectAllBtn">Reject All</button>
      <button class="fp-btn fp-btn-success" id="applyBtn">Apply Accepted</button>
      <button class="fp-btn fp-btn-secondary" id="undoBtn" disabled>Undo</button>
    </div>
    <div class="fp-diff-container" id="diffContainer">
      <div style="text-align: center; color: var(--text-secondary); padding: 30px 10px;">
        No proposed edits. Edits proposed by ForgePilot will appear here for safe review.
      </div>
    </div>
  </div>

  <!-- Tab 3: Context Explorer -->
  <div class="fp-tab-content" id="tab-context">
    <div class="fp-context-panel" id="contextPanel">
      <div class="fp-stat-card">
        <div class="fp-stat-title">Token Budget</div>
        <div class="fp-stat-value" id="ctxTokens">20,000 max tokens</div>
      </div>
      <div class="fp-stat-card">
        <div class="fp-stat-title">Model Harness</div>
        <div style="font-size: 12px; color: var(--text-primary);" id="ctxModel">TrueForge Local / Remote</div>
      </div>
      <div class="fp-stat-card">
        <div class="fp-stat-title">Retrieved Context Files</div>
        <div id="ctxFilesList" style="font-size: 11px; font-family: var(--font-code); color: var(--text-secondary); margin-top: 6px;">
          None retrieved yet.
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
    const cancelBtn = document.getElementById('cancelBtn');
    const modeSelect = document.getElementById('modeSelect');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const diffContainer = document.getElementById('diffContainer');
    const diffCountBadge = document.getElementById('diffCountBadge');
    const acceptAllBtn = document.getElementById('acceptAllBtn');
    const rejectAllBtn = document.getElementById('rejectAllBtn');
    const applyBtn = document.getElementById('applyBtn');
    const undoBtn = document.getElementById('undoBtn');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const ctxFilesList = document.getElementById('ctxFilesList');

    // Tab switching
    document.querySelectorAll('.fp-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.fp-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Send Message
    function sendMessage() {
      const text = promptInput.value.trim();
      if (!text || isWorking) return;
      promptInput.value = '';
      vscode.postMessage({
        type: 'sendMessage',
        text,
        mode: modeSelect.value
      });
    }

    sendBtn.addEventListener('click', sendMessage);
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        sendMessage();
      }
    });

    cancelBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelTurn' });
    });

    newSessionBtn.addEventListener('click', () => {
      chatHistory.innerHTML = '';
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
        case 'userMessage':
          appendUserMessage(msg.text);
          break;
        case 'agentDelta':
          appendAgentDelta(msg.delta);
          break;
        case 'toolCall':
          appendToolCard(msg.toolCall);
          break;
        case 'toolResult':
          updateToolResult(msg.toolResult);
          break;
        case 'agentError':
          appendErrorMessage(msg.error);
          break;
        case 'statusChange':
          updateStatus(msg.status);
          break;
        case 'proposalsUpdated':
          currentProposals = msg.proposals;
          renderDiffs(currentProposals);
          break;
        case 'contextRetrieved':
          renderContext(msg.context);
          break;
        case 'applyResult':
          if (msg.canUndo !== undefined) undoBtn.disabled = !msg.canUndo;
          break;
        case 'undoResult':
          if (msg.canUndo !== undefined) undoBtn.disabled = !msg.canUndo;
          break;
      }
    });

    let activeAgentMsgBody = null;

    function appendUserMessage(text) {
      const msg = document.createElement('div');
      msg.className = 'fp-message user';
      msg.innerHTML = '<div class="fp-message-header">You</div><div class="fp-message-body">' + escapeHtml(text) + '</div>';
      chatHistory.appendChild(msg);
      chatHistory.scrollTop = chatHistory.scrollHeight;
      activeAgentMsgBody = null;
    }

    function appendAgentDelta(delta) {
      if (!activeAgentMsgBody) {
        const msg = document.createElement('div');
        msg.className = 'fp-message agent';
        msg.innerHTML = '<div class="fp-message-header"><span>ForgePilot</span><span>Streaming</span></div><div class="fp-message-body"></div>';
        chatHistory.appendChild(msg);
        activeAgentMsgBody = msg.querySelector('.fp-message-body');
      }
      activeAgentMsgBody.innerHTML += escapeHtml(delta).replace(/\\n/g, '<br/>');
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function appendToolCard(toolCall) {
      const card = document.createElement('div');
      card.className = 'fp-tool-card';
      card.id = 'tool-' + toolCall.callId;
      card.innerHTML = \`
        <div class="fp-tool-header">
          <span>&gt; MCP Tool: \${escapeHtml(toolCall.tool)}</span>
          <span style="color: var(--color-warning);">Running...</span>
        </div>
        <div class="fp-tool-body">
          <pre>\${escapeHtml(JSON.stringify(toolCall.input, null, 2))}</pre>
        </div>
      \`;
      chatHistory.appendChild(card);
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function updateToolResult(toolResult) {
      const card = document.getElementById('tool-' + toolResult.callId);
      if (card) {
        const header = card.querySelector('.fp-tool-header span:last-child');
        if (header) {
          header.textContent = 'Completed';
          header.style.color = 'var(--color-success)';
        }
      }
    }

    function appendErrorMessage(err) {
      const msg = document.createElement('div');
      msg.className = 'fp-message agent';
      msg.style.borderColor = 'var(--color-error)';
      msg.innerHTML = '<div class="fp-message-header" style="color: var(--color-error);">Error</div><div class="fp-message-body">' + escapeHtml(err) + '</div>';
      chatHistory.appendChild(msg);
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function updateStatus(status) {
      isWorking = status === 'busy';
      if (isWorking) {
        statusDot.className = 'fp-status-dot busy';
        statusText.textContent = 'Executing...';
        sendBtn.style.display = 'none';
        cancelBtn.style.display = 'inline-block';
      } else {
        statusDot.className = 'fp-status-dot';
        statusText.textContent = 'TrueForge';
        sendBtn.style.display = 'inline-block';
        cancelBtn.style.display = 'none';
        activeAgentMsgBody = null;
      }
    }

    function renderDiffs(proposals) {
      diffCountBadge.textContent = proposals.length;
      if (proposals.length === 0) {
        diffContainer.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 30px 10px;">No proposed edits pending review.</div>';
        return;
      }

      diffContainer.innerHTML = '';
      proposals.forEach(p => {
        const card = document.createElement('div');
        card.className = 'fp-diff-card';
        card.innerHTML = \`
          <div class="fp-diff-header">
            <span>\${escapeHtml(p.filePath)} (\${p.status})</span>
            <div class="fp-diff-actions">
              <button class="fp-icon-btn" onclick="acceptAllProposal('\${p.id}')">Accept All</button>
              <button class="fp-icon-btn" onclick="rejectAllProposal('\${p.id}')">Reject All</button>
            </div>
          </div>
        \`;

        p.hunks.forEach(h => {
          const hunkDiv = document.createElement('div');
          hunkDiv.className = 'fp-hunk';
          const linesHtml = h.lines.map(l => {
            const cls = l.startsWith('+') ? 'fp-line-add' : l.startsWith('-') ? 'fp-line-del' : '';
            return \`<div class="\${cls}">\${escapeHtml(l)}</div>\`;
          }).join('');

          hunkDiv.innerHTML = \`
            <div class="fp-hunk-meta">
              <span>Lines -\${h.oldStart},\${h.oldLines} +\${h.newStart},\${h.newLines}</span>
              <div>
                <span style="margin-right: 8px; color: \${h.status === 'accepted' ? 'var(--color-success)' : h.status === 'rejected' ? 'var(--color-error)' : 'var(--text-secondary)'}">
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

    function renderContext(ctx) {
      if (ctx.explanation && ctx.explanation.length > 0) {
        ctxFilesList.innerHTML = ctx.explanation.map(e => \`
          <div style="margin-bottom: 6px;">
            <div style="color: var(--primary-blue);">\${escapeHtml(e.filePath)} (score: \${e.score})</div>
            <div style="font-size: 10px; color: var(--text-secondary);">\${escapeHtml(e.reason)}</div>
          </div>
        \`).join('');
      }
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

