import * as fs from 'fs';
import { UndoRecord } from './types';
import { computeSha256 } from '../utils/hash';

export class UndoManager {
  private undoStack: UndoRecord[] = [];
  private redoStack: UndoRecord[] = [];

  /**
   * Records a change transaction.
   */
  public recordTransaction(record: UndoRecord): void {
    this.undoStack.push(record);
    this.redoStack = []; // Clear redo on new action
  }

  /**
   * Checks if an undo operation is available.
   */
  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Reverts the last transaction.
   * Returns details of reverted files.
   */
  public async undo(): Promise<{ success: boolean; revertedFiles: string[]; message: string }> {
    const record = this.undoStack.pop();
    if (!record) {
      return { success: false, revertedFiles: [], message: 'Nothing to undo.' };
    }

    const revertedFiles: string[] = [];
    const redoFiles: UndoRecord['files'] = [];

    for (const item of record.files) {
      try {
        const currentContent = fs.existsSync(item.absolutePath)
          ? fs.readFileSync(item.absolutePath, 'utf8')
          : '';

        redoFiles.push({
          filePath: item.filePath,
          absolutePath: item.absolutePath,
          beforeContent: currentContent,
          appliedContent: item.beforeContent
        });

        // Restore beforeContent
        fs.writeFileSync(item.absolutePath, item.beforeContent, 'utf8');
        revertedFiles.push(item.filePath);
      } catch (err: any) {
        return {
          success: false,
          revertedFiles,
          message: `Failed to restore file ${item.filePath}: ${err.message}`
        };
      }
    }

    this.redoStack.push({
      id: `redo-${Date.now()}`,
      timestamp: Date.now(),
      description: `Redo ${record.description}`,
      files: redoFiles
    });

    return {
      success: true,
      revertedFiles,
      message: `Undone "${record.description}" across ${revertedFiles.length} file(s).`
    };
  }

  /**
   * Clears all history.
   */
  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  public getHistory(): UndoRecord[] {
    return [...this.undoStack];
  }
}
