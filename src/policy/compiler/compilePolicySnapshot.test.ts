import { describe, expect, test } from "bun:test";
import { createTestPolicyAction } from "../../../testing/createPolicyAction.js";
import { actionMayMutatePolicySources } from "../snapshots/staleness.js";
import type { InstructionSource } from "../sources/types.js";
import {
  classifyStatement,
  compilePolicySnapshot,
  extractStatements,
} from "./compilePolicySnapshot.js";

const versions = {
  question: "question-v1",
  thresholds: "thresholds-v1",
  model: "jev-1.13.0",
};

describe("compilePolicySnapshot", () => {
  test("extracts prose and bullets while excluding headings and code fences", () => {
    const statements = extractStatements(`# Rules

- Never print secrets.
- Run verification before yielding.

Prefer boring code.

\`\`\`sh
rm -rf generated
\`\`\`
`);

    expect(statements).toEqual([
      "Never print secrets.",
      "Run verification before yielding.",
      "Prefer boring code.",
    ]);
    expect(statements.map(classifyStatement)).toEqual(["hard", "workflow", "advisory"]);
  });

  test("orders precedence and produces stable content-addressed identity", () => {
    const root = source("root", "project", "/workspace/project", 100, "Never commit.");
    const profile = source("profile", "profile", "/profile", 0, "Prefer concise output.");
    const subtree = source(
      "subtree",
      "subtree",
      "/workspace/project/packages/api",
      202,
      "Run API tests before yielding.",
    );

    const first = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      sources: [subtree, root, profile],
      versions,
      createdAtMs: 10,
    });
    const second = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      sources: [profile, root, subtree],
      versions,
      createdAtMs: 20,
    });

    expect(first.sources.map((item) => item.id)).toEqual(["profile", "root", "subtree"]);
    expect(first.rules.map((item) => item.sourceId)).toEqual(["profile", "root", "subtree"]);
    expect(first.id).toBe(second.id);
    expect(first.createdAtMs).not.toBe(second.createdAtMs);
  });

  test("changes snapshot identity when source content changes", () => {
    const before = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      sources: [source("root", "project", "/workspace/project", 100, "Never commit.")],
      versions,
    });
    const after = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      sources: [source("root", "project", "/workspace/project", 100, "Never push.")],
      versions,
    });

    expect(after.id).not.toBe(before.id);
  });

  test("marks existing or newly-created instruction paths as policy mutations", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      sources: [source("root", "project", "/workspace/project", 100, "Never commit.")],
      versions,
    });
    const action = createTestPolicyAction("write");

    expect(
      actionMayMutatePolicySources(
        { ...action, targets: [{ kind: "path", value: "AGENTS.md" }] },
        snapshot,
      ),
    ).toBe(true);
    expect(
      actionMayMutatePolicySources(
        { ...action, targets: [{ kind: "path", value: "packages/api/CLAUDE.md" }] },
        snapshot,
      ),
    ).toBe(true);
    expect(
      actionMayMutatePolicySources(
        { ...action, targets: [{ kind: "path", value: "../AGENTS.md" }] },
        snapshot,
      ),
    ).toBe(false);
  });
});

function source(
  id: string,
  kind: InstructionSource["kind"],
  scopeRoot: string,
  precedence: number,
  content: string,
): InstructionSource {
  return {
    id,
    kind,
    path: `${scopeRoot}/AGENTS.md`,
    scopeRoot,
    content,
    contentDigest: `digest:${content}`,
    precedence,
  };
}
