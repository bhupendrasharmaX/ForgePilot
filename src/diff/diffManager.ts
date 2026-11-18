import * as fs from 'fs';
import { ProposedEdit, DiffHunk } from './types';
import { computeSha256 } from '../utils/hash';
import { computeHunks } from './hunkReview';
import { UndoManager } from './undoManager';
import { applyProposedEdits, ApplyResult } from './applyChanges';
import { resolveSafePath, toWorkspaceRelative } from '../utils/pathValidation';

export class DiffManager {
  private proposals: Map<string, ProposedEdit> = new Map();
  private undoManager: UndoManager = new UndoManager();
  private workspaceRoot: string;
  private changeListeners: Array<(proposals: ProposedEdit[]) => void> = [];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  public setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  public onDidChangeProposals(listener: (proposals: ProposedEdit[]) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  private notifyChange(): void {
    const list = this.listProposals();
    for (const listener of this.changeListeners) {
      listener(list);
    }
  }

  /**
   * Registers a proposed edit for a file without writing to disk.
   */
  public createProposal(
    relativePathOrAbsolute: string,
    proposedContent: string,
    sessionId?: string,
    summary?: string
  ): ProposedEdit {
    const absolutePath = resolveSafePath(this.workspaceRoot, relativePathOrAbsolute);
    const filePath = toWorkspaceRelative(this.workspaceRoot, absolutePath);

    let originalContent = '';
    if (fs.existsSync(absolutePath)) {
      originalContent = fs.readFileSync(absolutePath, 'utf8');
    }

    const originalSha256 = computeSha256(originalContent);
    const hunks = computeHunks(filePath, originalContent, proposedContent);

    const id = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const proposal: ProposedEdit = {
      id,
      filePath,
      absolutePath,
      originalSha256,
      originalContent,
      proposedContent,
      hunks,
      status: hunks.length === 0 ? 'accepted' : 'pending',
      createdAt: Date.now(),
      sessionId,
      summary
    };

    this.proposals.set(id, proposal);
    this.notifyChange();
    return proposal;
  }

  public getProposal(id: string): ProposedEdit | undefined {
    return this.proposals.get(id);
  }

  public listProposals(): ProposedEdit[] {
    return Array.from(this.proposals.values());
  }

  public getPendingProposals(): ProposedEdit[] {
    return this.listProposals().filter(
      (p) => p.status === 'pending' || p.status === 'partially_accepted'
    );
  }

  public acceptHunk(proposalId: string, hunkId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return false;

    const hunk = proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk) return false;

    hunk.status = 'accepted';
    this.updateProposalStatus(proposal);
    this.notifyChange();
    return true;
  }

  public rejectHunk(proposalId: string, hunkId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return false;

    const hunk = proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk) return false;

    hunk.status = 'rejected';
    this.updateProposalStatus(proposal);
    this.notifyChange();
    return true;
  }

  public acceptAll(proposalId?: string): void {
    const targets = proposalId
      ? [this.proposals.get(proposalId)].filter(Boolean) as ProposedEdit[]
      : this.listProposals();

    for (const p of targets) {
      for (const h of p.hunks) {
        h.status = 'accepted';
      }
      p.status = 'accepted';
    }
    this.notifyChange();
  }

  public rejectAll(proposalId?: string): void {
    const targets = proposalId
      ? [this.proposals.get(proposalId)].filter(Boolean) as ProposedEdit[]
      : this.listProposals();

    for (const p of targets) {
      for (const h of p.hunks) {
        h.status = 'rejected';
      }
      p.status = 'rejected';
    }
    this.notifyChange();
  }

  private updateProposalStatus(proposal: ProposedEdit): void {
    const allAccepted = proposal.hunks.every((h) => h.status === 'accepted');
    const allRejected = proposal.hunks.every((h) => h.status === 'rejected');
    const someAccepted = proposal.hunks.some((h) => h.status === 'accepted');

    if (allAccepted) {
      proposal.status = 'accepted';
    } else if (allRejected) {
      proposal.status = 'rejected';
    } else if (someAccepted) {
      proposal.status = 'partially_accepted';
    } else {
      proposal.status = 'pending';
    }
  }

  /**
   * Applies all accepted changes safely with disk hash verification.
   */
  public async applyAccepted(
    proposalId?: string,
    description?: string
  ): Promise<ApplyResult> {
    const targets = proposalId
      ? [this.proposals.get(proposalId)].filter(Boolean) as ProposedEdit[]
      : this.listProposals();

    const result = await applyProposedEdits(
      targets,
      this.undoManager,
      description || 'Apply ForgePilot changes'
    );
    this.notifyChange();
    return result;
  }

  /**
   * Undoes the last applied change set.
   */
  public async undo(): Promise<{ success: boolean; revertedFiles: string[]; message: string }> {
    const result = await this.undoManager.undo();
    this.notifyChange();
    return result;
  }

  public canUndo(): boolean {
    return this.undoManager.canUndo();
  }

  public clear(): void {
    this.proposals.clear();
    this.notifyChange();
  }
}

