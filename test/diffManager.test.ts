import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DiffManager } from '../src/diff/diffManager';
import { computeHunks, reconstructContent } from '../src/diff/hunkReview';

describe('DiffManager & Hunk Review', () => {
  let tmpDir: string;
  let diffManager: DiffManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgepilot-test-'));
    diffManager = new DiffManager(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('computes hunks accurately between original and proposed content', () => {
    const original = 'line 1\nline 2\nline 3\n';
    const proposed = 'line 1\nline 2 modified\nline 3\n';
    const hunks = computeHunks('test.txt', original, proposed);

    expect(hunks.length).toBe(1);
    expect(hunks[0].lines).toContain('+line 2 modified');
    expect(hunks[0].lines).toContain('-line 2');
  });

  it('reconstructs content applying only accepted hunks', () => {
    const original = 'def foo():\n    return 1\n\ndef bar():\n    return 2\n';
    const proposed = 'def foo():\n    return 100\n\ndef bar():\n    return 200\n';

    const hunks = computeHunks('math.py', original, proposed);
    expect(hunks.length).toBeGreaterThan(0);

    // Accept only first hunk
    hunks[0].status = 'accepted';
    if (hunks.length > 1) {
      hunks[1].status = 'rejected';
    }

    const reconstructed = reconstructContent(original, hunks, 'accepted_only');
    expect(reconstructed).toContain('return 100');
    // If second was separate hunk, it should still be 2 or rejected
  });

  it('safely applies accepted edits and provides transactional undo', async () => {
    const testFile = path.join(tmpDir, 'sample.py');
    const originalContent = 'print("hello")\n';
    fs.writeFileSync(testFile, originalContent, 'utf8');

    const proposedContent = 'print("hello world")\n';
    const proposal = diffManager.createProposal('sample.py', proposedContent);

    expect(proposal.status).toBe('pending');
    expect(proposal.hunks.length).toBe(1);

    // Accept hunk
    diffManager.acceptHunk(proposal.id, proposal.hunks[0].id);
    expect(proposal.status).toBe('accepted');

    // Apply
    const applyResult = await diffManager.applyAccepted(proposal.id);
    expect(applyResult.success).toBe(true);
    expect(applyResult.appliedCount).toBe(1);

    // Verify on disk
    const onDisk = fs.readFileSync(testFile, 'utf8');
    expect(onDisk).toBe(proposedContent);

    // Undo
    expect(diffManager.canUndo()).toBe(true);
    const undoResult = await diffManager.undo();
    expect(undoResult.success).toBe(true);

    // Verify restored original content
    const restoredDisk = fs.readFileSync(testFile, 'utf8');
    expect(restoredDisk).toBe(originalContent);
  });

  it('detects stale proposals when file has modified on disk', async () => {
    const testFile = path.join(tmpDir, 'stale_check.txt');
    fs.writeFileSync(testFile, 'initial state\n', 'utf8');

    const proposal = diffManager.createProposal('stale_check.txt', 'proposed state\n');
    diffManager.acceptAll(proposal.id);

    // Simulate an external edit on disk
    fs.writeFileSync(testFile, 'interfering external edit\n', 'utf8');

    // Attempt to apply
    const result = await diffManager.applyAccepted(proposal.id);
    expect(result.success).toBe(false);
    expect(result.staleFiles).toContain('stale_check.txt');
    expect(proposal.status).toBe('stale');
  });
});
