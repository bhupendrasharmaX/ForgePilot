export type HunkStatus = 'pending' | 'accepted' | 'rejected';

export interface DiffHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // prefixed with '+', '-', or ' '
  status: HunkStatus;
}

export type ProposalStatus = 'pending' | 'partially_accepted' | 'accepted' | 'rejected' | 'applied' | 'stale';

export interface ProposedEdit {
  id: string;
  filePath: string; // Relative to workspace
  absolutePath: string;
  originalSha256: string;
  originalContent: string;
  proposedContent: string;
  hunks: DiffHunk[];
  status: ProposalStatus;
  createdAt: number;
  sessionId?: string;
  summary?: string;
}

export interface UndoRecord {
  id: string;
  timestamp: number;
  description: string;
  files: {
    filePath: string;
    absolutePath: string;
    beforeContent: string;
    appliedContent: string;
  }[];
}

