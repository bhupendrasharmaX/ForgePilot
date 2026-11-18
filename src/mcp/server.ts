import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { McpToolHandler } from './tools';
import { DiffManager } from '../diff/diffManager';

export const FORGEPILOT_MCP_TOOLS: Tool[] = [
  {
    name: 'search_workspace',
    description: 'Search files and source code across the workspace directory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring or symbol to search for' },
        filePattern: { type: 'string', description: 'Optional glob or extension filter' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default: 50)' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_files',
    description: 'List relevant files in the workspace or specific subdirectory.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Subdirectory relative to workspace' },
        maxFiles: { type: 'number', description: 'Maximum file count to list (default: 200)' }
      }
    }
  },
  {
    name: 'read_file',
    description: 'Read file contents and specific line ranges safely within workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace' },
        startLine: { type: 'number', description: '1-based starting line number' },
        endLine: { type: 'number', description: '1-based ending line number' }
      },
      required: ['path']
    }
  },
  {
    name: 'get_symbols',
    description: 'Find functions, classes, methods, and declarations in code.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to inspect' },
        query: { type: 'string', description: 'Symbol name query' }
      }
    }
  },
  {
    name: 'get_references',
    description: 'Find references and occurrences of a symbol across the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to search for' },
        filePattern: { type: 'string', description: 'Optional file pattern' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'get_workspace_context',
    description: 'Return high-level workspace metadata, git branch, and project overview.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'propose_edit',
    description:
      'Generate proposed modifications for a file without writing to disk. Changes are routed to ForgePilot diff review for developer approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace' },
        proposedContent: { type: 'string', description: 'Complete new file content' },
        summary: { type: 'string', description: 'Summary description of the proposed change' }
      },
      required: ['path', 'proposedContent']
    }
  },
  {
    name: 'run_command',
    description: 'Execute permitted terminal commands in the workspace after developer approval.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' }
      },
      required: ['command']
    }
  },
  {
    name: 'run_tests',
    description: 'Run project tests (pytest / npm test) and return execution results.',
    inputSchema: {
      type: 'object',
      properties: {
        testCommand: { type: 'string', description: 'Custom test command (optional)' },
        path: { type: 'string', description: 'Specific test file or directory' }
      }
    }
  },
  {
    name: 'get_git_status',
    description: 'Retrieve current git status and modified files in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_file_diff',
    description: 'Retrieve proposed file differences, hunks, and review status.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'Specific proposal ID' },
        path: { type: 'string', description: 'Filter by file path' }
      }
    }
  },
  {
    name: 'inspect_project',
    description: 'Inspect project structure, manifest files, and framework configurations.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

export class ForgePilotMcpServer {
  private server: Server;
  private handler: McpToolHandler;

  constructor(workspaceRoot: string, diffManager: DiffManager) {
    this.handler = new McpToolHandler(workspaceRoot, diffManager);

    this.server = new Server(
      {
        name: 'forgepilot-mcp-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();
  }

  public getHandler(): McpToolHandler {
    return this.handler;
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: FORGEPILOT_MCP_TOOLS };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: any;
        switch (name) {
          case 'search_workspace':
            result = await this.handler.searchWorkspace(args as any);
            break;
          case 'list_files':
            result = await this.handler.listFiles(args as any);
            break;
          case 'read_file':
            result = await this.handler.readFile(args as any);
            break;
          case 'get_symbols':
            result = await this.handler.getSymbols(args as any);
            break;
          case 'get_references':
            result = await this.handler.getReferences(args as any);
            break;
          case 'get_workspace_context':
            result = await this.handler.getWorkspaceContext();
            break;
          case 'propose_edit':
            result = await this.handler.proposeEdit(args as any);
            break;
          case 'run_command':
            result = await this.handler.runCommand(args as any);
            break;
          case 'run_tests':
            result = await this.handler.runTests(args as any);
            break;
          case 'get_git_status':
            result = await this.handler.getGitStatus();
            break;
          case 'get_file_diff':
            result = await this.handler.getFileDiff(args as any);
            break;
          case 'inspect_project':
            result = await this.handler.inspectProject();
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error executing ${name}: ${err.message}`
            }
          ]
        };
      }
    });
  }

  public async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
