import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Resolve the nearest enclosing Git worktree without crossing realpath boundaries. */
export async function findGitProjectRoot(startPath: string): Promise<string | undefined> {
  const resolvedStart = await realpath(startPath);
  const startStats = await stat(resolvedStart);
  let current = startStats.isDirectory() ? resolvedStart : dirname(resolvedStart);

  for (;;) {
    if (await hasGitMarker(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    const marker = await lstat(join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
