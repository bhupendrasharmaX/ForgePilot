# ForgePilot — Technical Write-Up & Competition Submission

## 1. Team
- **Team Name / Participant**: Techworms Team (Bhupendra Sharma - @bhupendrasharmaX)
- **Project**: ForgePilot — Autonomous AI Coding Assistant for Visual Studio Code
- **Harness Platform**: TrueForge Runtime (`@truefoundry/trueforge-sdk` v0.185.0)
- **Event**: Techfest 2026–27 TrueFoundry Forge-a-thon (Round 1)
- **Submission Date**: 20 November 2026

---

## 2. Starting Point
- **Genesis**: ForgePilot was engineered **from scratch** specifically for the Techfest Forge-a-thon. No preexisting AI coding assistant extensions (such as Cline, Continue, Aider, or Cursor forks) were copied or adapted.
- **Strict Compliance**: The agent orchestration, planning, and tool reasoning loop is exclusively driven by TrueForge. The VS Code extension acts as an editor interface, providing rich context retrieval, MCP tool execution, and safe diff management.
- **Repository Baseline for Testing**: Official competition repository `https://github.com/pallets/flask` at release tag `3.1.3` (exact commit prefix `22d924701a6ae2e4cd01e9a15bbaf3946094af65`).
- **Environment**: Node.js v24.18.0, npm 12.2.3, TypeScript 5.7+, Python 3.13.2, VS Code 1.90+, Vitest 3.2.7.

---

## 3. Architecture on TrueForge
All inference, turn planning, model generation, and tool invocations run strictly on TrueForge:

1. **Official TrueForge SDK Integration (`@truefoundry/trueforge-sdk` v0.185.0)**:
   - **Session Lifecycle**: Established via `client.sessions.create({ agent: { name: 'forgepilot-agent' }, metadata: { ... } })`.
   - **Turn Streaming**: Executed via `client.sessions.createTurnStream(sessionId, turnPayload)`.
   - **Event Protocol**: Real-time asynchronous streaming processing `turn.created`, `model.message`, `model.message.delta`, `tool.approval_required`, `tool.response_required`, and `turn.done`.
   - **Tool Responses**: Dispatched back to TrueForge turns via `client.sessions.createTurnEvents(sessionId, turnId, { events })` using typed `user.tool_response` envelopes.
   - **Server-Side Cancellation**: Cancelled via `client.sessions.cancel(sessionId)` paired with local `AbortController` cancellation.
2. **MCP Editor Tool Handler**:
   - Registered 12 native tools (`search_workspace`, `list_files`, `read_file`, `get_symbols`, `get_references`, `get_workspace_context`, `propose_edit`, `run_tests`, `run_terminal_command`, `git_status`, `git_diff`, `undo_last_change`).
   - TrueForge autonomously selects and invokes tools; tool results are fed back to TrueForge to continue multi-step reasoning within the same turn.
3. **Safe Two-Phase Diff Review**:
   - The agent never writes directly to disk during generation.
   - `propose_edit` computes structured unified diff hunks with SHA-256 baseline hashing.
   - Developers inspect hunks in the unified webview panel, accepting or rejecting individual hunks or entire proposals before changes are applied.
   - Stale proposal protection: Compares on-disk file hash with original proposal hash before writing, preventing stale overwrite conflicts.
   - Complete undo history enabled via `UndoManager`.
4. **Resilience & Fault Tolerance**:
   - `ResilienceManager` wraps turn execution with exponential backoff on transient network faults and seamless model failover (e.g. `gemini-2.5-pro` to `gemini-2.5-flash`).

---

## 4. How Context Is Selected
To maximize model reasoning quality while strictly staying within the token budget (default: 20,000 tokens), ForgePilot utilizes a multi-stage context retrieval engine:

1. **Mention Extraction**:
   - Scans user prompts for explicit `@file:<path>`, `@path/to/file`, and `@symbol:<name>` directives.
2. **Multi-Language Symbol Indexing**:
   - Extracts function definitions, classes, methods, and Click/Flask CLI command decorators across Python, TypeScript, and JavaScript.
3. **Relevance Scoring Algorithm**:
   - Explicit mention: `+150`
   - Exact filename match: `+80`
   - Keyword / term overlap: `+5` per occurrence
   - Symbol match: `+30`
   - Intent alignment (e.g. test files for test tasks, doc files for doc tasks): `+40`
   - Directory depth penalty: `-2` per level to favor root/core modules.
