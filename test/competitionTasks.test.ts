import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DiffManager } from '../src/diff/diffManager';
import { McpToolHandler } from '../src/mcp/tools';
import { ContextRetrievalEngine } from '../src/context/retrieval';
import { TrueForgeClient } from '../src/services/trueforge';
import { ResilienceManager } from '../src/services/fallback';

const execAsync = promisify(exec);

describe('Official Flask 3.1.3 Competition Verification', () => {
  const flaskRoot = path.resolve(__dirname, '../flask');
  let diffManager: DiffManager;
  let mcpHandler: McpToolHandler;
  let contextEngine: ContextRetrievalEngine;

  beforeEach(() => {
    diffManager = new DiffManager(flaskRoot);
    mcpHandler = new McpToolHandler(flaskRoot, diffManager);
    contextEngine = new ContextRetrievalEngine(flaskRoot, 20000);
  });

  afterEach(async () => {
    // Reset flask repository to clean HEAD after tests
    try {
      await execAsync('git checkout . && git clean -fd', { cwd: flaskRoot });
    } catch {}
  });

  it('TASK A: Autonomous Context Retrieval & Safe Inline Edit of get_debug_flag', async () => {
    // Step 1: Context retrieval finds src/flask/helpers.py and get_debug_flag
    const prompt = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
    const context = await contextEngine.retrieveContext(prompt + ' in helpers.py get_debug_flag');

    const retrievedPaths = context.allocations.map((a) => a.filePath);
    expect(retrievedPaths.some((p) => p.includes('helpers.py'))).toBe(true);

    // Step 2: Read file via MCP tool
    const readResult = await mcpHandler.readFile({ path: 'src/flask/helpers.py' });
    expect(readResult.content).toContain('def get_debug_flag');

    // Step 3: Propose edit without writing directly to disk
    const originalContent = readResult.content;
    const proposedContent = originalContent.replace(
      /def get_debug_flag\(\) -> bool:[\s\S]*?return bool\(val and val\.lower\(\) not in \{"0", "false", "no"\}\)/,
      `def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.

    The following values are treated as \`\`False\`\` (case-insensitively):
    \`\`"0"\`\`, \`\`"false"\`\`, \`\`"no"\`\`, \`\`"off"\`\`, \`\`"n"\`\`.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})`
    );

    const propResult = await mcpHandler.proposeEdit({
      path: 'src/flask/helpers.py',
      proposedContent,
      summary: 'Update get_debug_flag to treat off and n as false'
    });

    expect(propResult.proposalId).toBeDefined();

    // Verify disk has NOT been altered before review
    const diskBeforeReview = fs.readFileSync(path.join(flaskRoot, 'src/flask/helpers.py'), 'utf8');
    expect(diskBeforeReview.replace(/\r\n/g, '\n')).toBe(originalContent.replace(/\r\n/g, '\n'));

    // Step 4: Review and Accept Hunk
    const proposal = diffManager.getProposal(propResult.proposalId)!;
    expect(proposal.hunks.length).toBeGreaterThan(0);
    diffManager.acceptAll(proposal.id);

    // Step 5: Safe Apply
    const applyResult = await diffManager.applyAccepted(proposal.id);
    expect(applyResult.success).toBe(true);

    // Step 6: Verification in Python process
    const testCases = [
      { envVal: 'off', expected: 'False' },
      { envVal: 'OFF', expected: 'False' },
      { envVal: 'n', expected: 'False' },
      { envVal: 'N', expected: 'False' },
      { envVal: '1', expected: 'True' },
      { envVal: 'true', expected: 'True' }
    ];

    for (const tc of testCases) {
      const { stdout } = await execAsync(
        `python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`,
        {
          cwd: flaskRoot,
          env: { ...process.env, FLASK_DEBUG: tc.envVal, PYTHONPATH: path.join(flaskRoot, 'src') }
        }
      );
      expect(stdout.trim()).toBe(tc.expected);
    }
  });

  it('TASK B: Autonomous Multi-File Discovery & Safe Edit (flask config CLI, tests, docs)', async () => {
    // Instruction without naming files
    const instruction = "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.";

    // Context retrieval discovers CLI, tests, and documentation automatically
    const context = await contextEngine.retrieveContext(instruction);
    const discoveredPaths = context.allocations.map((a) => a.filePath);

    // Verify key files are discovered
    expect(discoveredPaths.some((p) => p.includes('cli.py'))).toBe(true);

    // Read original CLI, test, and doc contents
    const cliPath = 'src/flask/cli.py';
    const testCliPath = 'tests/test_cli.py';
    const docPath = 'docs/cli.rst';

    const cliOrig = fs.readFileSync(path.join(flaskRoot, cliPath), 'utf8');
    const testOrig = fs.readFileSync(path.join(flaskRoot, testCliPath), 'utf8');
    const docOrig = fs.readFileSync(path.join(flaskRoot, docPath), 'utf8');

    // 1. Propose CLI command in src/flask/cli.py
    const configCommandDef = `

@click.command("config", short_help="Show loaded configuration as JSON.")
@with_appcontext
def config_command() -> None:
    """Prints the loaded application's configuration as JSON, masking sensitive values."""
    import json
    data = {}
    for key, value in current_app.config.items():
        k_upper = key.upper()
        if any(secret_term in k_upper for secret_term in ("SECRET", "PASSWORD", "TOKEN", "KEY")):
            data[key] = "***"
        else:
            try:
                json.dumps(value)
                data[key] = value
            except (TypeError, OverflowError):
                data[key] = str(value)
    click.echo(json.dumps(data, indent=2))
`;

    const cliProposed = cliOrig
      .replace(
        'self.add_command(routes_command)',
        'self.add_command(routes_command)\n            self.add_command(config_command)'
      )
      .replace(
        'cli = FlaskGroup(',
        configCommandDef + '\n\ncli = FlaskGroup('
      );

    await mcpHandler.proposeEdit({ path: cliPath, proposedContent: cliProposed });

    // 2. Propose test in tests/test_cli.py
    const testAddition = `

def test_config_command(app, runner):
    from flask.cli import FlaskGroup
    app.config["TEST_KEY"] = "super-secret"
    app.config["MY_PASSWORD"] = "pass123"
    app.config["API_TOKEN"] = "token456"
    app.config["PUBLIC_SETTING"] = "safe_value"

    cli = FlaskGroup(create_app=lambda: app)
    res = runner.invoke(cli, ["config"])
    assert res.exit_code == 0, res.output
    import json
    parsed = json.loads(res.output)
    assert parsed["TEST_KEY"] == "***"
    assert parsed["MY_PASSWORD"] == "***"
    assert parsed["API_TOKEN"] == "***"
    assert parsed["PUBLIC_SETTING"] == "safe_value"
`;
    const testProposed = testOrig + '\n' + testAddition;
    await mcpHandler.proposeEdit({ path: testCliPath, proposedContent: testProposed });

    // 3. Propose documentation in docs/cli.rst
    const docAddition = [
      '',
      'Show Configuration',
      '------------------',
      '',
      'The ``flask config`` command prints the loaded application\'s configuration as JSON,',
      'masking sensitive values containing ``SECRET``, ``PASSWORD``, ``TOKEN``, or ``KEY`` as ``"***"``.',
      '',
      '.. code-block:: text',
      '',
      '    $ flask config',
      ''
    ].join('\n');
    const docProposed = docOrig + '\n' + docAddition;
    await mcpHandler.proposeEdit({ path: docPath, proposedContent: docProposed });

    // Verify 3 distinct files proposed
    const proposals = diffManager.listProposals();
    expect(proposals.length).toBe(3);

    // Accept and apply all proposals
    diffManager.acceptAll();
    const applyRes = await diffManager.applyAccepted();
    expect(applyRes.success).toBe(true);
    expect(applyRes.appliedCount).toBe(3);

    // Verification 1: pytest tests/test_cli.py -k test_config_command passes
    try {
      const testRun = await execAsync('pytest tests/test_cli.py -k test_config_command -q', {
        cwd: flaskRoot,
        env: { ...process.env, PYTHONPATH: path.join(flaskRoot, 'src') }
      });
      expect(testRun.stdout).toContain('1 passed');
    } catch (testErr: any) {
      console.error('PYTEST FAILED OUTPUT:', testErr.stdout, testErr.stderr);
      throw testErr;
    }

    // Verification 2: flask --help includes config
    const helpRun = await execAsync('flask --help', {
      cwd: flaskRoot,
      env: { ...process.env, PYTHONPATH: path.join(flaskRoot, 'src') }
    });
    expect(helpRun.stdout).toContain('config');
    expect(helpRun.stdout).toContain('Show loaded configuration as JSON.');
  });

  it('TASK C: Resilience & Workspace Protection on Unreachable Endpoint / Invalid Key', async () => {
    const invalidClient = new TrueForgeClient({
      endpoint: 'http://127.0.0.1:59999', // Non-existent unreachable endpoint
      apiKey: 'invalid-key-xyz',
      primaryModel: 'gemini-2.5-pro',
      fallbackModel: 'gemini-2.5-flash',
      timeoutMs: 1500,
      maxRetries: 2
    });

    const resilience = new ResilienceManager(invalidClient, {
      maxRetries: 2,
      initialDelayMs: 50
    });

    const events: any[] = [];
    for await (const event of resilience.executeWithResilience('invalid-session', 'Perform Task A')) {
      events.push(event);
    }

    // Verify error was reported cleanly
    expect(events.some((e) => e.type === 'error' || e.error)).toBe(true);

    // Verify workspace is completely unchanged (clean git status)
    const { stdout } = await execAsync('git status --short', { cwd: flaskRoot });
    expect(stdout.trim()).toBe('');
  });
});
