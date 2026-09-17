import { describe, expect, it } from "bun:test";
import { createTestPolicyAction } from "../../../testing/createPolicyAction.js";
import { createConservativeFallback } from "./createConservativeFallback.js";

const evaluationContext = { headless: false } as const;

describe("createConservativeFallback", () => {
  it("allows reads when semantic policy is unavailable", async () => {
    const decision = await createConservativeFallback().evaluate(
      createTestPolicyAction("read"),
      evaluationContext,
    );

    expect(decision).toEqual({
      effect: "allow",
      ruleIds: ["fallback.allow-non-mutating"],
    });
  });

  it("requires approval for a write when semantic policy is unavailable", async () => {
    const decision = await createConservativeFallback().evaluate(
      createTestPolicyAction("write"),
      evaluationContext,
    );

    expect(decision).toEqual({
      effect: "prompt",
      reason:
        "The semantic evaluator is unavailable, so this write action was not classified as compliant or noncompliant. Explicit approval is required before fixture can run.",
      ruleIds: ["fallback.prompt-side-effect"],
    });
  });
});