4. **Token Budget Enforcement (`TokenBudgetManager`)**:
   - Approximates token usage (~3.8 chars/token).
   - Higher-ranked files are allocated complete text; lower-priority files are safely compacted or truncated with notice headers.
   - Preserves candidate relevance ranking throughout budget allocation.

---

## 5. Model Setup

All model execution is managed through TrueForge configuration, strictly decoupled from the extension client:

- **Extension Configuration Defaults**: In `package.json` and `agents/forgepilot-agent.yaml`, `forgepilot.primaryModel` (`gemini-2.5-pro`) and `forgepilot.fallbackModel` (`gemini-2.5-flash`) specify client-side preference metadata.
- **Actual TrueForge Server Database Configuration**: The local TrueForge server's internal database (`%LOCALAPPDATA%\trueforge\Data\db\db.sqlite`) has a single configured provider record of type `openai` (`base_url: https://api.openai.com/v1`). No Google or Gemini provider is registered in TrueForge's internal `model_provider` table.
- **Registered Agent & Model**: The registered agent `forgepilot-agent` (`id: 01m7qzsxw4g7a5zywb80eryje9`) is assigned model `openai/chat-latest`.
- **Live Provider Status**: Live model inference attempts against the server resulted in HTTP 429 (`insufficient_quota`) from the configured OpenAI account.
- **Fallback Verification Status**: Client-side resilience and fallback switching logic are **AUTOMATED TEST VERIFIED** in Vitest (`test/trueforge.test.ts`), confirming the extension client detects quota exhaustion and attempts failover without crashing. However, live failover between two live providers on the server is **NOT VERIFIED LIVE** because no second funded provider exists in the inspected TrueForge database.
- **Client Discipline**: ForgePilot contains zero direct model API calls; all inference requests route exclusively through TrueForge's `client.sessions.createTurnStream`.

---

## 6. Scorecard: Five Mandatory Capabilities

Evidence categories enforced across all evaluations:
- **`LIVE VERIFIED`**: Validated against running TrueForge daemon with database proof.
- **`AUTOMATED TEST VERIFIED`**: Validated through mock-streamed SDK integration tests.
- **`DETERMINISTIC VERIFIED`**: Validated through Python process and file inspection on Flask 3.1.3 benchmark.
- **`NOT VERIFIED LIVE`**: Blocked by upstream provider quota exhaustion.

| # | Mandatory Capability | Target Specification | Actual Measured Result | Status |
|---|---|---|---|:---:|
| 1 | **Inline Editing** | `forgepilot.inlineEdit` command (`Ctrl+Alt+I`), multiline selection, language & line context, stale document detection, per-hunk review, undo | Verified in unit and component tests (`test/inlineEdit.test.ts`). Handles multiline selection, empty selection auto-expansion, stale document rejection, and byte-for-byte undo. | **AUTOMATED TEST VERIFIED** |
| 2 | **Autonomous Multi-File Agent Mode** | High-level request without filenames, autonomous discovery of 3+ files, multi-step MCP tool calls, turn continuation, proposed changes across files | Discovers `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst` for Task B. Sequences tool calls and registers diff proposals without modifying disk. | **AUTOMATED TEST VERIFIED (Discovery & Diffs)**<br>**NOT VERIFIED LIVE (Model Inference)** |
| 3 | **Context Assembly** | Parse `@file`, `@symbol`, automated lexical & symbol retrieval, ranking engine, token budget enforcement | Extracts explicit mentions, indexes symbols/commands, ranks candidates, and respects 20,000 token budget with compaction (`test/contextEngine.test.ts`). | **AUTOMATED TEST VERIFIED** |
| 4 | **Diff Review** | Per-hunk accept/reject, Accept All, Reject All, Apply Approved Changes, stale file warnings, full Undo | Unified webview review container shared between Autonomous and Inline modes. Hunks render line-by-line (`+` green, `-` red), prevents stale apply, and supports one-click rollback (`test/diffManager.test.ts`). | **AUTOMATED TEST VERIFIED** |
| 5 | **Streaming and Cancellation** | Real-time `text_delta` streaming, timeline events, responsive UI, server-side cancellation via `client.sessions.cancel` | Session creation and server-side cancellation confirmed in TrueForge `db.sqlite` (`status: cancelled, reason: client-cancelled`). Event streaming verified via SDK turn streams. | **LIVE VERIFIED (Session & Cancellation)**<br>**AUTOMATED TEST VERIFIED (Event Stream)** |

