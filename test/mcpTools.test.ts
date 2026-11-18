import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpToolHandler } from '../src/mcp/tools';
import { DiffManager } from '../src/diff/diffManager';
import { FORGEPILOT_MCP_TOOLS } from '../src/mcp/server';

describe('MCP Tools & Handler', () => {
  let tmpDir: string;
  let diffManager: DiffManager;
  let handler: McpToolHandler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgepilot-mcp-test-'));
    diffManager = new DiffManager(tmpDir);
    handler = new McpToolHandler(tmpDir, diffManager);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exposes exactly 12 official MCP tools with valid schemas', () => {
    expect(FORGEPILOT_MCP_TOOLS.length).toBe(12);
    const names = FORGEPILOT_MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      'search_workspace',
      'list_files',
      'read_file',
      'get_symbols',
      'get_references',
      'get_workspace_context',
      'propose_edit',
      'run_command',
      'run_tests',
      'get_git_status',
      'get_file_diff',
      'inspect_project'
    ]);
  });

  it('prevents path traversal outside active workspace directory', async () => {
    await expect(
      handler.readFile({ path: '../../etc/passwd' })
    ).rejects.toThrow(/outside the active workspace directory/);
  });

  it('reads file lines and line ranges within workspace', async () => {
    const filePath = path.join(tmpDir, 'data.txt');
    fs.writeFileSync(filePath, 'line 1\nline 2\nline 3\nline 4\n', 'utf8');

    const res = await handler.readFile({ path: 'data.txt', startLine: 2, endLine: 3 });
    expect(res.content).toBe('line 2\nline 3');
    expect(res.totalLines).toBe(5);
  });

  it('propose_edit never writes directly to disk', async () => {
    const filePath = path.join(tmpDir, 'safe.py');
    fs.writeFileSync(filePath, 'def original(): pass\n', 'utf8');

    const res = await handler.proposeEdit({
      path: 'safe.py',
      proposedContent: 'def modified(): pass\n'
    });

    expect(res.proposalId).toBeDefined();

    // Verify on disk file was NOT modified!
    const diskContent = fs.readFileSync(filePath, 'utf8');
    expect(diskContent).toBe('def original(): pass\n');

    // Verify proposal in diffManager
    const proposals = diffManager.listProposals();
    expect(proposals.length).toBe(1);
    expect(proposals[0].filePath).toBe('safe.py');
  });

  it('blocks dangerous commands and enforces approval hook', async () => {
    await expect(
      handler.runCommand({ command: 'rm -rf /' })
    ).rejects.toThrow(/rejected due to security policy/);

    // Test rejection hook
    handler.setApprovalHook(async () => false);
    await expect(
      handler.runCommand({ command: 'echo hello' })
    ).rejects.toThrow(/User rejected execution/);
  });
});
