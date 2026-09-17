import type { InterceptionCapability, PolicyAction, PolicyOperation } from "../src/policy/index.js";

export function createTestPolicyAction(
  operation: PolicyOperation,
  interception: InterceptionCapability = "precise",
): PolicyAction {
  return {
    id: "tool-call-1",
    occurredAtMs: 1_700_000_000_000,
    actor: {
      kind: "agent",
      sessionId: "session-1",
    },
    workingDirectory: "/workspace/project",
    operation,
    interception,
    complete: true,
    details: {},
    targets: [{ kind: "tool", value: "fixture" }],
    hostAction: {
      host: "test",
      name: "fixture",
      input: {},
    },
  };
}
