import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { InstructionSource } from "../../../policy/index.js";
import { hasGitMarker } from "./findGitProjectRoot.js";

const INSTRUCTION_FILENAMES: Readonly<Record<string, true>> = {
  "AGENTS.md": true,
  "CLAUDE.md": true,
};

const IGNORED_DIRECTORIES: Readonly<Record<string, true>> = {
  ".git": true,
  build: true,
  coverage: true,
  dist: true,
  node_modules: true,
  target: true,
  vendor: true,
};

/** Discover project instructions while excluding ancestors and nested repositories. */
export async function discoverProjectInstructionSources(
  projectRoot: string,
): Promise<readonly InstructionSource[]> {
  const canonicalRoot = await realpath(projectRoot);
  const sources: InstructionSource[] = [];
  await walkProject(canonicalRoot, canonicalRoot, sources);
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

/** Read optional profile-level instruction files through an explicit source list. */
export async function discoverProfileInstructionSources(
  paths: readonly string[],
): Promise<readonly InstructionSource[]> {
  const sources: InstructionSource[] = [];

  for (const configuredPath of paths) {
    try {
      const canonicalPath = await realpath(configuredPath);
      const fileStats = await lstat(canonicalPath);
      if (!fileStats.isFile()) {
        continue;
      }
      const content = await readFile(canonicalPath, "utf8");
      sources.push({
        id: `profile:${canonicalPath}`,
        kind: "profile",
        path: canonicalPath,
        scopeRoot: dirname(canonicalPath),
        content,
        contentDigest: digestText(content),
        precedence: 0,
      });
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }

  return sources;
}

async function walkProject(
  projectRoot: string,
  directory: string,
  sources: InstructionSource[],
): Promise<void> {
  if (directory !== projectRoot && (await hasGitMarker(directory))) {
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES[entry.name] !== true) {
        await walkProject(projectRoot, entryPath, sources);
      }
      continue;
    }
    if (!entry.isFile() || INSTRUCTION_FILENAMES[entry.name] !== true) {
      continue;
    }

    const canonicalPath = await realpath(entryPath);
    if (!isPathWithin(projectRoot, canonicalPath)) {
      continue;
    }
    const content = await readFile(canonicalPath, "utf8");
    const scopeRoot = dirname(canonicalPath);
    const projectRelativePath = relative(projectRoot, canonicalPath);
    const depth = relative(projectRoot, scopeRoot).split(sep).filter(Boolean).length;
    sources.push({
      id: `project:${projectRelativePath}`,
      kind: scopeRoot === projectRoot ? "project" : "subtree",
      path: canonicalPath,
      scopeRoot,
      content,
      contentDigest: digestText(content),
      precedence: scopeRoot === projectRoot ? 100 : 200 + depth,
    });
  }
}

export function digestText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
