import * as fs from 'fs';
import * as path from 'path';
import { ProposedEdit, UndoRecord } from './types';
import { computeSha256 } from '../utils/hash';
import { reconstructContent } from './hunkReview';
import { UndoManager } from './undoManager';

export interface ApplyResult {
  success: boolean;
  appliedCount: number;
  staleFiles: string[];
  appliedFiles: string[];
  errors: string[];
}

/**
 * Safely applies accepted changes from proposed edits to disk.
 * Strictly verifies file hashes to avoid overwriting stale files.
 */
export async function applyProposedEdits(
  proposals: ProposedEdit[],
  undoManager: UndoManager,
  description: string = 'Apply proposed edits'
): Promise<ApplyResult> {
  const result: ApplyResult = {
    success: true,
    appliedCount: 0,
    staleFiles: [],
    appliedFiles: [],
    errors: []
  };

  const pendingWrites: {
    proposal: ProposedEdit;
    beforeContent: string;
    newContent: string;
  }[] = [];

  // Step 1: Pre-validation of all proposals (verify hash consistency)
  for (const proposal of proposals) {
    if (proposal.status === 'rejected' || proposal.status === 'applied') {
      continue;
    }

    const hasAcceptedHunks = proposal.hunks.some((h) => h.status === 'accepted');
    if (!hasAcceptedHunks && proposal.hunks.length > 0) {
      // Nothing accepted in this proposal
      continue;
    }

    if (fs.existsSync(proposal.absolutePath)) {
      const diskContent = fs.readFileSync(proposal.absolutePath, 'utf8');
      const diskHash = computeSha256(diskContent);

      if (diskHash !== proposal.originalSha256) {
        proposal.status = 'stale';
        result.staleFiles.push(proposal.filePath);
        result.errors.push(
          `File "${proposal.filePath}" has been modified on disk since the proposal was created. Proposal is stale.`
        );
        result.success = false;
        continue;
      }

      const newContent = reconstructContent(proposal.originalContent, proposal.hunks, 'accepted_only');
      pendingWrites.push({
        proposal,
        beforeContent: diskContent,
        newContent
      });
    } else {
      // New file creation
      if (proposal.originalSha256 !== computeSha256('')) {
        proposal.status = 'stale';
        result.staleFiles.push(proposal.filePath);
        result.errors.push(`File "${proposal.filePath}" does not exist on disk.`);
        result.success = false;
        continue;
      }

      const newContent = reconstructContent('', proposal.hunks, 'accepted_only');
      pendingWrites.push({
        proposal,
        beforeContent: '',
        newContent: newContent || proposal.proposedContent
      });
    }
  }

  // If any file was stale, abort entire transaction to protect workspace integrity
  if (result.staleFiles.length > 0) {
    result.success = false;
    return result;
  }

  // Step 2: Atomic writes and undo recording
  const undoFiles: UndoRecord['files'] = [];

  for (const item of pendingWrites) {
    try {
      const dir = path.dirname(item.proposal.absolutePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(item.proposal.absolutePath, item.newContent, 'utf8');
      item.proposal.status = 'applied';

      undoFiles.push({
        filePath: item.proposal.filePath,
        absolutePath: item.proposal.absolutePath,
        beforeContent: item.beforeContent,
        appliedContent: item.newContent
      });

      result.appliedFiles.push(item.proposal.filePath);
      result.appliedCount++;
    } catch (err: any) {
      result.errors.push(`Failed writing "${item.proposal.filePath}": ${err.message}`);
      result.success = false;
    }
  }

  if (undoFiles.length > 0) {
    undoManager.recordTransaction({
      id: `tx-${Date.now()}`,
      timestamp: Date.now(),
      description,
      files: undoFiles
    });
  }

  return result;
}

