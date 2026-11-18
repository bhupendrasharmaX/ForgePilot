import { structuredPatch } from 'diff';
import { DiffHunk } from './types';

/**
 * Computes individual diff hunks from original and proposed content.
 */
export function computeHunks(
  filePath: string,
  originalContent: string,
  proposedContent: string
): DiffHunk[] {
  // If contents are identical, no hunks
  if (originalContent === proposedContent) {
    return [];
  }

  const patch = structuredPatch(
    filePath,
    filePath,
    originalContent,
    proposedContent,
    '',
    '',
    { context: 3 }
  );

  return patch.hunks.map((hunk, index) => {
    return {
      id: `hunk-${index + 1}`,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines,
      status: 'pending'
    };
  });
}

/**
 * Reconstructs target content from original content applying only accepted hunks.
 * If a hunk is rejected or still pending, original code is kept.
 */
export function reconstructContent(
  originalContent: string,
  hunks: DiffHunk[],
  applyMode: 'accepted_only' | 'all_non_rejected' = 'accepted_only'
): string {
  if (hunks.length === 0) {
    return originalContent;
  }

  const originalLines = originalContent.split(/\r?\n/);
  // Sort hunks by oldStart ascending
  const sortedHunks = [...hunks].sort((a, b) => a.oldStart - b.oldStart);

  const resultLines: string[] = [];
  let originalIndex = 1; // 1-based line index into originalLines

  for (const hunk of sortedHunks) {
    const shouldApply =
      applyMode === 'accepted_only'
        ? hunk.status === 'accepted'
        : hunk.status !== 'rejected';

    // Copy original lines prior to this hunk
    while (originalIndex < hunk.oldStart) {
      if (originalIndex <= originalLines.length) {
        resultLines.push(originalLines[originalIndex - 1]);
      }
      originalIndex++;
    }

    if (shouldApply) {
      // Apply hunk lines
      for (const line of hunk.lines) {
        const prefix = line[0];
        const text = line.slice(1);
        if (prefix === '+' || prefix === ' ') {
          resultLines.push(text);
        }
        if (prefix === '-' || prefix === ' ') {
          originalIndex++;
        }
      }
    } else {
      // Keep original lines covered by this hunk
      const oldEnd = hunk.oldStart + hunk.oldLines;
      while (originalIndex < oldEnd && originalIndex <= originalLines.length) {
        resultLines.push(originalLines[originalIndex - 1]);
        originalIndex++;
      }
    }
  }

  // Copy remaining lines after last hunk
  while (originalIndex <= originalLines.length) {
    resultLines.push(originalLines[originalIndex - 1]);
    originalIndex++;
  }

  // Preserve original line ending if possible
  const hasCrLf = originalContent.includes('\r\n');
  return resultLines.join(hasCrLf ? '\r\n' : '\n');
}
