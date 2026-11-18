export interface SearchWorkspaceArgs {
  query: string;
  filePattern?: string;
  maxResults?: number;
}

export interface ListFilesArgs {
  directory?: string;
  maxFiles?: number;
}

export interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface GetSymbolsArgs {
  path?: string;
  query?: string;
}

export interface GetReferencesArgs {
  symbol: string;
  filePattern?: string;
}

export interface ProposeEditArgs {
  path: string;
  proposedContent: string;
  summary?: string;
}

export interface RunCommandArgs {
  command: string;
  timeoutMs?: number;
}

export interface RunTestsArgs {
  testCommand?: string;
  path?: string;
}

export interface GetFileDiffArgs {
  proposalId?: string;
  path?: string;
}
