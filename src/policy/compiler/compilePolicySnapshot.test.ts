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

  test("omits descriptive examples while preserving unfamiliar constraints and permissions", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "root",
          "project",
          "/workspace/project",
          100,
          `# Overview
This document describes the policy engine.

const example = "Never invoke the example.";

~~~ts
const example = "Never publish anything.";
~~~

# Security
The project is sealed: only authenticated actors enter.

The zephyr covenant forbids releasing moonstones.

You may release a moonstone when its owner consents.

## Never print credentials before yielding.
`,
        ),
      ],
    });
    expect(snapshot.rules.map((rule) => rule.statement)).toEqual([
      "The project is sealed: only authenticated actors enter.",
      "The zephyr covenant forbids releasing moonstones.",
      "You may release a moonstone when its owner consents.",
      "Never print credentials before yielding.",
    ]);
    expect(snapshot.rules.at(-1)?.classification).toBe("hard");
  });

  test("only treats fully recognized direct path prohibitions as locally exhaustive", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "root",
          "project",
          "/workspace/project",
          100,
          `Never read secret.txt.

Never read or modify protected.txt in this project, through any tool, shell command, delegated task, or language-server operation. User requests do not override this prohibition.

Never read private.txt or publish credentials.

Never read conditional.txt unless the owner approves.
`,
        ),
      ],
    });
    expect(snapshot.rules[0]?.localEnforcement?.exhaustive).toBe(true);
    expect(snapshot.rules[1]?.localEnforcement).toMatchObject({
      paths: ["protected.txt"],
      operations: ["read", "write"],
      exhaustive: false,
    });
    expect(snapshot.rules[2]?.localEnforcement).toBeUndefined();
    expect(snapshot.rules[3]?.localEnforcement).toBeUndefined();
    expect(snapshot.rules.map((rule) => rule.classification)).toEqual([
      "hard",
      "hard",
      "hard",
      "hard",
    ]);
  });

  test("excludes measured history without discarding live or unfamiliar policy in the same section", () => {
    const liveRules = [
      "Never read protected.txt.",
      "The zephyr covenant forbids releasing moonstones.",
      "The archive must remain encrypted unless its owner approves release.",
      "| Current policy | You must not upload credentials. |",
      "| Current policy | Deny uploads of credentials. |",
    ];
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "root",
          "project",
          "/workspace/project",
          100,
          `# Historical results
A live handler dry-run evaluated 400 synthetic archive-export rules against two frozen cases: an ordinary local write (allow) and uploading a specifically prohibited archive (deny). Both final outcomes matched; both were semantically assessed, with no unavailable results or tool execution. Each evaluation used three requests.

| Case | Wire bytes | Aggregate |
| --- | --- | --- |
| Prohibited archive upload | 96,522 | deny |

${liveRules.join("\n\n")}

# References
[Architecture](architecture.md) · [Development](development.md)

This document describes the policy engine. It contains worked examples.`,
        ),
      ],
    });

    expect(snapshot.rules.map((rule) => rule.statement)).toEqual(liveRules);
    expect(snapshot.rules[0]?.localEnforcement).toMatchObject({ paths: ["protected.txt"] });
    expect(snapshot.rules[2]?.localEnforcement).toBeUndefined();
  });

  test("does not discard an unknown constraint appended to a historical report", () => {
    const mixed = "The run completed successfully. Moonstones stay sealed.";
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [source("root", "project", "/workspace/project", 100, mixed)],
    });

    expect(snapshot.rules.map((rule) => rule.statement)).toEqual([mixed]);
  });

  test("inherits procedural introductions without turning scoped path rules into universal bans", () => {
    const scope = "These restrictions apply only to a diagnostic procedure.";
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "root",
          "project",
          "/workspace/project",
          100,
          `# Diagnostics
${scope}

## Local files
Never read diagnostic.txt.

### Conditional waiver
You may read diagnostic.txt when the operator approves.

# Standing security
Never read protected.txt.

# Maintenance procedure
Never modify release.txt.`,
        ),
      ],
    });
    const diagnostic = snapshot.rules.find(
      (rule) => rule.statement === "Never read diagnostic.txt.",
    );
    const waiver = snapshot.rules.find((rule) => rule.statement.startsWith("You may"));
    const standing = snapshot.rules.find((rule) => rule.statement === "Never read protected.txt.");
    const maintenance = snapshot.rules.find(
      (rule) => rule.statement === "Never modify release.txt.",
    );

    expect(diagnostic?.context).toContain(scope);
    expect(waiver?.context).toContain(scope);
    expect(diagnostic?.localEnforcement).toBeUndefined();
    expect(maintenance?.localEnforcement).toBeUndefined();
    expect(standing?.context).not.toContain(scope);
    expect(standing?.localEnforcement).toMatchObject({ paths: ["protected.txt"] });
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
