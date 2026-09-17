import { describe, expect, test } from "bun:test";
import { createTestPolicyAction } from "../../../../testing/createPolicyAction.js";
import type { PolicyModel, PolicyModelResult, PolicySnapshot } from "../../../policy/index.js";
import { evaluateSnapshotPolicy } from "./evaluateSnapshotPolicy.js";

const snapshot: PolicySnapshot = {
  schemaVersion: 1,
  id: "snapshot-1",
  projectRoot: "/workspace/project",
  createdAtMs: 1,
  versions: {
    compiler: "compiler-v1",
    question: "question-v1",
    thresholds: "threshold-v1",
    model: "model-v1",
  },
  sources: [
    {
      id: "root",
      kind: "project",
      path: "/workspace/project/AGENTS.md",
      scopeRoot: "/workspace/project",
      content: "Never publish secrets.",
      contentDigest: "digest",
      precedence: 100,
    },
  ],
  rules: [
    {
      id: "rule-1",
      sourceId: "root",
      sourceKind: "project",
      scopeRoot: "/workspace/project",
      classification: "hard",
      statement: "Never publish secrets.",
      precedence: 100,
    },
  ],
};

describe("evaluateSnapshotPolicy", () => {
  test("uses the semantic decision and preserves applicable rule evidence", async () => {
    const model = policyModel({
      kind: "decision",
      effect: "deny",
      confidence: 0.95,
      hardViolationProbability: 0.9,
      model: "model-v1",
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("network"),
      context: { headless: true },
      snapshot,
      model,
    });

    expect(decision.effect).toBe("deny");
    expect(decision.evidence).toEqual({
      evaluatorId: "fixture:model-v1",
      source: "semantic",
      ruleIds: ["rule-1"],
    });
  });

  test("uses friendly confidence bands for confirmation decisions", async () => {
    const cases = [
      {
        confidence: 0.9,
        reason: "🔐 Confirmation required · high confidence · 90%",
      },
      {
        confidence: 0.81,
        reason: "⚠️ Confirmation recommended · medium confidence · 81%",
      },
      {
        confidence: 0.64,
        reason: "🤔 Policy match is uncertain · please confirm · 64%",
      },
    ] as const;

    for (const item of cases) {
      const decision = await evaluateSnapshotPolicy({
        action: createTestPolicyAction("network"),
        context: { headless: false },
        snapshot,
        model: policyModel({
          kind: "decision",
          effect: "prompt",
          confidence: item.confidence,
          hardViolationProbability: 0.1,
          model: "model-v1",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
        confirmation: { defaultAction: "deny", threshold: 0 },
      });

      expect(decision.effect).toBe("prompt");
      expect(decision.effect === "prompt" && decision.reason).toBe(item.reason);
    }
  });

  test("automatically denies confirmation requests by default", async () => {
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("network"),
      context: { headless: false },
      snapshot,
      model: policyModel({
        kind: "decision",
        effect: "prompt",
        confidence: 0.14,
        hardViolationProbability: 0.1,
        model: "model-v1",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });

    expect(decision.effect).toBe("deny");
    expect(decision.effect === "deny" && decision.reason).toBe(
      "Policy confirmation denied by configuration · low confidence · 14%.",
    );
  });

  test("automatically approves below-threshold confirmations when configured", async () => {
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("network"),
      context: { headless: false },
      snapshot,
      model: policyModel({
        kind: "decision",
        effect: "prompt",
        confidence: 0.79,
        hardViolationProbability: 0.1,
        model: "model-v1",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      confirmation: { defaultAction: "approve", threshold: 0.8 },
    });

    expect(decision.effect).toBe("allow");
  });

  test("automatically denies unavailable-provider confirmations by default", async () => {
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("write"),
      context: { headless: true },
      snapshot,
      model: policyModel({ kind: "unavailable", reason: "offline" }),
    });

    expect(decision.effect).toBe("deny");
    expect(decision.evidence.source).toBe("fallback");
  });

  test("does not label an empty-token command as a violation when evaluation is unavailable", async () => {
    const action = {
      ...createTestPolicyAction("execute"),
      targets: [
        {
          kind: "command" as const,
          value: "curl -sS -d 'token=' https://example.com/upload",
        },
      ],
      hostAction: { host: "omp", name: "bash", input: {} },
    };
    const decision = await evaluateSnapshotPolicy({
      action,
      context: { headless: false },
      snapshot,
      confirmation: { defaultAction: "deny", threshold: 0 },
    });

    expect(decision.effect).toBe("prompt");
    expect(decision.effect === "prompt" && decision.reason).toContain(
      "was not classified as compliant or noncompliant",
    );
    expect(decision.effect === "prompt" && decision.reason).not.toContain("denied");
  });

  test("deterministically allows actions when no compiled rule applies", async () => {
    const emptySnapshot = { ...snapshot, rules: [] };
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("write"),
      context: { headless: true },
      snapshot: emptySnapshot,
    });

    expect(decision).toEqual({
      effect: "allow",
      evidence: {
        evaluatorId: "compiled-policy-coverage",
        source: "deterministic",
        ruleIds: ["snapshot.no-applicable-rules"],
      },
    });
  });
});

function policyModel(result: PolicyModelResult): PolicyModel {
  return {
    providerId: "fixture",
    modelVersion: "model-v1",
    async validate() {
      return { model: "model-v1", availableModels: ["model-v1"] };
    },
    async evaluate() {
      return result;
    },
  };
}