### Acceptance Tasks Scorecard

| Acceptance Task | Procedure & Command | Expected Output | Actual Output | Status |
|---|---|---|---|:---:|
| **Task A (Inline Edit)** | `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` | `False` | `False` (also verified `'n'`, `'OFF'`, `'N'` -> `False`; `'1'`, `'true'` -> `True`) | **DETERMINISTIC VERIFIED** |
| **Task B (Autonomous Multi-File)** | `pytest tests/test_cli.py -k test_config_command -q` | `1 passed` | `1 passed, 58 deselected in 0.37s` | **DETERMINISTIC VERIFIED (Discovery & Pytest)**<br>**NOT VERIFIED LIVE (Model Inference)** |
| **Task B (CLI Help)** | `flask --help` | Includes `config` with help text | `config  Show loaded configuration as JSON.` present in `flask --help` | **DETERMINISTIC VERIFIED** |
| **Task C (Resilience)** | Unreachable endpoint / invalid key configuration | Readable error, no crash, 0 files modified | Retry with exponential backoff, clear error in chat timeline, and workspace remains 100% clean (Anchor 7). Automated unit test suite verifies dual-model failover. | **AUTOMATED TEST & LIVE VERIFIED** |

---

## 7. Tools Used
- **Agent Harness Runtime**: TrueForge (`@truefoundry/trueforge-sdk` v0.185.0)
- **Tool Protocol**: Model Context Protocol (`@modelcontextprotocol/sdk` v1.6.1)
- **IDE Platform**: Visual Studio Code Extension API (`@types/vscode` v1.90.0)
- **Diff & Patch Computation**: `diff` v7.0.0 (`structuredPatch`, line delta computation)
- **Hashing & Integrity**: Node.js `crypto` (SHA-256)
- **Test Framework**: Vitest v3.2.7 (58 tests across 8 test suites)
- **Python Toolchain**: Python 3.13.2, pytest 8.1.1, Click 8.1.8

---

## 8. Known Limitations and What We Would Do With Another Month

### Current Known Limitations:
1. **Upstream Provider Quota**: Live model reasoning requires active upstream credits on the TrueForge server's configured provider. When the provider returns HTTP 429, turns halt safely via `ResilienceManager`.
2. **Three-Way Merge Conflict Resolution**: When an external file edit conflicts with a pending proposal, ForgePilot marks the proposal as stale and aborts writing to prevent clobbering. In the future, a visual 3-way in-editor diff resolver would allow manual resolution.
3. **Symbol Indexing Depth**: The current symbol engine uses lexical regex parsing for Python, TypeScript, and JavaScript. Deeper cross-file AST call graphs for compiled languages (C, Rust, Go) would benefit from tree-sitter or Language Server Protocol (LSP) indexing.

### With Another Month of Development:
1. **Direct LSP Semantic Integration**: Query VS Code's active Language Server Protocol instances (`vscode.executeWorkspaceSymbolProvider`, `vscode.executeDefinitionProvider`) to feed exact type definitions and references into TrueForge context.
2. **Interactive Hunk Editing**: Allow developers to manually edit proposed lines directly inside the webview diff editor before clicking "Apply".
3. **Terminal Auto-Healing Loop**: Automatically feed failing test and compiler output back into TrueForge in a closed loop until tests pass.

---

## 9. Four-Minute Demonstration Script

To ensure strict adherence to honesty, two demonstration paths are defined:

---

### PATH A: When an Active, Funded TrueForge Provider Is Configured
*(Use when TrueForge is started with valid OpenAI or Gemini API credits).*

- **Act 1: System Overview & Architecture (0:00 – 0:40)**:
  - Tour sidebar webview, Activity Bar icon, connection status badge ("Ready").
  - Emphasize TrueForge TypeScript SDK v0.185.0: zero direct model API calls inside VS Code.
- **Act 2: Live Task A — Selection & Inline Diff (0:40 – 1:30)**:
  - Highlight `get_debug_flag` in `src/flask/helpers.py`. Press `Ctrl+Alt+I`.
  - Enter prompt: *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."*
  - **No video cuts**: Watch live token stream in notification, review proposed hunk in Diff Review tab, click **Apply Approved Changes**.
  - Run `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` $\rightarrow$ `False`.
  - Click **Undo** to restore original state.
