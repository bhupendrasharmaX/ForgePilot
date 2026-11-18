import * as path from 'path';

/**
 * Validates and resolves a file path within the allowed workspace root.
 * Throws an error if path traversal or access outside workspace is attempted.
 */
export function resolveSafePath(workspaceRoot: string, relativeOrAbsolutePath: string): string {
  if (!workspaceRoot) {
    throw new Error('Workspace root directory is not configured or open.');
  }

  const normalizedRoot = path.resolve(workspaceRoot);
  let resolvedPath = path.isAbsolute(relativeOrAbsolutePath)
    ? path.resolve(relativeOrAbsolutePath)
    : path.resolve(normalizedRoot, relativeOrAbsolutePath);

  // Check if resolvedPath is inside normalizedRoot
  const relative = path.relative(normalizedRoot, resolvedPath);
  const isOutside = relative.startsWith('..') || path.isAbsolute(relative);

  if (isOutside) {
    throw new Error(
      `Access denied: Path "${relativeOrAbsolutePath}" is outside the active workspace directory "${workspaceRoot}".`
    );
  }

  return resolvedPath;
}

/**
 * Checks if a given path is within the workspace directory.
 */
export function isPathInWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  try {
    resolveSafePath(workspaceRoot, candidatePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns path relative to workspace root with forward slashes for cross-platform consistency.
 */
export function toWorkspaceRelative(workspaceRoot: string, fullPath: string): string {
  const rel = path.relative(workspaceRoot, fullPath);
  return rel.replace(/\\/g, '/');
}
