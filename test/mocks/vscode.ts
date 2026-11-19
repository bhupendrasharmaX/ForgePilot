export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: Position, end: Position);
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }

  public get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorCharacter: number, activeLine: number, activeCharacter: number);
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    super(a as any, b as any, c as any, d as any);
    this.anchor = this.start;
    this.active = this.end;
  }
}

export class Uri {
  public scheme: string = 'file';
  public authority: string = '';
  public path: string;
  public fsPath: string;

  constructor(fsPath: string) {
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, '/');
  }

  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static parse(uriStr: string): Uri {
    return new Uri(uriStr);
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const joined = [base.fsPath, ...pathSegments].join('/').replace(/\/+/g, '/');
    return new Uri(joined);
  }
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export const window = {
  activeTextEditor: undefined as any,
  showErrorMessage: async (...args: any[]) => undefined,
  showWarningMessage: async (...args: any[]) => undefined,
  showInformationMessage: async (...args: any[]) => undefined,
  showInputBox: async (options?: any) => undefined as string | undefined,
  withProgress: async (options: any, task: (progress: any, token: any) => Promise<any>) => {
    return task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) });
  }
};

export const workspace = {
  getWorkspaceFolder: (uri: Uri) => undefined as any,
  workspaceFolders: [] as any[]
};

export const commands = {
  executeCommand: async (command: string, ...args: any[]) => undefined,
  registerCommand: (command: string, callback: (...args: any[]) => any) => ({
    dispose: () => {}
  })
};

export default {
  Position,
  Range,
  Selection,
  Uri,
  ProgressLocation,
  window,
  workspace,
  commands
};

