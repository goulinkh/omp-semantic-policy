import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyRepository } from "../persistence/index.js";
import { createProjectOnboarder } from "./createProjectOnboarder.js";
import { formatProjectPolicyReview, formatProjectPolicyStatus } from "./formatProjectPolicy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("project onboarding", () => {
  test("is idempotent, refreshes changes, and exposes status and review", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-policy-onboard-"));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, "project");
    const sourcePath = join(projectRoot, "AGENTS.md");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(sourcePath, "- Never commit automatically.\n");
    const repository = await createPolicyRepository(":memory:");
    const onboarder = createProjectOnboarder({
      repository,
      profileInstructionPaths: [],
      versions: {
        question: "question-v1",
        thresholds: "threshold-v1",
        model: "jev-1.13.0",
      },
    });

    const first = await onboarder.onboard(join(projectRoot, "src"));
    const second = await onboarder.onboard(projectRoot);

    expect(first.kind).toBe("ready");
    expect(first.kind === "ready" && first.changed).toBe(true);
    expect(second.kind === "ready" && second.changed).toBe(false);
    const firstSnapshotId = first.kind === "ready" ? first.snapshotId : "";

    await writeFile(sourcePath, "- Never push automatically.\n");
    const refreshed = await onboarder.onboard(projectRoot);
    expect(refreshed.kind === "ready" && refreshed.changed).toBe(true);
    expect(refreshed.kind === "ready" && refreshed.snapshotId).not.toBe(firstSnapshotId);

    const root = refreshed.kind === "ready" ? refreshed.projectRoot : undefined;
    expect(formatProjectPolicyStatus(repository, root)).toContain("State: active");
    expect(formatProjectPolicyReview(repository, root)).toContain("Never push automatically.");

    if (root !== undefined) {
      repository.markStale(root);
      const staleRefresh = await onboarder.onboard(root);
      expect(staleRefresh.kind === "ready" && staleRefresh.changed).toBe(true);
    }
    repository.close();
  });

  test("reports directories outside Git worktrees without persisting a project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-policy-no-project-"));
    temporaryDirectories.push(directory);
    const repository = await createPolicyRepository(":memory:");
    const onboarder = createProjectOnboarder({
      repository,
      profileInstructionPaths: [],
      versions: {
        question: "question-v1",
        thresholds: "threshold-v1",
        model: "jev-1.13.0",
      },
    });

    expect(await onboarder.onboard(directory)).toEqual({ kind: "no-project" });
    repository.close();
  });
});
