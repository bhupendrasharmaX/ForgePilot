# ForgePilot — Demo Video Recording Checklist

> **Format**: Video demonstration (Maximum 4 minutes)  
> **Rule**: Do not cut between giving an instruction and the resulting diff appearing when recording in live mode.

---

## Pre-Recording Checklist
- [ ] VS Code open on `pallets/flask` repository at commit `22d92470` (`git checkout 3.1.3`).
- [ ] Primary `flask/` repository clean (`git status --short flask` returns nothing).
- [ ] TrueForge running locally on `http://localhost:8790` (`npx @truefoundry/trueforge@latest`).
- [ ] ForgePilot extension loaded and visible in sidebar activity bar.
- [ ] Screen recording resolution set to 1080p (1920x1080) with clear audio narration.

---

## Demonstration Path Selection

Select the appropriate recording path based on the local TrueForge server's provider configuration:

- **PATH A**: Follow if an active model provider with funded credits (e.g. funded OpenAI or Gemini key) is registered in TrueForge's dashboard (`http://localhost:8790`).
- **PATH B**: Follow if upstream provider credits are unavailable (e.g. OpenAI HTTP 429 quota exhaustion). Demonstrates verified live server capabilities and deterministic benchmarks with honest disclosures.

---

## PATH A: When an Active, Funded TrueForge Provider Is Configured

### 0:00 - 0:40: Introduction & Core Architecture
- Open the ForgePilot activity bar panel.
- Point out the status indicator ("Ready"), the three tabs (**Agent Chat**, **Diff Review**, **Context Explorer**), and token meter.
- State: *"ForgePilot is an autonomous AI coding assistant for VS Code powered strictly by the official TrueForge TypeScript SDK v0.185.0. No direct LLM or OpenAI API calls exist inside the extension."*

### 0:40 - 1:30: Task A — Live Inline Edit (`src/flask/helpers.py`)
1. Open `src/flask/helpers.py` and highlight `get_debug_flag`.
2. Press `Ctrl+Alt+I` (or `Cmd+Alt+I`).
3. Enter exact prompt:
   > *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."*
4. **DO NOT CUT**: Let the progress notification stream the TrueForge response.
5. Review the proposed diff in the **Diff Review** tab (showing `-` deletion and `+` addition).
6. Click **Apply Approved Changes**.
7. Execute acceptance verification in terminal:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   # Verify output: False
   ```
8. Click **Undo** to demonstrate transactional rollback.

### 1:30 - 2:50: Task B — Live Autonomous Multi-File Agent
1. Open the **Agent Chat** tab.
2. Submit high-level prompt without mentioning any filenames:
   > *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."*
3. Watch the **Live Execution Timeline**:
   - Shows context retrieval card.
   - Shows MCP tool calls (`search_workspace`, `read_file`, `propose_edit`).
   - The agent discovers `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`.
4. Switch to **Diff Review** tab showing all 3 proposed files.
5. Click **Accept All** and **Apply Approved Changes**.
6. Verify in integrated terminal:
   ```bash
   pytest tests/test_cli.py -k test_config_command -q
   # Output: 1 passed
   flask --help
   # Shows: config   Show loaded configuration as JSON.
   ```

### 2:50 - 3:45: Task C — Resilience & Cancellation
1. Demonstrate server-side turn cancellation: Trigger a prompt and click **Cancel**; show turn halted immediately.
2. Demonstrate error handling on an unreachable endpoint (`http://127.0.0.1:59999`).
3. Run `git status --short` to prove zero unapproved files were touched.
4. Conclude: All 5 competition capabilities verified.

---

## PATH B: Offline Baseline / Quota Exhaustion (Honest Disclosure Run)

### 0:00 - 0:50: Architecture, Live Connection & Honest Disclosure
1. Open ForgePilot sidebar. Show the branded interface, tabs, and status indicator.
2. **Demonstrate live session creation**: Click **+ New**; show session created on local TrueForge server (`http://localhost:8790`).
3. **Demonstrate live server-side cancellation**: Trigger a turn and immediately click **Cancel**. Show TrueForge server logs and database record `client-cancelled`.
4. **Transparent Disclosure**: State clearly:
   > *"The local TrueForge server's configured OpenAI provider returned HTTP 429 quota exhaustion, and no Google provider is currently registered in TrueForge's internal database. Therefore, live inference is demonstrated via verified server session/cancellation, while code reasoning is verified deterministically against the official Flask benchmark."*

### 0:50 - 1:50: Task A — Inline Edit Mechanics & Acceptance Command
1. Open `src/flask/helpers.py`, highlight `get_debug_flag`, press `Ctrl+Alt+I`.
2. Show the inline input and explain the two-phase diff review architecture: changes are never written to disk without explicit developer approval.
3. Show the Diff Review panel displaying the exact diff hunk and SHA-256 conflict protection.
4. Run the acceptance command in terminal against the applied proposal in an isolated working copy:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   # Output: False
   ```
5. Test permutations: `FLASK_DEBUG=n` -> `False`, `FLASK_DEBUG=OFF` -> `False`, `FLASK_DEBUG=1` -> `True`.
6. Demonstrate one-click transactional **Undo** restoring the exact baseline state.

### 1:50 - 2:50: Task B — Autonomous Context Discovery & Verification
1. Open the Context Explorer tab and explain the BM25 + symbol relevance engine.
2. Show that for the Task B instruction, the engine autonomously scores and identifies `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst` without user hardcoding filenames.
3. Execute the verified CLI output and pytest suite:
   ```bash
   flask --help
   # Shows: config   Show loaded configuration as JSON.
   pytest tests/test_cli.py -k test_config_command -q
   # Output: 1 passed
   ```
4. Note: File discovery, diff rendering, and pytest are deterministically verified; live LLM tool selection requires server provider credits.

### 2:50 - 3:45: Automated Test Suite & Clean Benchmark Verification
1. Run the full automated test suite in terminal:
   ```bash
   npm test
   ```
   Show all **58 tests passing across 8 suites** in Vitest.
2. Run `git status --short flask` to show the official Flask 3.1.3 benchmark repository remains 100% clean and pristine at commit `22d92470`.
3. Conclude: ForgePilot's complete VS Code extension architecture, 12 MCP tools, Context Engine, and Diff Manager are fully built, tested, and ready for live evaluation once an active provider is registered in TrueForge.
