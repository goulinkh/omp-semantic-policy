import { describe, expect, it } from "bun:test";
import type { ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { normalizeOmpToolCall, type OmpToolNormalizationContext } from "./normalizeToolCall.js";

const context = {
  cwd: "/workspace/project",
  sessionManager: {
    getSessionId: () => "session-1",
  },
} satisfies OmpToolNormalizationContext;

const now = () => 1_700_000_000_000;

describe("normalizeOmpToolCall", () => {
  it("normalizes a local write as a precisely intercepted path action", () => {
    const event = {
      type: "tool_call",
      toolCallId: "write-1",
      toolName: "write",
      input: { path: "/workspace/project/file.ts", content: "export {};" },
    } satisfies ToolCallEvent;

    const action = normalizeOmpToolCall(event, context, { now });

    expect(action).toMatchObject({
      id: "write-1",
      occurredAtMs: 1_700_000_000_000,
      workingDirectory: "/workspace/project",
      operation: "write",
      interception: "precise",
      targets: [{ kind: "path", value: "/workspace/project/file.ts" }],
      actor: { kind: "agent", sessionId: "session-1" },
      hostAction: { host: "omp", name: "write" },
    });
  });

  it("marks shell execution as dispatch-gated and preserves its command target", () => {
    const event = {
      type: "tool_call",
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "git status --short" },
    } satisfies ToolCallEvent;

    const action = normalizeOmpToolCall(event, context, { now });

    expect(action.operation).toBe("execute");
    expect(action.interception).toBe("dispatch-only");
    expect(action.targets).toEqual([{ kind: "command", value: "git status --short" }]);
  });

  it("marks a device-backed write as dispatch-gated", () => {
    const event = {
      type: "tool_call",
      toolCallId: "write-device-1",
      toolName: "write",
      input: { path: "xd://lsp", content: "{}" },
    } satisfies ToolCallEvent;

    const action = normalizeOmpToolCall(event, context, { now });

    expect(action.operation).toBe("write");
    expect(action.interception).toBe("dispatch-only");
  });

  it("treats an unknown custom tool as a dispatch-gated unknown operation", () => {
    const event = {
      type: "tool_call",
      toolCallId: "custom-1",
      toolName: "third_party_mutation",
      input: { resource: "example" },
    } satisfies ToolCallEvent;

    const action = normalizeOmpToolCall(event, context, { now });

    expect(action.operation).toBe("unknown");
    expect(action.interception).toBe("dispatch-only");
    expect(action.targets).toEqual([{ kind: "tool", value: "third_party_mutation" }]);
  });
});
