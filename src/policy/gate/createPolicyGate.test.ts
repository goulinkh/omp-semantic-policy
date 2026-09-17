import { describe, expect, it } from "bun:test";
import { createTestPolicyAction } from "../../../testing/createPolicyAction.js";
import { createPolicyGate } from "./createPolicyGate.js";

const evaluationContext = { headless: false } as const;

describe("createPolicyGate", () => {
  it("keeps the first deterministic decision without consulting the model", async () => {
    let semanticCalls = 0;
    const gate = createPolicyGate({
      deterministicEvaluators: [
        {
          id: "protected-path",
          source: "deterministic",
          evaluate: () => ({
            effect: "deny",
            reason: "Protected path",
            ruleIds: ["paths.protected"],
          }),
        },
      ],
      semanticEvaluator: {
        id: "policy-model",
        source: "semantic",
        evaluate: () => {
          semanticCalls += 1;
          return { effect: "allow" };
        },
      },
      fallbackEvaluator: {
        id: "fallback",
        evaluate: () => ({ effect: "allow" }),
      },
    });

    const decision = await gate.evaluate(createTestPolicyAction("write"), evaluationContext);

    expect(decision).toEqual({
      effect: "deny",
      reason: "Protected path",
      evidence: {
        evaluatorId: "protected-path",
        source: "deterministic",
        ruleIds: ["paths.protected"],
      },
    });
    expect(semanticCalls).toBe(0);
  });

  it("uses semantic evaluation after deterministic evaluators abstain", async () => {
    const gate = createPolicyGate({
      deterministicEvaluators: [
        {
          id: "no-match",
          source: "deterministic",
          evaluate: () => undefined,
        },
      ],
      semanticEvaluator: {
        id: "policy-model",
        source: "semantic",
        evaluate: () => ({
          effect: "prompt",
          reason: "Instruction meaning is ambiguous",
          ruleIds: ["instructions.ambiguous"],
        }),
      },
      fallbackEvaluator: {
        id: "fallback",
        evaluate: () => ({ effect: "allow" }),
      },
    });

    const decision = await gate.evaluate(createTestPolicyAction("execute"), evaluationContext);

    expect(decision.evidence).toEqual({
      evaluatorId: "policy-model",
      source: "semantic",
      ruleIds: ["instructions.ambiguous"],
    });
    expect(decision.effect).toBe("prompt");
  });

  it("uses the required fallback when every policy evaluator abstains", async () => {
    const gate = createPolicyGate({
      deterministicEvaluators: [],
      semanticEvaluator: {
        id: "policy-model",
        source: "semantic",
        evaluate: () => undefined,
      },
      fallbackEvaluator: {
        id: "fallback",
        evaluate: () => ({ effect: "deny", reason: "No decision available" }),
      },
    });

    const decision = await gate.evaluate(createTestPolicyAction("unknown"), evaluationContext);

    expect(decision).toEqual({
      effect: "deny",
      reason: "No decision available",
      evidence: {
        evaluatorId: "fallback",
        source: "fallback",
        ruleIds: [],
      },
    });
  });

  it("stops before evaluation when the action is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const gate = createPolicyGate({
      deterministicEvaluators: [],
      fallbackEvaluator: {
        id: "fallback",
        evaluate: () => ({ effect: "allow" }),
      },
    });

    await expect(
      gate.evaluate(createTestPolicyAction("read"), evaluationContext, controller.signal),
    ).rejects.toHaveProperty("name", "AbortError");
  });
});