- **Act 3: Live Task B — Autonomous Discovery & Changes (1:30 – 2:50)**:
  - Submit high-level prompt in Agent Chat without naming files.
  - Watch TrueForge drive the loop: context retrieval, MCP tool execution (`search_workspace`, `read_file`), proposed changes across `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`.
  - Review all 3 file proposals in Diff Review tab. Click **Accept All** and **Apply**.
  - Run `pytest tests/test_cli.py -k test_config_command -q` (1 passed) and `flask --help`.
- **Act 4: Task C & Cancellation (2:50 – 3:45)**:
  - Trigger a long prompt and immediately click **Cancel**. Show server-side cancellation.
  - Verify workspace cleanliness with `git status --short`. Show 58/58 passing Vitest tests.

---

### PATH B: Offline Baseline / Provider Quota Exhaustion
*(Use when the evaluator's local server has uncredited API keys or upstream HTTP 429).*

- **Act 1: Architecture & Live Capabilities (0:00 – 0:50)**:
  - Tour sidebar interface, registered tools, and TrueForge SDK integration.
  - **Show live server connection and session creation**: Show active session created on `http://localhost:8790`.
  - **Demonstrate verified live server cancellation**: Trigger a turn and cancel it; show the server logs and database recording `client-cancelled`.
  - **Transparently disclose**: The configured OpenAI model provider returned HTTP 429 (`insufficient_quota`). No Google provider is registered in TrueForge's internal SQLite database.
- **Act 2: Task A Inline Edit & Diff Mechanics (0:50 – 1:50)**:
  - Show the selection capture on `get_debug_flag` in `src/flask/helpers.py` via `Ctrl+Alt+I`.
  - Show the Diff Review interface, hunk rendering (`+` green, `-` red), and stale-file conflict safety.
  - Run the deterministic Python acceptance command against an isolated working copy:
    ```bash
    FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
    # Output: False (also test 'n', 'OFF', 'N' -> False; '1', 'true' -> True)
    ```
  - Demonstrate one-click transactional Undo restoring the exact original SHA-256 hash.
- **Act 3: Task B Autonomous Multi-File Verification (1:50 – 2:50)**:
  - Demonstrate the autonomous context retrieval engine: scores and discovers `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst` without user hardcoding filenames.
  - Execute the verified CLI and pytest suite on the applied changes:
    ```bash
    pytest tests/test_cli.py -k test_config_command -q
    # Output: 1 passed
    flask --help
    # Output includes: config   Show loaded configuration as JSON.
    ```
  - State clearly: File discovery and diff mechanics are verified; live LLM tool selection requires funded server credits.
- **Act 4: Automated Test Suite & Workspace Protection (2:50 – 3:45)**:
  - Run the full Vitest suite in terminal: `npm test` $\rightarrow$ **58 passed (58 total across 8 test suites)**.
  - Show `git status --short flask`: primary Flask benchmark repository is 100% clean and pristine at commit `22d92470`.
  - Conclude with architecture readiness for live competition evaluation once an active provider is registered.

---

## 10. Screenshot & Video Capture Checklist

- [ ] **Screenshot 1: Activity Bar & Header**: Sidebar opened showing ForgePilot logo, session status badge, and mode selector.
- [ ] **Screenshot 2: Inline Edit Prompt**: In-editor input box open above `get_debug_flag` in `helpers.py`.
- [ ] **Screenshot 3: Unified Diff Review**: Diff tab displaying proposal card with line stats (`+12 -3`) and green/red line diffs.
- [ ] **Screenshot 4: Context Explorer**: Tab showing token progress bar (`14,250 / 20,000 tokens`), model info, and file relevance table.
- [ ] **Screenshot 5: Live Timeline in Chat**: Chat history displaying MCP tool call cards (`search_workspace`, `read_file`, `propose_edit`).
- [ ] **Screenshot 6: Test Suite Passing**: Terminal output showing 58 passing Vitest tests across 8 suites.
- [ ] **Video Demonstration (Max 4 minutes)**: Recorded following either Path A (Funded Provider) or Path B (Verified Baseline with Honest Disclosure). Must not cut between prompt and diff appearance in live mode.
