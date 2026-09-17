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

  test("falls back conservatively when the provider is unavailable", async () => {
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("write"),
      context: { headless: true },
      snapshot,
      model: policyModel({ kind: "unavailable", reason: "offline" }),
    });

    expect(decision.effect).toBe("prompt");
    expect(decision.evidence.source).toBe("fallback");
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
