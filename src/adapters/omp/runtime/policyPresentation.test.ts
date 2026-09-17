import { describe, expect, test } from "bun:test";
import type { PolicyDecision } from "../../../policy/index.js";
import {
  createPolicyStatusBarController,
  formatPolicyDecisionFeedback,
  loadPolicyRuntimeSettings,
  stylePolicyDecisionFeedback,
  type PolicyStatusBarHost,
} from "./policyPresentation.js";

describe("policy session presentation", () => {
  test("moves extension status into OMP's native status segment", () => {
    let rightSegments: readonly string[] = ["usage", "session_name"];
    let hookRowsVisible = true;
    const host: PolicyStatusBarHost = {
      getLeftSegments: () => ["pi", "model"],
      getRightSegments: () => rightSegments,
      setRightSegments: (segments) => {
        rightSegments = segments;
      },
      setHookRowsVisible: (visible) => {
        hookRowsVisible = visible;
      },
    };

    const controller = createPolicyStatusBarController(host);
    controller.configure(true);
    controller.configure(true);

    expect(rightSegments).toEqual(["status", "usage", "session_name"]);
    expect(hookRowsVisible).toBe(false);
  });

  test("does not alter the status bar when policy status is hidden", () => {
    let changed = false;
    const host: PolicyStatusBarHost = {
      getLeftSegments: () => [],
      getRightSegments: () => [],
      setRightSegments: () => {
        changed = true;
      },
      setHookRowsVisible: () => {
        changed = true;
      },
    };

    createPolicyStatusBarController(host).configure(false);
    expect(changed).toBe(false);
  });

  test("supports native plugin runtime settings", async () => {
    expect(
      await loadPolicyRuntimeSettings("/workspace/project", {
        showStatus: false,
        showViolationFeedback: false,
        confirmationDefault: "approve",
        confirmationThreshold: 0.8,
        disabledToolCalls: ["bash", " write ", "bash"],
        enabledToolCalls: ["write", " read ", "write"],
      }),
    ).toEqual({
      showStatus: false,
      showViolationFeedback: false,
      confirmationDefault: "approve",
      confirmationThreshold: 0.8,
      disabledToolCalls: ["bash", "write"],
      enabledToolCalls: ["write", "read"],
    });
  });

  test("formats noncompliant decisions and stays silent for allowed actions", () => {
    expect(formatPolicyDecisionFeedback(decision("allow"))).toBeUndefined();
    expect(formatPolicyDecisionFeedback(decision("deny", "Secret publication is forbidden."))).toBe(
      "⛨ Policy: denied · Secret publication is forbidden.",
    );
    expect(formatPolicyDecisionFeedback(decision("prompt", "Review required."))).toBe(
      "⛨ Policy: warning · approval required · Review required.",
    );
  });

  test("uses criticality backgrounds for policy feedback", () => {
    const theme = {
      fgOnBg(foreground: string, background: string, text: string) {
        return `<fg:${foreground}:${background}>${text}</fg>`;
      },
      bold(text: string) {
        return `<bold>${text}</bold>`;
      },
      bgFill(background: string, text: string) {
        return `<bg:${background}>${text}</bg>`;
      },
    } as never;

    expect(stylePolicyDecisionFeedback("denied", decision("deny"), theme)).toBe(
      "<bg:toolErrorBg><bold><fg:error:toolErrorBg> denied </fg></bold></bg>",
    );
    expect(stylePolicyDecisionFeedback("approval", decision("prompt"), theme)).toBe(
      "<bg:toolPendingBg><bold><fg:warning:toolPendingBg> approval </fg></bold></bg>",
    );
  });
});

function decision(effect: "allow" | "deny" | "prompt", reason?: string): PolicyDecision {
  const evidence = {
    evaluatorId: "fixture",
    source: "semantic" as const,
    ruleIds: ["rule-1"],
  };
  return effect === "allow"
    ? { effect, evidence }
    : { effect, reason: reason ?? "Policy mismatch.", evidence };
}
