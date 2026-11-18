# ForgePilot — Demo Video Recording Checklist

> **Format**: Video demonstration (Maximum 4 minutes)  
> **Rule**: Do not cut between giving an instruction and the resulting diff appearing.

---

## Pre-Recording Checklist
- [ ] VS Code open on `pallets/flask` repository at commit `22d92470` (`git checkout 3.1.3`).
- [ ] Git status clean (`git status --short` returns nothing).
- [ ] TrueForge running locally on `http://localhost:8790`.
- [ ] ForgePilot extension loaded and visible in sidebar.
- [ ] Screen recording resolution set to 1080p (1920x1080) with clear audio.

---

## Video Timeline & Script (Total: 3 min 45 sec)

### 0:00 - 0:25: Introduction & Core Philosophy
- Show the ForgePilot activity bar icon and open the dark-themed sidebar.
- State: *"ForgePilot is an autonomous AI coding assistant for VS Code built entirely on TrueForge. Core philosophy: 'Your repository. Your context. Your control.' Zero direct model calls from the extension—everything executes through TrueForge."*

---

### 0:25 - 1:25: Task A — Inline Edit (helpers.py get_debug_flag)
- **Action**:
  1. Open `src/flask/helpers.py`.
  2. Highlight the `get_debug_flag` function.
  3. Press `Ctrl+Alt+I` (or `Cmd+Alt+I`) to open the ForgePilot Inline Edit input.
  4. Paste exact instruction:
     > *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."*
  5. **DO NOT CUT**: Let the progress notification stream the TrueForge response.
  6. Point out the Diff Review card showing the hunk:
     - Lines removed: `-val and val.lower() not in {"0", "false", "no"}`
     - Lines added: `+val and val.lower() not in {"0", "false", "no", "off", "n"}`
     - Docstring additions.
  7. Click **Accept Hunk** and **Apply Accepted**.
  8. Run verification in the integrated terminal:
     ```bash
     FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
     # Verify output: False
     FLASK_DEBUG=n python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
     # Verify output: False
     FLASK_DEBUG=OFF python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
     # Verify output: False
     ```

---

### 1:25 - 2:50: Task B — Autonomous Multi-File Agent (flask config CLI)
- **Action**:
  1. Click **+ New** in ForgePilot header to start a clean session.
  2. Paste exact autonomous prompt in chat:
     > *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."*
  3. Point out: *Notice we do NOT name any files in the prompt!*
  4. Show TrueForge streaming:
     - Live context retrieval cards.
     - MCP tool execution cards: `search_workspace`, `list_files`, `get_symbols`.
     - The agent discovers `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`.
  5. Show the Diff Review panel displaying proposed diffs across all 3 files.
  6. Click **Accept All** and **Apply Accepted**.
  7. Point out approval gate: terminal test execution request prompted to developer.
  8. Verify in integrated terminal:
     ```bash
     pytest tests/test_cli.py -k test_config_command -q
     # Output: 1 passed
     flask --help
     # Show config command listed in help output
     ```

---

### 2:50 - 3:35: Task C — Resilience & Safe Failure Handling
- **Action**:
  1. Open ForgePilot Settings and modify endpoint to an unreachable address: `http://127.0.0.1:59999`.
  2. Re-trigger an edit request.
  3. Show:
     - VS Code editor remains completely responsive.
     - Resilience manager shows retry attempt notification and failover status.
     - Safe error message displayed in sidebar.
  4. Run in terminal:
     ```bash
     git status --short
     ```
  5. Show clean status: zero unapproved or corrupt files touched on disk!

---

### 3:35 - 3:45: Conclusion
- Summarize: *"ForgePilot proves that with TrueForge, context engineering, MCP tools, and safe transactional diff reviews, autonomous coding in VS Code is reliable, safe, and entirely in developer control."*

