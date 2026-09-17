import { describe, expect, test } from "bun:test";
import { createTestPolicyAction } from "../../../testing/createPolicyAction.js";
import { selectApplicableSources } from "./selectApplicableSources.js";
import type { InstructionSource } from "./types.js";

const sources: readonly InstructionSource[] = [
  source("profile", "profile", "/profile", 0),
  source("root", "project", "/workspace/project", 100),
  source("api", "subtree", "/workspace/project/packages/api", 202),
  source("web", "subtree", "/workspace/project/packages/web", 202),
];

describe("selectApplicableSources", () => {
  test("applies only the subtree containing a path target", () => {
    const action = createTestPolicyAction("write");
    const applicable = selectApplicableSources(sources, {
      ...action,
      targets: [{ kind: "path", value: "packages/api/src/index.ts" }],
    });

    expect(applicable.map((source) => source.id)).toEqual(["profile", "root", "api"]);
  });

  test("does not leak subtree rules into pathless actions", () => {
    const applicable = selectApplicableSources(sources, createTestPolicyAction("network"));
    expect(applicable.map((source) => source.id)).toEqual(["profile", "root"]);
  });

  test("includes every subtree for project-wide workflow checks", () => {
    const applicable = selectApplicableSources(sources, createTestPolicyAction("workflow"));
    expect(applicable.map((source) => source.id)).toEqual(["profile", "root", "api", "web"]);
  });
});

function source(
  id: string,
  kind: InstructionSource["kind"],
  scopeRoot: string,
  precedence: number,
): InstructionSource {
  return {
    id,
    kind,
    path: `${scopeRoot}/AGENTS.md`,
    scopeRoot,
    content: `${id} rule`,
    contentDigest: `${id}-digest`,
    precedence,
  };
}
