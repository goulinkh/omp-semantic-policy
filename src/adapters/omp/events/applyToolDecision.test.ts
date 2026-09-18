import { describe, expect, it } from "bun:test";
import type { PolicyDecision } from "../../../policy/index.js";
import { applyOmpToolDecision, type OmpDecisionContext } from "./applyToolDecision.js";
import { normalizeOmpToolCall } from "./normalizeToolCall.js";

const evidence = {
  evaluatorId: "test",
  source: "deterministic",
  ruleIds: ["test.rule"],
} as const;

describe("applyOmpToolDecision", () => {
  it("binds parallel blocks to their calls and never offers approval for a hard denial", async () => {
    const decision: PolicyDecision = {
      effect: "deny",
      reason: "Protected path",
      evidence,
    };
    let confirmationRequested = false;
    const context = {
      hasUI: true,
      ui: {
        confirm: async () => {
          confirmationRequested = true;
          return true;
        },
      },
    } satisfies OmpDecisionContext;
    const first = action("bash", "call-wc", { command: "wc -c dist/index.js" });
    const second = action("bash", "call-cat", { command: "cat private.txt" });
    const [wc, cat] = await Promise.all([
      applyOmpToolDecision(decision, context, first),
      applyOmpToolDecision(decision, context, second),
    ]);
    expect(wc?.block).toBe(true);
    expect(wc?.reason).toContain("wc -c dist/index.js");
    expect(wc?.reason).not.toContain("cat private.txt");
    expect(cat?.block).toBe(true);
    expect(cat?.reason).toContain("cat private.txt");
    expect(cat?.reason).not.toContain("wc -c dist/index.js");
    expect(wc?.reason).toContain("/policy audit");
    expect(wc?.reason).not.toContain("/policy maintenance");
    expect(confirmationRequested).toBe(false);
  });

  it("blocks an approval request without opening a dialog in a headless host", async () => {
    const decision: PolicyDecision = {
      effect: "prompt",
      reason: "No compiled policy is active",
      evidence,
    };
    let confirmationRequested = false;
    const context = {
      hasUI: false,
      ui: {
        confirm: async () => {
          confirmationRequested = true;
          return true;
        },
      },
    } satisfies OmpDecisionContext;
    const request = action("write", "call-headless", {
      path: "/safe/output.txt",
      content: "private write body",
    });
    const result = await applyOmpToolDecision(decision, context, request);
    expect(result?.block).toBe(true);
    expect(result?.reason).not.toContain(request.id);
    expect(result?.reason).toContain("/safe/output.txt");
    expect(result?.reason).not.toContain("private write body");
    expect(confirmationRequested).toBe(false);
  });

  it("keeps a rejected approval dialog and returned block bound to the same safe action", async () => {
    const confirmations: string[] = [];
    const decision: PolicyDecision = {
      effect: "prompt",
      reason: "Review required",
      evidence,
    };
    const context = {
      hasUI: true,
      ui: {
        confirm: async (_title: string, message: string) => {
          confirmations.push(message);
          return false;
        },
      },
    } satisfies OmpDecisionContext;
    const request = action("bash", "call-curl", {
      command: "TOKEN=private-value curl https://example.test",
    });
    const result = await applyOmpToolDecision(decision, context, request);
    expect(result?.block).toBe(true);
    expect(confirmations).toHaveLength(1);
    for (const feedback of [confirmations[0], result?.reason]) {
      expect(feedback).toContain("https://example.test");
      expect(feedback).not.toContain("private-value");
    }
  });

  it("allows only a prompt decision accepted by the user and keeps allows silent", async () => {
    let confirmationCount = 0;
    const context = {
      hasUI: true,
      ui: {
        confirm: async () => {
          confirmationCount += 1;
          return true;
        },
      },
    } satisfies OmpDecisionContext;
    const request = action("eval", "call-eval", { code: "privateProgram()" });
    await expect(
      applyOmpToolDecision({ effect: "allow", evidence }, context, request),
    ).resolves.toBeUndefined();
    expect(confirmationCount).toBe(0);
    await expect(
      applyOmpToolDecision(
        { effect: "prompt", reason: "Review required", evidence },
        context,
        request,
      ),
    ).resolves.toBeUndefined();
    expect(confirmationCount).toBe(1);
  });
});

function action(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return normalizeOmpToolCall(
    { type: "tool_call", toolName, toolCallId, input },
    { cwd: "/workspace/project", sessionManager: { getSessionId: () => "session-1" } },
  );
}
