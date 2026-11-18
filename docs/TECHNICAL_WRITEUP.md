# ForgePilot — Technical Write-Up

## 1. Team
- **Team Name / Participant**: [Insert Team Name / Participant Details Here]
- **Contact / GitHub**: [Insert GitHub Profile / Contact Information Here]
- **Event**: Techfest 2026–27 TrueFoundry Forge-a-thon

---

## 2. Starting Point
- **Genesis**: ForgePilot was built **entirely from scratch** specifically for this competition. No starter templates, boilerplate AI extensions, or forks of existing agent assistants were utilized.
- **Repository Baseline for Testing**: Official competition repository `https://github.com/pallets/flask` at release tag `3.1.3` (exact commit prefix `22d924701a6ae2e4cd01e9a15bbaf3946094af65`).
- **Development Environment**: Node.js v24.18.0, npm 12.2.3, TypeScript 5.7+, Python 3.13.2, Visual Studio Code 1.90+.

---

## 3. Architecture on TrueForge
ForgePilot strictly enforces the requirement that all agent reasoning, planning, and tool orchestration loops occur within TrueForge (`@truefoundry/trueforge`):

1. **Session & Turn Boundary Management**:
   - The VS Code client establishes durable sessions via `POST /api/v1/sessions`.
   - Each prompt interaction is dispatched as an isolated turn via `POST /api/v1/sessions/:id/turns`.
   - The extension consumes real-time SSE streams parsing typed event deltas (`text_delta`, `tool_call`, `tool_result`, `turn_complete`, `cancelled`, and `error`).
2. **MCP Editor Tool Registry**:
   - 12 editor-native tools are formally registered via the Model Context Protocol (MCP) using `@modelcontextprotocol/sdk`.
   - The TrueForge agent autonomously decides when to query the workspace, extract symbols, read files, and propose modifications.
3. **Safe Diff Review Subsystem**:
   - The agent's `propose_edit` tool never touches disk directly. It generates structured diff hunks with SHA-256 baseline hashing.
   - Developers inspect individual hunks in the custom webview sidebar, accepting or rejecting modifications before an atomic transaction applies accepted changes.
4. **Resilience & Circuit Breaker**:
   - Wrap turns with `ResilienceManager` handling transient connection drops with exponential backoff and automatically switching to secondary fallback models upon provider quota exhaustion or errors.

---

## 4. How Context Is Selected
To prevent token bloat and context window saturation, ForgePilot implements a multi-stage context retrieval pipeline:

1. **Query Parsing & Mention Extraction**:
   - Extracts explicit `@file:<path>` and `@symbol:<name>` directives from developer input.
   - Tokenizes natural language queries to extract keywords, test intent flags, and documentation intent flags.
2. **Workspace Scanning & Lexical Filtering**:
   - Scans the repository respecting standard ignore patterns (`.git`, `node_modules`, `dist`, `__pycache__`).
   - Prioritizes core source directories (`src/`, `lib/`) over documentation trees.
3. **Multi-Language Symbol Extraction**:
   - The `SymbolIndex` parses function, method, class, and interface declarations across Python, TypeScript, JavaScript, and related files.
4. **Relevance Scoring**:
   - Files are ranked based on explicit mention (+150), filename matching (+80), symbol matching (+30/match), keyword density (+5/match), intent alignment (+40 for tests/docs), and directory depth penalty.
5. **Token Budget Enforcement**:
   - Evaluates token load against a configurable budget (default: 20,000 tokens).
   - Higher-ranked files are allocated full content; remaining lower-priority files receive clean summary truncations.

---

## 5. Model Setup
All model execution is managed through TrueForge configuration (`agents/forgepilot-agent.yaml` and `examples/model-config.example.yaml`):

- **Primary Model**: `gemini-2.5-pro` (configured in TrueForge for complex reasoning, multi-file code synthesis, and diff planning).
- **Secondary Fallback Model**: `gemini-2.5-flash` (configured in TrueForge for high-speed resilience and automatic failover).
- **Tool Protocol**: Model Context Protocol (MCP) with deferred tool schema loading to preserve prompt context.
- **Approximate Costs**:
  - Task A (Inline Edit): ~1,200 tokens (< \$0.003)
  - Task B (Autonomous Multi-File Edit): ~8,500 tokens (< \$0.015)
  - Task C (Resilience): \$0.00 (Network failure handled cleanly prior to provider token billing)

---

## 6. Scorecard

| Category / Requirement | Target Specification | Actual Measured Result | Status |
|---|---|---|---|
| **TypeScript Compilation** | Zero errors with strict flags | `tsc -p ./` clean exit code 0 | **PASS** |
| **Linting & Type Safety** | Zero warnings/errors | `tsc --noEmit` clean exit code 0 | **PASS** |
| **Unit Test Coverage** | Diff, MCP, Context, TrueForge | 19 / 19 tests passing in Vitest | **PASS** |
| **Task A: Inline Edit** | `FLASK_DEBUG=off` returns `False` | Tested: `off`, `OFF`, `n`, `N` all return `False` | **PASS** |
| **Task B: Multi-File Discovery** | Auto-discover 3+ files for `flask config` | Discovered `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` | **PASS** |
| **Task B: Masking** | Mask SECRET, PASSWORD, TOKEN, KEY as `***` | Verified via pytest in `tests/test_cli.py` | **PASS** |
| **Task B: Test Execution** | `pytest tests/test_cli.py -k test_config_command` | Exit code 0 (1 passed) | **PASS** |
| **Task B: CLI Help** | `flask --help` displays `config` | Verified `config` listed with short help | **PASS** |
| **Task C: Resilience** | Unreachable endpoint / invalid key | Zero files modified on disk, clean git status | **PASS** |

---

## 7. Tools Used
- **Agent Harness**: TrueForge (`@truefoundry/trueforge`, `@truefoundry/trueforge-sdk`)
- **Protocol**: Model Context Protocol (`@modelcontextprotocol/sdk`)
- **Editor Integration**: VS Code Extension API (`@types/vscode`), Webview API
- **Diff & Patch Generation**: `diff` (`structuredPatch`, unified diff hunks)
- **Hashing**: Node.js `crypto` (SHA-256)
- **Testing**: Vitest 3.2.7, Python pytest 8.1.1, Python 3.13.2
- **Language / Build Tools**: TypeScript 5.7+, esbuild

---

## 8. Known Limitations and What We Would Do With Another Month

### Current Known Limitations:
1. **Symbol Extraction Scope**: Python, TypeScript, and JavaScript use regex-based AST lexical matchers; deeper cross-file reference graphing for languages like C, Rust, or Go is basic.
2. **Three-Way Merge UI**: When an external file modification conflicts with an active proposal, ForgePilot marks the proposal as stale and requests a fresh turn rather than displaying a visual 3-way in-line merge conflict resolver.
3. **Approval Gate Granularity**: Terminal command executions require individual user approvals.

### With Another Month We Would Implement:
1. **Tree-Sitter WASM Integration**: Universal, robust incremental AST parsing across 40+ languages directly inside the VS Code extension host.
2. **TrueForge Multi-Agent Swarms**: Distribute large multi-repository refactoring tasks across coordinated TrueForge subagents (e.g., Planner Agent, Implementation Agent, Test Verifier Agent, Doc Writer Agent).
3. **Interactive 3-Way Inline Merge Editor**: Visual conflict resolution directly within the VS Code Diff Editor when simultaneous external edits occur.
4. **Local Embedding Indexing**: SQLite-vec backed embeddings for semantic retrieval across million-line repositories.

