import { describe, expect, test } from "bun:test";
import { normalizeOmpToolCall } from "../events/normalizeToolCall.js";
import { redactText } from "../../typesafe/redactProviderState.js";
import { bindRequestAuthorization } from "./bindRequestAuthorization.js";

function authorize(request: string, command: string, extra: Record<string, unknown> = {}) {
  const action = normalizeOmpToolCall(
    {
      type: "tool_call",
      toolCallId: "proposal",
      toolName: "bash",
      input: { command, ...extra },
    },
    { cwd: "/workspace/project", sessionManager: { getSessionId: () => "session" } },
  );
  return bindRequestAuthorization(
    action,
    {
      source: "current-turn",
      explicit: false,
      scope: "request",
      summary: redactText(request),
    },
    request,
  );
}

describe("exact command requests", () => {
  test("binds a complete affirmative request but not a compound safe prefix", () => {
    expect(
      authorize(
        "Run bun install --frozen-lockfile in this project.",
        "bun install --frozen-lockfile",
      )?.scope,
    ).toBe("exact-action");
    expect(
      authorize("Run `bun --version && omp plugin link .`.", "bun --version && omp plugin link .")
        ?.scope,
    ).toBe("exact-action");
    expect(authorize("Run bun --version.", "bun --version && omp plugin link .")?.scope).toBe(
      "request",
    );
  });

  test("does not promote negation, quoted examples, or hidden environment and directory effects", () => {
    expect(authorize("Do not run pwd.", "pwd")?.scope).toBe("request");
    expect(authorize("Explain the example: Run pwd.", "pwd")?.scope).toBe("request");
    expect(authorize("Run pwd, but do not execute it yet.", "pwd")?.scope).toBe("request");
    expect(authorize("Run pwd.", "pwd", { env: { BASH_ENV: "hidden.sh" } })?.scope).toBe("request");
    expect(authorize("Run pwd.", "pwd", { cwd: "/elsewhere" })?.scope).toBe("request");
  });

  test("does not equate different original credentials after redaction", () => {
    const first = "echo TOKEN=fixture-alpha";
    const second = "echo TOKEN=fixture-beta";
    expect(redactText(first)).toBe(redactText(second));
    expect(authorize(`Run ${first}.`, second)?.scope).toBe("request");
  });
});
