import { describe, expect, it } from "bun:test";
import type { PolicyDecision } from "../../../policy/index.js";
import { applyOmpToolDecision, type OmpDecisionContext } from "./applyToolDecision.js";

const evidence = {
  evaluatorId: "test",
  source: "deterministic",
  ruleIds: ["test.rule"],
} as const;

describe("applyOmpToolDecision", () => {
  it("blocks a denied tool call with the policy reason", async () => {
    const decision: PolicyDecision = {
      effect: "deny",
      reason: "Protected path",
      evidence,
    };
    const context = {
      hasUI: false,
      ui: { confirm: async () => false },
    } satisfies OmpDecisionContext;

    await expect(applyOmpToolDecision(decision, context)).resolves.toEqual({
      block: true,
      reason: "Protected path",
    });
  });

  it("blocks an approval request when no interactive UI exists", async () => {
    const decision: PolicyDecision = {
      effect: "prompt",
      reason: "No compiled policy is active",
      evidence,
    };
    const context = {
      hasUI: false,
      ui: { confirm: async () => true },
    } satisfies OmpDecisionContext;

    await expect(applyOmpToolDecision(decision, context)).resolves.toEqual({
      block: true,
      reason:
        "Policy approval required but no interactive UI is available: No compiled policy is active",
    });
  });

  it("allows an interactive approval request accepted by the user", async () => {
    const confirmations: string[] = [];
    const decision: PolicyDecision = {
      effect: "prompt",
      reason: "Allow write?",
      evidence,
    };
    const context = {
      hasUI: true,
      ui: {
        confirm: async (title: string, message: string) => {
          confirmations.push(`${title}: ${message}`);
          return true;
        },
      },
    } satisfies OmpDecisionContext;

    await expect(applyOmpToolDecision(decision, context)).resolves.toBeUndefined();
    expect(confirmations).toEqual(["OMP Semantic Policy: Allow write?"]);
  });

  it("returns revised input for OMP to revalidate and execute", async () => {
    const decision: PolicyDecision = {
      effect: "revise",
      input: { path: "/safe/output.txt", content: "redacted" },
      reason: "Redirect output",
      evidence,
    };
    const context = {
      hasUI: false,
      ui: { confirm: async () => false },
    } satisfies OmpDecisionContext;

    await expect(applyOmpToolDecision(decision, context)).resolves.toEqual({
      input: { path: "/safe/output.txt", content: "redacted" },
    });
  });
});
