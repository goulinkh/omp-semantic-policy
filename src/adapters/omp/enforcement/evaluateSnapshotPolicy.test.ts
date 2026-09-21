import { describe, expect, test } from "bun:test";
import { createTestPolicyAction } from "../../../../testing/createPolicyAction.js";
import type { PolicyModel, PolicyModelResult, PolicySnapshot } from "../../../policy/index.js";
import { compilePolicySnapshot } from "../../../policy/compiler/compilePolicySnapshot.js";
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
  test("distinguishes matched rules from applicable candidates and resolves provenance", async () => {
    const model = policyModel({
      kind: "decision",
      effect: "deny",
      confidence: 0.95,
      hardViolationProbability: 0.9,
      model: "model-v1",
      usage: { inputTokens: 1, outputTokens: 1 },
      ruleIds: ["rule-1"],
    });

    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("network"),
      context: { headless: true },
      snapshot,
      model,
    });

    expect(decision.effect).toBe("deny");
    expect(decision.evidence).toMatchObject({
      evaluatorId: "fixture:model-v1",
      source: "semantic",
      ruleIds: ["rule-1"],
      applicableRuleIds: ["rule-1"],
      diagnostics: {
        path: "semantic",
        decisiveRule: {
          ruleId: "rule-1",
          sourceId: "root",
          sourcePath: "/workspace/project/AGENTS.md",
        },
        confirmation: { resolution: "not-required" },
        enforcedEffect: "deny",
      },
    });
  });

  test("automatically accepts uncertain execution unless stricter confirmation is configured", async () => {
    const options = {
      action: createTestPolicyAction("execute"),
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
    };

    const automatic = await evaluateSnapshotPolicy(options);
    expect(automatic.effect).toBe("allow");
    expect(automatic.evidence.diagnostics?.confirmation.resolution).toBe("automatic-approve");
    const interactive = await evaluateSnapshotPolicy({
      ...options,
      confirmation: { defaultAction: "deny", threshold: 0 },
    });
    expect(interactive.effect).toBe("prompt");
    expect(interactive.evidence.diagnostics?.confirmation.resolution).toBe("pending");
    const belowThreshold = await evaluateSnapshotPolicy({
      ...options,
      confirmation: { defaultAction: "deny", threshold: 0.8 },
    });
    expect(belowThreshold.effect).toBe("deny");
    expect(belowThreshold.evidence.diagnostics?.confirmation.resolution).toBe("automatic-deny");
  });

  test("grounded explicit denials and hard overrides survive automatic and maintenance approval", async () => {
    for (const decisionBasis of ["choice", "hard-violation"] as const) {
      const decision = await evaluateSnapshotPolicy({
        action: createTestPolicyAction("execute"),
        context: { headless: false },
        snapshot,
        confirmation: { defaultAction: "approve", threshold: 1 },
        maintenanceApproved: true,
        model: policyModel({
          ...modelDecision("deny"),
          confidence: 0.91,
          hardViolationProbability: decisionBasis === "hard-violation" ? 0.8 : 0.1,
          ruleIds: ["rule-1"],
          diagnostics: {
            status: "assessed",
            providerId: "fixture",
            requestedModel: "model-v1",
            decisionBasis,
            rawChoice: decisionBasis === "hard-violation" ? "allow" : "deny",
          },
        }),
      });
      expect(decision.effect).toBe("deny");
      expect(decision.evidence.diagnostics?.confirmation.resolution).toBe("not-required");
      expect(decision.evidence.ruleIds).toEqual(["rule-1"]);
      expect(decision.evidence.diagnostics?.semantic?.decisionBasis).toBe(decisionBasis);
    }
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
    expect(decision.evidence.diagnostics?.confirmation.resolution).toBe("automatic-approve");
  });

  test("automatically accepts unavailable-provider confirmations by default", async () => {
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("write"),
      context: { headless: true },
      snapshot,
      model: policyModel({ kind: "unavailable", reason: "offline" }),
    });

    expect(decision.effect).toBe("allow");
    expect(decision.evidence.source).toBe("fallback");
    expect(decision.evidence.ruleIds).toEqual([]);
    expect(decision.evidence.diagnostics).toMatchObject({
      path: "provider-unavailable",
      semantic: { status: "unavailable" },
      confirmation: { resolution: "automatic-approve" },
    });
  });

  test("preserves explicit fail-closed behavior for unavailable reads and workflow checks", async () => {
    for (const operation of ["read", "workflow"] as const) {
      const options = {
        action: createTestPolicyAction(operation),
        context: { headless: false },
        snapshot,
        model: policyModel({ kind: "unavailable", reason: "offline" }),
        maintenanceApproved: true,
        confirmation: { defaultAction: "deny" as const, threshold: 1 },
      };
      const automatic = await evaluateSnapshotPolicy(options);
      expect(automatic.effect).toBe("deny");
      expect(automatic.evidence).toMatchObject({
        source: "fallback",
        ruleIds: [],
        applicableRuleIds: ["rule-1"],
        diagnostics: {
          path: "provider-unavailable",
          confirmation: { resolution: "automatic-deny" },
          enforcedEffect: "deny",
        },
      });
      const interactive = await evaluateSnapshotPolicy({
        ...options,
        confirmation: { defaultAction: "deny", threshold: 0 },
      });
      expect(interactive.effect).toBe("prompt");
      expect(interactive.evidence.diagnostics?.confirmation.resolution).toBe("pending");
      const configuredFailOpen = await evaluateSnapshotPolicy({
        ...options,
        confirmation: { defaultAction: "approve", threshold: 1 },
      });
      expect(configuredFailOpen.effect).toBe("allow");
      expect(configuredFailOpen.evidence.diagnostics?.confirmation.resolution).toBe(
        "automatic-approve",
      );
    }
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
    expect(decision.evidence.diagnostics?.path).toBe("provider-unavailable");
    expect(decision.evidence.ruleIds).toEqual([]);
  });

  test("deterministically allows actions when no compiled rule applies", async () => {
    const emptySnapshot = { ...snapshot, rules: [] };
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("write"),
      context: { headless: true },
      snapshot: emptySnapshot,
    });

    expect(decision).toMatchObject({
      effect: "allow",
      evidence: {
        evaluatorId: "compiled-policy-coverage",
        source: "deterministic",
        ruleIds: [],
        applicableRuleIds: [],
        diagnostics: { path: "no-applicable-rules" },
      },
    });
  });

  test("runs local denial before exclusions, semantic allows, and maintenance approval", async () => {
    const source = snapshot.sources[0];
    if (source === undefined) {
      throw new Error("Missing source fixture");
    }
    const protectedSnapshot = compilePolicySnapshot({
      projectRoot: snapshot.projectRoot,
      sources: [{ ...source, content: "Never read `.env`.", contentDigest: "protected" }],
      versions: snapshot.versions,
    });
    const action = {
      ...createTestPolicyAction("read"),
      targets: [{ kind: "path" as const, value: ".env" }],
      details: { path: ".env" },
      hostAction: { host: "omp", name: "read", input: { path: ".env" } },
    };
    let providerResolved = false;
    for (const semanticEnabled of [false, true]) {
      const decision = await evaluateSnapshotPolicy({
        action,
        snapshot: protectedSnapshot,
        context: { headless: false },
        semanticEnabled,
        maintenanceApproved: true,
        confirmation: { defaultAction: "approve", threshold: 0 },
        resolveModel: async () => {
          providerResolved = true;
          return policyModel(modelDecision("allow"));
        },
      });
      expect(decision.effect).toBe("deny");
      expect(decision.evidence.ruleIds).toEqual(protectedSnapshot.rules.map((rule) => rule.id));
      expect(decision.evidence.diagnostics?.path).toBe("local-denial");
    }
    expect(providerResolved).toBe(false);
  });

  test("bypasses completeness for tools excluded from semantic coverage", async () => {
    let providerResolved = false;
    const decision = await evaluateSnapshotPolicy({
      action: { ...createTestPolicyAction("unknown"), complete: false },
      snapshot,
      context: { headless: false },
      semanticEnabled: false,
      resolveModel: async () => {
        providerResolved = true;
        return undefined;
      },
    });
    expect(decision.effect).toBe("allow");
    expect(decision.evidence).toMatchObject({
      ruleIds: [],
      applicableRuleIds: ["rule-1"],
      diagnostics: { path: "coverage-bypass", enforcedEffect: "allow" },
    });
    expect(providerResolved).toBe(false);
  });

  test("only resolves maintenance approval for an assessed semantic confirmation", async () => {
    const options = {
      action: createTestPolicyAction("execute"),
      snapshot,
      context: { headless: true },
      model: policyModel(modelDecision("prompt")),
      confirmation: { defaultAction: "deny" as const, threshold: 1 },
    };
    expect((await evaluateSnapshotPolicy(options)).effect).toBe("deny");
    const approved = await evaluateSnapshotPolicy({ ...options, maintenanceApproved: true });
    expect(approved.effect).toBe("allow");
    expect(approved.evidence.diagnostics?.confirmation.resolution).toBe("maintenance-approved");
  });

  test("maintenance cannot override deny, incomplete, malformed, unavailable, or unassessed evidence", async () => {
    const outcomes: readonly PolicyModelResult[] = [
      { ...modelDecision("deny"), ruleIds: ["rule-1"] },
      { kind: "unavailable", reason: "offline" },
      { ...modelDecision("prompt"), confidence: Number.NaN },
      { ...modelDecision("prompt"), ruleIds: ["invented-rule"] },
    ];
    for (const outcome of outcomes) {
      const decision = await evaluateSnapshotPolicy({
        action: createTestPolicyAction("execute"),
        snapshot,
        context: { headless: true },
        model: policyModel(outcome),
        maintenanceApproved: true,
        confirmation: { defaultAction: "deny", threshold: 1 },
      });
      expect(decision.effect).toBe("deny");
      expect(decision.evidence.diagnostics?.confirmation.resolution).not.toBe(
        "maintenance-approved",
      );
      expect(decision.evidence.ruleIds).not.toContain("invented-rule");
    }
    let providerResolved = false;
    const incomplete = await evaluateSnapshotPolicy({
      action: { ...createTestPolicyAction("delegate"), complete: false },
      snapshot,
      context: { headless: true },
      maintenanceApproved: true,
      confirmation: { defaultAction: "approve", threshold: 0 },
      resolveModel: async () => {
        providerResolved = true;
        return policyModel(modelDecision("allow"));
      },
    });
    expect(incomplete.effect).toBe("deny");
    expect(incomplete.evidence.diagnostics?.path).toBe("incomplete-action");
    expect(providerResolved).toBe(false);
    const unassessed = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("execute"),
      context: { headless: true },
      maintenanceApproved: true,
      confirmation: { defaultAction: "deny", threshold: 1 },
    });
    expect(unassessed.effect).toBe("deny");
    expect(unassessed.evidence.diagnostics).toMatchObject({
      path: "provider-unavailable",
      semantic: { unavailableReason: "missing-snapshot" },
    });
  });

  test("unattributed semantic denials become uncertainty instead of invented violations", async () => {
    for (const ruleIds of [[], ["invented-rule"]]) {
      const options = {
        action: createTestPolicyAction("write"),
        snapshot,
        context: { headless: true },
        model: policyModel({
          ...modelDecision("deny"),
          confidence: 0.25,
          hardViolationProbability: 0.8,
          ruleIds,
        }),
      };
      const automatic = await evaluateSnapshotPolicy(options);
      expect(automatic.effect).toBe("allow");
      expect(automatic.evidence.ruleIds).toEqual([]);
      expect(automatic.evidence.diagnostics).toMatchObject({
        semantic: { adapterEffect: "prompt", decisionBasis: "ungrounded-denial" },
        confirmation: { resolution: "automatic-approve" },
      });
      expect(automatic.evidence.diagnostics?.decisiveRule).toBeUndefined();
      const strict = await evaluateSnapshotPolicy({
        ...options,
        confirmation: { defaultAction: "deny", threshold: 1 },
      });
      expect(strict.effect).toBe("deny");
      expect(strict.evidence.diagnostics?.confirmation.resolution).toBe("automatic-deny");
    }
  });

  test("a candidate citation cannot ground a denial when the provider rejects its attribution", async () => {
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("execute"),
      snapshot,
      context: { headless: true },
      model: policyModel({
        ...modelDecision("deny"),
        ruleIds: ["rule-1"],
        diagnostics: {
          status: "assessed",
          providerId: "fixture",
          requestedModel: "model-v1",
          attribution: "none",
        },
      }),
    });
    expect(decision.effect).toBe("allow");
    expect(decision.evidence.ruleIds).toEqual([]);
    expect(decision.evidence.diagnostics?.decisiveRule).toBeUndefined();
  });

  test("does not attribute all candidates when a model reports no decisive match", async () => {
    const decision = await evaluateSnapshotPolicy({
      action: createTestPolicyAction("execute"),
      snapshot,
      context: { headless: true },
      model: policyModel(modelDecision("allow")),
    });
    expect(decision.effect).toBe("allow");
    expect(decision.evidence.ruleIds).toEqual([]);
    expect(decision.evidence.applicableRuleIds).toEqual(["rule-1"]);
    expect(decision.evidence.diagnostics?.decisiveRule).toBeUndefined();
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

function modelDecision(
  effect: "allow" | "prompt" | "deny",
): Extract<PolicyModelResult, { kind: "decision" }> {
  return {
    kind: "decision",
    effect,
    confidence: 0.9,
    hardViolationProbability: effect === "deny" ? 0.9 : 0.1,
    model: "model-v1",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
