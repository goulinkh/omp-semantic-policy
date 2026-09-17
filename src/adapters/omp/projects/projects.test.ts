import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { discoverProjectInstructionSources, findGitProjectRoot } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Git project identity and instruction discovery", () => {
  test("selects the nearest canonical worktree through a symlink", async () => {
    const fixture = await createFixture();
    const outerRoot = join(fixture, "outer");
    const nestedRoot = join(outerRoot, "packages", "nested");
    await mkdir(join(outerRoot, ".git"), { recursive: true });
    await mkdir(join(nestedRoot, "src"), { recursive: true });
    await writeFile(join(nestedRoot, ".git"), "gitdir: ../../../git/worktrees/nested\n");
    const linkedRoot = join(fixture, "linked-nested");
    await symlink(nestedRoot, linkedRoot);

    expect(await findGitProjectRoot(join(linkedRoot, "src"))).toBe(await realpath(nestedRoot));
  });

  test("stays inside the root and excludes nested repositories and symlinks", async () => {
    const fixture = await createFixture();
    const root = join(fixture, "project");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "packages", "api"), { recursive: true });
    await mkdir(join(root, "packages", "nested", ".git"), { recursive: true });
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Root rule\n");
    await writeFile(join(root, "packages", "api", "CLAUDE.md"), "API rule\n");
    await writeFile(join(root, "packages", "nested", "AGENTS.md"), "Nested rule\n");
    await writeFile(join(root, "node_modules", "dependency", "AGENTS.md"), "Dependency rule\n");
    await writeFile(join(fixture, "outside.md"), "Outside rule\n");
    await symlink(join(fixture, "outside.md"), join(root, "packages", "linked-AGENTS.md"));

    const sources = await discoverProjectInstructionSources(root);
    const canonicalRoot = await realpath(root);

    expect(sources.map((source) => relative(canonicalRoot, source.path))).toEqual([
      "AGENTS.md",
      join("packages", "api", "CLAUDE.md"),
    ]);
    expect(sources.map((source) => source.kind)).toEqual(["project", "subtree"]);
    expect(sources[1]?.scopeRoot).toBe(join(canonicalRoot, "packages", "api"));
  });
});

async function createFixture(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "omp-policy-projects-"));
  temporaryDirectories.push(fixture);
  return fixture;
}
