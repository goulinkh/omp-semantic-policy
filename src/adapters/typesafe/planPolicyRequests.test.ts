import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  MAX_POLICY_REQUEST_BYTES,
  MAX_POLICY_REQUEST_CHUNKS,
  planPolicyRequests,
  type PolicyRequestPlan,
} from "./planPolicyRequests.js";
import type { RedactedProviderState } from "./redactProviderState.js";

type Rule = RedactedProviderState["policy"]["rules"][number];

describe("policy request planning", () => {
  test("keeps a fitting request in the existing lossless wire format", () => {
    const state = createState([
      createRule("ban", "Never deploy.", ["Operations", "Deploy"]),
      {
        ...createRule("exception", "A requested repair may deploy.", ["Operations", "Deploy"]),
        class: "semantic",
      },
      {
        ...createRule("other", "Never publish secrets.", ["Security"]),
        sourceId: "nested",
        precedence: 200,
      },
    ]);
    const plan = ready(planPolicyRequests(state));
    expect(plan.chunks).toHaveLength(1);
    const chunk = plan.chunks[0]!;
    expect(chunk.wire).toEqual({
      policy: {
        snapshotId: state.policy.snapshotId,
        sources: [
          ["root", 100],
          ["nested", 200],
        ],
        contexts: [["Operations", "Deploy"], ["Security"]],
        rules: [
          ["r0", "hard", 0, 0, "Never deploy."],
          ["r1", "semantic", 0, 0, "A requested repair may deploy."],
          ["r2", "hard", 1, 1, "Never publish secrets."],
        ],
      },
      action: state.action,
      authorization: state.authorization,
    });
    expect([...chunk.ruleIdsByAlias]).toEqual([
      ["r0", "ban"],
      ["r1", "exception"],
      ["r2", "other"],
    ]);
    expect(plan.originalStateBytes).toBe(Buffer.byteLength(JSON.stringify(chunk.wire)));
    expect(plan.totalStateBytes).toBe(plan.originalStateBytes);
  });

  test("preserves every full rule and its dictionaries across Unicode-heavy chunks", () => {
    const rules = Array.from({ length: 150 }, (_, index): Rule => ({
      ...createRule(`rule-${index}`, `Rule ${index}: ${'界🙂\\\"\n'.repeat(120)}`, [
        "Policies",
        `Heading ${index % 17} 界`,
      ]),
      sourceId: `source-${index % 13}`,
      precedence: index % 13,
      class: index % 2 === 0 ? "hard" : "semantic",
    }));
    const state = createState(rules);
    const plan = ready(planPolicyRequests(state));
    expect(plan.chunks.length).toBeGreaterThan(1);
    const decoded: Rule[] = [];
    let totalBytes = 0;
    for (const [index, chunk] of plan.chunks.entries()) {
      const serialized = JSON.stringify(chunk.wire);
      expect(chunk.stateBytes).toBe(Buffer.byteLength(serialized));
      expect(chunk.stateBytes).toBeLessThanOrEqual(MAX_POLICY_REQUEST_BYTES);
      expect(chunk.stateDigest).toBe(createHash("sha256").update(serialized).digest("hex"));
      expect(chunk.wire.policy.partition).toEqual({ index, count: plan.chunks.length });
      expect(chunk.wire.action).toEqual(state.action);
      expect(chunk.wire.authorization).toEqual(state.authorization);
      expect(chunk.ruleIdsByAlias.size).toBe(chunk.wire.policy.rules.length);
      for (const [alias, classification, sourceIndex, contextIndex, statement] of chunk.wire.policy
        .rules) {
        const [sourceId, precedence] = chunk.wire.policy.sources[sourceIndex]!;
        decoded.push({
          id: chunk.ruleIdsByAlias.get(alias)!,
          class: classification,
          statement,
          sourceId,
          precedence,
          context: chunk.wire.policy.contexts[contextIndex]!,
        });
      }
      totalBytes += chunk.stateBytes;
    }
    expect(decoded).toEqual(rules);
    expect(plan.totalStateBytes).toBe(totalBytes);
  });

  test("accepts the exact UTF-8 byte boundary but cannot discard partition overhead", () => {
    const base = createState([createRule("boundary", "", ["界"])]);
    const overhead = ready(planPolicyRequests(base)).chunks[0]!.stateBytes;
    const available = MAX_POLICY_REQUEST_BYTES - overhead;
    const statement = "é".repeat(Math.floor(available / 2)) + "x".repeat(available % 2);
    const full = createState([createRule("boundary", statement, ["界"])]);
    const exact = ready(planPolicyRequests(full));
    expect(exact.chunks).toHaveLength(1);
    expect(exact.chunks[0]!.stateBytes).toBe(MAX_POLICY_REQUEST_BYTES);
    expect(exact.chunks[0]!.wire.policy.partition).toBeUndefined();

    const needsPartition = createState([
      ...full.policy.rules,
      createRule("extra", "A second rule."),
    ]);
    const result = planPolicyRequests(needsPartition);
    expect(result.kind).toBe("too-large");
    expect(result).not.toHaveProperty("chunks");
  });

  test("rejects an oversized action even without any policy rules", () => {
    const base = createState([]);
    const state: RedactedProviderState = {
      ...base,
      action: { ...base.action, details: { command: "界".repeat(MAX_POLICY_REQUEST_BYTES / 2) } },
    };
    const result = planPolicyRequests(state);
    expect(result.kind).toBe("too-large");
    expect(result).not.toHaveProperty("chunks");
  });

  test("accepts indivisible rules fitting the actual small-batch partition header", () => {
    const base = createState([createRule("boundary", "")]);
    const overhead = ready(planPolicyRequests(base)).chunks[0]!.stateBytes;
    const partitionBytes = Buffer.byteLength(',"partition":{"index":0,"count":2}');
    const statement = "x".repeat(MAX_POLICY_REQUEST_BYTES - overhead - partitionBytes);
    const rules = [
      createRule("boundary", statement),
      createRule("extra", "Another independent rule that must be retained in a second request."),
    ];
    const plan = ready(planPolicyRequests(createState(rules)));
    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0]!.stateBytes).toBe(MAX_POLICY_REQUEST_BYTES);
    expect(plan.chunks[0]!.wire.policy.rules[0]![4]).toBe(statement);
    expect(plan.chunks[0]!.wire.policy.partition).toEqual({ index: 0, count: 2 });

    // A tenth chunk adds a count digit to every request, so this same rule can no longer fit.
    const largerBatch = [
      rules[0]!,
      ...Array.from({ length: 9 }, (_, index) => createRule(`extra-${index}`, "y".repeat(24_000))),
    ];
    const result = planPolicyRequests(createState(largerBatch));
    expect(result.kind).toBe("too-large");
    expect(result).not.toHaveProperty("chunks");
  });

  test("rejects an indivisible rule including its full heading rather than returning a partial plan", () => {
    const rules = [
      createRule("fits", "A".repeat(25_000)),
      createRule("oversized", "Never deploy.", ["界".repeat(MAX_POLICY_REQUEST_BYTES / 2)]),
    ];
    const result = planPolicyRequests(createState(rules));
    expect(result.kind).toBe("too-large");
    expect(result).not.toHaveProperty("chunks");
  });

  test("moves a fitting adjacent context group intact instead of filling the preceding chunk", () => {
    const rules = [
      createRule("earlier", "A".repeat(24_000), ["Earlier"]),
      createRule("ban", "B".repeat(10_000), ["Deployment"]),
      createRule("exception", "C".repeat(10_000), ["Deployment"]),
    ];
    const plan = ready(planPolicyRequests(createState(rules)));
    expect(plan.chunks.map((chunk) => [...chunk.ruleIdsByAlias.values()])).toEqual([
      ["earlier"],
      ["ban", "exception"],
    ]);
  });

  test("splits an oversized context group at whole rules up to 64 chunks, rejecting the 65th", () => {
    const rules = Array.from({ length: MAX_POLICY_REQUEST_CHUNKS }, (_, index) =>
      createRule(`rule-${index}`, `${index}: ${"界".repeat(8_000)}`, ["One shared group"]),
    );
    const plan = ready(planPolicyRequests(createState(rules)));
    expect(plan.chunks).toHaveLength(MAX_POLICY_REQUEST_CHUNKS);
    expect(plan.chunks.map((chunk) => [...chunk.ruleIdsByAlias.values()])).toEqual(
      rules.map((rule) => [rule.id]),
    );
    for (const [index, chunk] of plan.chunks.entries()) {
      expect(chunk.stateBytes).toBeLessThanOrEqual(MAX_POLICY_REQUEST_BYTES);
      expect(chunk.wire.policy.partition).toEqual({ index, count: MAX_POLICY_REQUEST_CHUNKS });
      expect(chunk.wire.policy.rules[0]![4]).toBe(rules[index]!.statement);
    }
    const result = planPolicyRequests(
      createState([...rules, createRule("overflow", "界".repeat(8_000), ["One shared group"])]),
    );
    expect(result.kind).toBe("too-large");
    expect(result).not.toHaveProperty("chunks");
  });
});

function ready(plan: PolicyRequestPlan): Extract<PolicyRequestPlan, { kind: "ready" }> {
  if (plan.kind !== "ready") throw new Error(plan.reason);
  return plan;
}

function createRule(id: string, statement: string, context: string[] = []): Rule {
  return { id, class: "hard", statement, sourceId: "root", precedence: 100, context };
}

function createState(rules: Rule[]): RedactedProviderState {
  return {
    policy: { snapshotId: "snapshot", rules },
    action: {
      operation: "write",
      interception: "precise",
      complete: true,
      details: { path: "src/界.ts", command: "printf 'hello'" },
      targets: [{ kind: "path", value: "src/界.ts" }],
      host: "omp",
      name: "write",
    },
    authorization: {
      source: "current-turn",
      explicit: false,
      scope: "request",
      summary: "Inspect the source; do not deploy.",
    },
  };
}
