import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyRepository } from "../persistence/index.js";
import { createProjectOnboarder } from "./createProjectOnboarder.js";
import { createStandardsSourceResolver } from "./createStandardsSourceResolver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("model-assisted standards discovery", () => {
  test("admits only canonical files and exact runtime excerpts selected from grounded input", async () => {
    const fixture = await createFixture();
    const projectRoot = join(fixture, "project");
    const standardsPath = join(projectRoot, "guidance", "engineering.md");
    const outsidePath = join(fixture, "outside.md");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await mkdir(join(projectRoot, "guidance"), { recursive: true });
    await writeFile(
      standardsPath,
      "# Engineering rules\nNever bypass review.\nTOKEN=private-value\n",
    );
    await writeFile(join(projectRoot, "guidance", "overview.md"), "Architecture overview only.\n");
    await writeFile(outsidePath, "Never expose this outside file.\n");
    await symlink(outsidePath, join(projectRoot, "guidance", "linked.md"));

    let prompt = "";
    let completionCount = 0;
    const resolver = createStandardsSourceResolver({
      getRuntimeContext: () => [
        "MCP standard: Never delete production data.\nTOKEN=runtime-secret",
      ],
      sanitize: (text) => text.replace(/TOKEN=[^\s]+/gu, "[REDACTED]"),
      complete: async (input) => {
        completionCount += 1;
        prompt = input;
        return JSON.stringify({
          projectPaths: ["guidance/engineering.md", "guidance/linked.md", "../outside.md"],
          runtimeExcerpts: [
            { blockId: 0, text: "MCP standard: Never delete production data." },
            { blockId: 0, text: "Never invent this policy." },
            { blockId: 99, text: "MCP standard: Never delete production data." },
          ],
        });
      },
    });

    const first = await resolver.resolve({
      projectRoot,
      existingSources: [],
      force: false,
    });
    const second = await resolver.resolve({
      projectRoot,
      existingSources: [],
      force: false,
    });
    const canonicalRoot = await realpath(projectRoot);

    expect(completionCount).toBe(1);
    expect(second).toEqual(first);
    expect(prompt).toContain("guidance/engineering.md");
    expect(prompt).not.toContain("private-value");
    expect(prompt).not.toContain("runtime-secret");
    expect(prompt).toContain("[REDACTED]");
    expect(first).toHaveLength(2);
    expect(first[0]?.path).toBe(await realpath(standardsPath));
    expect(first[0]?.scopeRoot).toBe(canonicalRoot);
    expect(first[0]?.content).toContain("Never bypass review.");
    expect(first[1]?.path).toMatch(/^runtime:\/\/default-model\//u);
    expect(first[1]?.content).toBe("MCP standard: Never delete production data.");
  });

  test("keeps deterministic project sources when the configured model is unavailable", async () => {
    const fixture = await createFixture();
    const projectRoot = join(fixture, "project");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await mkdir(join(projectRoot, "guidance"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never commit automatically.\n");
    await writeFile(join(projectRoot, "guidance", "engineering.md"), "Never bypass review.\n");

    const repository = await createPolicyRepository(":memory:");
    const standardsSourceResolver = createStandardsSourceResolver({
      getRuntimeContext: () => [],
      complete: async () => undefined,
    });
    const onboarder = createProjectOnboarder({
      repository,
      profileInstructionPaths: [],
      standardsSourceResolver,
      versions: {
        question: "question-v1",
        thresholds: "threshold-v1",
        model: "jev-1.13.0",
      },
    });

    const result = await onboarder.onboard(projectRoot);
    expect(result.kind).toBe("ready");
    expect(result.kind === "ready" && result.sourceCount).toBe(1);
    expect(repository.getActiveSnapshot(await realpath(projectRoot))?.sources).toHaveLength(1);
    repository.close();
  });
});

async function createFixture(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "omp-policy-standards-"));
  temporaryDirectories.push(fixture);
  return fixture;
}
