import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolveSafePath, toWorkspaceRelative } from '../utils/pathValidation';
import { DiffManager } from '../diff/diffManager';
import { SymbolIndex } from '../context/symbolIndex';
import {
  SearchWorkspaceArgs,
  ListFilesArgs,
  ReadFileArgs,
  GetSymbolsArgs,
  GetReferencesArgs,
  ProposeEditArgs,
  RunCommandArgs,
  RunTestsArgs,
  GetFileDiffArgs
} from './types';

const execAsync = promisify(exec);

export class McpToolHandler {
  private workspaceRoot: string;
  private diffManager: DiffManager;
  private symbolIndex: SymbolIndex;
  private commandApprovalHook?: (cmd: string) => Promise<boolean>;

  constructor(
    workspaceRoot: string,
    diffManager: DiffManager,
    commandApprovalHook?: (cmd: string) => Promise<boolean>
  ) {
    this.workspaceRoot = workspaceRoot;
    this.diffManager = diffManager;
    this.symbolIndex = new SymbolIndex();
    this.commandApprovalHook = commandApprovalHook;
  }

  public setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
    this.diffManager.setWorkspaceRoot(root);
  }

  public setApprovalHook(hook: (cmd: string) => Promise<boolean>): void {
    this.commandApprovalHook = hook;
  }

  // 1. search_workspace
  public async searchWorkspace(args: SearchWorkspaceArgs): Promise<any> {
    const { query, maxResults = 50 } = args;
    const results: Array<{ file: string; line: number; text: string }> = [];

    const searchDir = (dir: string) => {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (['.git', 'node_modules', 'dist', '__pycache__', '.pytest_cache'].includes(entry.name)) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          searchDir(fullPath);
        } else if (entry.isFile()) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;
              if (lines[i].includes(query)) {
                results.push({
                  file: toWorkspaceRelative(this.workspaceRoot, fullPath),
                  line: i + 1,
                  text: lines[i].trim()
                });
              }
            }
          } catch {
            // Ignore binary / unreadable
          }
        }
      }
    };

    searchDir(this.workspaceRoot);
    return { query, totalMatches: results.length, matches: results };
  }

  // 2. list_files
  public async listFiles(args: ListFilesArgs): Promise<any> {
    const targetDir = args.directory
      ? resolveSafePath(this.workspaceRoot, args.directory)
      : this.workspaceRoot;

    const maxFiles = args.maxFiles || 200;
    const fileList: string[] = [];

    const walk = (d: string) => {
      if (fileList.length >= maxFiles) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }

      for (const e of entries) {
        if (fileList.length >= maxFiles) break;
        if (['.git', 'node_modules', 'dist', '__pycache__'].includes(e.name)) continue;

        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else {
          fileList.push(toWorkspaceRelative(this.workspaceRoot, p));
        }
      }
    };

    walk(targetDir);
    return { baseDirectory: toWorkspaceRelative(this.workspaceRoot, targetDir), files: fileList };
  }

  // 3. read_file
  public async readFile(args: ReadFileArgs): Promise<any> {
    const fullPath = resolveSafePath(this.workspaceRoot, args.path);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File does not exist: ${args.path}`);
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    let selectedLines = lines;
    const startLine = args.startLine ? Math.max(1, args.startLine) : 1;
    const endLine = args.endLine ? Math.min(totalLines, args.endLine) : totalLines;

    const hasCrLf = content.includes('\r\n');
    selectedLines = lines.slice(startLine - 1, endLine);

    return {
      path: toWorkspaceRelative(this.workspaceRoot, fullPath),
      totalLines,
      startLine,
      endLine,
      content: selectedLines.join(hasCrLf ? '\r\n' : '\n')
    };
  }

  // 4. get_symbols
  public async getSymbols(args: GetSymbolsArgs): Promise<any> {
    if (args.path) {
      const fullPath = resolveSafePath(this.workspaceRoot, args.path);
      const content = fs.readFileSync(fullPath, 'utf8');
      const symbols = this.symbolIndex.extractSymbolsFromFile(
        toWorkspaceRelative(this.workspaceRoot, fullPath),
        content
      );
      return {
        path: args.path,
        symbols: args.query
          ? symbols.filter((s) => s.name.toLowerCase().includes(args.query!.toLowerCase()))
          : symbols
      };
    }

    return {
      symbols: args.query ? this.symbolIndex.findSymbols(args.query) : this.symbolIndex.getAllSymbols()
    };
  }

  // 5. get_references
  public async getReferences(args: GetReferencesArgs): Promise<any> {
    const { symbol } = args;
    const occurrences: Array<{ file: string; line: number; text: string }> = [];

    const searchDir = (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (['.git', 'node_modules', 'dist', '__pycache__'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          searchDir(full);
        } else if (entry.isFile()) {
          try {
            const content = fs.readFileSync(full, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(symbol)) {
                occurrences.push({
                  file: toWorkspaceRelative(this.workspaceRoot, full),
                  line: i + 1,
                  text: lines[i].trim()
                });
              }
            }
          } catch {}
        }
      }
    };

    searchDir(this.workspaceRoot);
    return { symbol, referencesCount: occurrences.length, references: occurrences };
  }

  // 6. get_workspace_context
  public async getWorkspaceContext(): Promise<any> {
    const files = await this.listFiles({ maxFiles: 50 });
    let gitBranch = 'unknown';
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.workspaceRoot
      });
      gitBranch = stdout.trim();
    } catch {}

    const projectType = fs.existsSync(path.join(this.workspaceRoot, 'setup.py')) ||
      fs.existsSync(path.join(this.workspaceRoot, 'pyproject.toml'))
      ? 'Python'
      : fs.existsSync(path.join(this.workspaceRoot, 'package.json'))
      ? 'Node.js/TypeScript'
      : 'Generic';

    return {
      workspaceRoot: this.workspaceRoot,
      projectType,
      gitBranch,
      sampleFiles: files.files.slice(0, 20)
    };
  }

  // 7. propose_edit (Never writes immediately to disk!)
  public async proposeEdit(args: ProposeEditArgs, sessionId?: string): Promise<any> {
    const proposal = this.diffManager.createProposal(
      args.path,
      args.proposedContent,
      sessionId,
      args.summary || `Proposed edit for ${args.path}`
    );

    return {
      proposalId: proposal.id,
      filePath: proposal.filePath,
      hunksCount: proposal.hunks.length,
      status: proposal.status,
      message:
        'Proposed edit registered in ForgePilot diff review. Awaiting developer approval before disk application.'
    };
  }

  // 8. run_command (Requires safety approval)
  public async runCommand(args: RunCommandArgs): Promise<any> {
    const { command, timeoutMs = 30000 } = args;

    // Disallow dangerous system destructive commands
    const lower = command.toLowerCase();
    if (lower.includes('rm -rf /') || lower.includes('format c:')) {
      throw new Error(`Command "${command}" rejected due to security policy.`);
    }

    if (this.commandApprovalHook) {
      const approved = await this.commandApprovalHook(command);
      if (!approved) {
        throw new Error(`User rejected execution of command: "${command}"`);
      }
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workspaceRoot,
        timeout: timeoutMs
      });
      return { command, stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      return {
        command,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
        exitCode: err.code || 1
      };
    }
  }

  // 9. run_tests
  public async runTests(args: RunTestsArgs): Promise<any> {
    let testCmd = args.testCommand;
    if (!testCmd) {
      if (fs.existsSync(path.join(this.workspaceRoot, 'pyproject.toml')) ||
          fs.existsSync(path.join(this.workspaceRoot, 'tests'))) {
        testCmd = args.path ? `pytest ${args.path} -q` : 'pytest -q';
      } else if (fs.existsSync(path.join(this.workspaceRoot, 'package.json'))) {
        testCmd = 'npm test';
      } else {
        testCmd = 'pytest -q';
      }
    }

    return this.runCommand({ command: testCmd });
  }

  // 10. get_git_status
  public async getGitStatus(): Promise<any> {
    try {
      const { stdout } = await execAsync('git status --short', { cwd: this.workspaceRoot });
      return { gitStatus: stdout.trim() };
    } catch (err: any) {
      return { error: `Failed to retrieve git status: ${err.message}` };
    }
  }

  // 11. get_file_diff
  public async getFileDiff(args: GetFileDiffArgs): Promise<any> {
    if (args.proposalId) {
      const proposal = this.diffManager.getProposal(args.proposalId);
      if (!proposal) throw new Error(`Proposal not found: ${args.proposalId}`);
      return {
        proposalId: proposal.id,
        filePath: proposal.filePath,
        status: proposal.status,
        hunks: proposal.hunks
      };
    }

    return {
      allProposals: this.diffManager.listProposals().map((p) => ({
        id: p.id,
        filePath: p.filePath,
        status: p.status,
        hunksCount: p.hunks.length
      }))
    };
  }

  // 12. inspect_project
  public async inspectProject(): Promise<any> {
    const inspection: Record<string, any> = {
      workspace: this.workspaceRoot,
      manifests: []
    };

    const filesToCheck = [
      'pyproject.toml',
      'setup.py',
      'setup.cfg',
      'requirements.txt',
      'package.json',
      'README.md'
    ];

    for (const f of filesToCheck) {
      const full = path.join(this.workspaceRoot, f);
      if (fs.existsSync(full)) {
        try {
          inspection.manifests.push({
            file: f,
            snippet: fs.readFileSync(full, 'utf8').slice(0, 500)
          });
        } catch {}
      }
    }

    return inspection;
  }
}
