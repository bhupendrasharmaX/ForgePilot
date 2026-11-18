import * as vscode from 'vscode';
import { TrueForgeClient } from './services/trueforge';
import { ResilienceManager } from './services/fallback';
import { SessionManager } from './services/sessionManager';
import { DiffManager } from './diff/diffManager';
import { ContextRetrievalEngine } from './context/retrieval';
import { McpToolHandler } from './mcp/tools';
import { AgentPanelProvider } from './providers/agentPanel';
import { handleInlineEdit } from './commands/inlineEdit';
import { openAgentSidebar } from './commands/openAgent';
import { reviewChanges } from './commands/reviewChanges';
import { cancelAgentTurn } from './commands/cancelAgent';

export function activate(context: vscode.ExtensionContext): void {
  // Determine active workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot =
    workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : process.cwd();

  // Read configuration
  const config = vscode.workspace.getConfiguration('forgepilot');
  const endpoint = config.get<string>('trueforgeEndpoint', 'http://localhost:8790');
  const apiKey = config.get<string>('apiKey', '');
  const primaryModel = config.get<string>('primaryModel', 'gemini-2.5-pro');
  const fallbackModel = config.get<string>('fallbackModel', 'gemini-2.5-flash');
  const tokenBudget = config.get<number>('tokenBudget', 20000);

  // Initialize core services
  const diffManager = new DiffManager(workspaceRoot);
  const mcpHandler = new McpToolHandler(workspaceRoot, diffManager);

  // Set approval hook for terminal commands
  mcpHandler.setApprovalHook(async (cmd: string) => {
    const action = await vscode.window.showWarningMessage(
      `ForgePilot Security: The agent requested permission to run terminal command:\n\n${cmd}`,
      { modal: true },
      'Allow Execution',
      'Deny'
    );
    return action === 'Allow Execution';
  });

  const trueforgeClient = new TrueForgeClient(
    {
      endpoint,
      apiKey,
      primaryModel,
      fallbackModel
    },
    mcpHandler
  );

  const resilienceManager = new ResilienceManager(trueforgeClient, {
    maxRetries: 3,
    initialDelayMs: 1000,
    onFallback: (from, to, reason) => {
      vscode.window.showWarningMessage(
        `ForgePilot Resilience: Switched from ${from} to fallback model ${to} (${reason})`
      );
    }
  });

  const sessionManager = new SessionManager(trueforgeClient);
  const contextEngine = new ContextRetrievalEngine(workspaceRoot, tokenBudget);

  // Register Webview View Provider
  const agentPanelProvider = new AgentPanelProvider(
    context.extensionUri,
    trueforgeClient,
    resilienceManager,
    sessionManager,
    diffManager,
    contextEngine
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewType, agentPanelProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.openAgent', () => openAgentSidebar()),
    vscode.commands.registerCommand('forgepilot.inlineEdit', () =>
      handleInlineEdit(trueforgeClient, resilienceManager, sessionManager, diffManager)
    ),
    vscode.commands.registerCommand('forgepilot.reviewChanges', () => reviewChanges(diffManager)),
    vscode.commands.registerCommand('forgepilot.cancelAgent', () =>
      cancelAgentTurn(trueforgeClient, sessionManager)
    ),
    vscode.commands.registerCommand('forgepilot.newSession', async () => {
      await agentPanelProvider.handleNewSession();
      vscode.window.showInformationMessage('ForgePilot: Started new TrueForge session.');
    })
  );

  // Listen for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const newRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        diffManager.setWorkspaceRoot(newRoot);
        mcpHandler.setWorkspaceRoot(newRoot);
        contextEngine.setWorkspaceRoot(newRoot);
      }
    })
  );

  // Listen for configuration updates
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('forgepilot')) {
        const updatedConfig = vscode.workspace.getConfiguration('forgepilot');
        trueforgeClient.updateConfig({
          endpoint: updatedConfig.get<string>('trueforgeEndpoint', 'http://localhost:8790'),
          apiKey: updatedConfig.get<string>('apiKey', ''),
          primaryModel: updatedConfig.get<string>('primaryModel', 'gemini-2.5-pro'),
          fallbackModel: updatedConfig.get<string>('fallbackModel', 'gemini-2.5-flash')
        });
        contextEngine.setMaxTokens(updatedConfig.get<number>('tokenBudget', 20000));
      }
    })
  );
}

export function deactivate(): void {
  // Clean up resources if needed
}
