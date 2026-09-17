import { describe, expect, it } from "bun:test";
import { createTestPolicyAction } from "../../../testing/createPolicyAction.js";
import { createConservativeFallback } from "./createConservativeFallback.js";

const evaluationContext = { headless: false } as const;

describe("createConservativeFallback", () => {
  it("allows reads before a compiled policy exists", async () => {
    const decision = await createConservativeFallback().evaluate(
      createTestPolicyAction("read"),
      evaluationContext,
    );

    expect(decision).toEqual({
      effect: "allow",
      ruleIds: ["fallback.allow-non-mutating"],
    });
  });

  it("requires approval for a write before a compiled policy exists", async () => {
    const decision = await createConservativeFallback().evaluate(
      createTestPolicyAction("write"),
      evaluationContext,
    );

    expect(decision).toEqual({
      effect: "prompt",
      reason: "No compiled policy is active for write action fixture.",
      ruleIds: ["fallback.prompt-side-effect"],
    });
  });
});
