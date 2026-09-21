import { describe, expect, test } from "bun:test";
import type { PolicyDecision } from "../../../policy/index.js";
import { normalizeOmpToolCall } from "../events/normalizeToolCall.js";
import {
  createPolicyStatusBarController,
  formatPolicyDecisionFeedback,
  loadPolicyRuntimeSettings,
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
        toolOperations: {
          launchpad: "read",
          launchpad_write: "execute",
          read: "execute",
        },
      }),
    ).toEqual({
      showStatus: false,
      showViolationFeedback: false,
      confirmationDefault: "approve",
      confirmationThreshold: 0.8,
      disabledToolCalls: ["bash", "write"],
      enabledToolCalls: ["write", "read"],
      toolOperations: {
        launchpad: "read",
        launchpad_write: "execute",
        read: "execute",
      },
    });
  });

  test("normalizes string and JSON extension tool operation mappings", async () => {
    expect(
      (
        await loadPolicyRuntimeSettings("/workspace/project", {
          toolOperations: "launchpad=read, launchpad_write=execute, unsupported=invalid",
        })
      ).toolOperations,
    ).toEqual({
      launchpad: "read",
      launchpad_write: "execute",
    });
    expect(
      (
        await loadPolicyRuntimeSettings("/workspace/project", {
          toolOperations: '{"mcp_read":"read","mcp_write":"write"}',
        })
      ).toolOperations,
    ).toEqual({
      mcp_read: "read",
      mcp_write: "write",
    });
  });

  test("keeps action summaries distinct without technical identifiers and keeps allows silent", () => {
    const wc = action("bash", "call-wc", { command: "wc -c dist/index.js" });
    const build = action("bash", "call-build", { command: "bun run build" });
    expect(formatPolicyDecisionFeedback(decision("allow"), wc)).toBeUndefined();
    const blocked = formatPolicyDecisionFeedback(decision("deny"), wc);
    expect(blocked).toContain("wc -c dist/index.js");
    expect(blocked).not.toContain(wc.id);
    expect(blocked).not.toContain("bun run build");
    const prompt = formatPolicyDecisionFeedback(decision("prompt"), build);
    expect(prompt).toContain("bun run build");
    expect(prompt).not.toContain(build.id);
    expect(prompt).not.toContain(wc.id);
    expect(blocked).toContain("/policy audit");
    expect(prompt).toContain("/policy audit");
    expect(prompt).not.toContain("/policy maintenance");
  });

  test("shows the dispatched working directory and override names without environment values", () => {
    const request = action("bash", "call-marketplace", {
      command: "omp --profile smoke plugin marketplace add /workspace/project",
      cwd: "/tmp/marketplace-smoke",
      env: { HOME: "/private/temporary-home", TYPESAFE_API_KEY: "private-provider-key" },
    });
    const feedback = formatPolicyDecisionFeedback(decision("deny"), request);
    expect(feedback).toContain("/tmp/marketplace-smoke");
    expect(feedback).toContain("HOME");
    expect(feedback).toContain("TYPESAFE_API_KEY");
    expect(feedback).not.toContain("/private/temporary-home");
    expect(feedback).not.toContain("private-provider-key");
  });

  test("redacts credentials and strips terminal injection before displaying bounded feedback", () => {
    const request = action("bash", "call-\u202ewc", {
      command: "\u001b]52;c;clipboard-secret\u0007TOKEN=command-secret curl https://example.test",
      env: { PASSWORD: "environment-secret" },
    });
    const feedback = formatPolicyDecisionFeedback(
      decision("deny", "\u001b[31mTOKEN=reason-secret\u001b[0m\nReview\u0000 required"),
      request,
    );
    expect(feedback).toContain("curl https://example.test");
    expect(feedback).toContain("[REDACTED:");
    expect(
      Array.from(feedback ?? "").some((character) => {
        const code = character.charCodeAt(0);
        return (
          code <= 8 || (code >= 11 && code <= 31) || (code >= 127 && code <= 159) || code === 0x202e
        );
      }),
    ).toBe(false);
    for (const secret of [
      "command-secret",
      "environment-secret",
      "reason-secret",
      "clipboard-secret",
    ])
      expect(feedback).not.toContain(secret);
    const longPath = action("write", "call-long", { path: `/tmp/${"a".repeat(5_000)}` });
    const bounded = formatPolicyDecisionFeedback(decision("deny"), longPath);
    expect(bounded).not.toContain(longPath.id);
    expect(bounded).toContain("/tmp/");
    expect(bounded?.length).toBeLessThan(1_000);
  });

  test("never exposes eval programs, write bodies, or inline shell programs in action summaries", () => {
    const evaluation = action("eval", "call-eval", { code: "privateEvalProgram()" });
    const writing = action("write", "call-write", {
      path: "/tmp/output.txt",
      content: "private write body",
    });
    const shell = action("bash", "call-python", {
      command: `python -c 'privateShellProgram()'`,
    });
    const heredoc = action("bash", "call-heredoc", {
      command: "python <<'EOF'\nprivateHereDocProgram()\nEOF",
    });
    expect(formatPolicyDecisionFeedback(decision("deny"), evaluation)).not.toContain(
      "privateEvalProgram",
    );
    const writeFeedback = formatPolicyDecisionFeedback(decision("deny"), writing);
    expect(writeFeedback).toContain("/tmp/output.txt");
    expect(writeFeedback).not.toContain("private write body");
    const shellFeedback = formatPolicyDecisionFeedback(decision("deny"), shell);
    expect(shellFeedback).toContain("python");
    expect(shellFeedback).not.toContain("privateShellProgram");
    expect(formatPolicyDecisionFeedback(decision("deny"), heredoc)).not.toContain(
      "privateHereDocProgram",
    );
  });

  test("shows grounded decisive provenance without suggesting approval of hard denials", () => {
    const denied: PolicyDecision = {
      effect: "deny",
      reason: "Protected path",
      evidence: {
        evaluatorId: "local",
        source: "deterministic",
        ruleIds: ["hard.rule"],
        diagnostics: {
          path: "local-denial",
          decisiveRule: {
            ruleId: "hard.rule",
            sourceId: "project-policy",
            sourcePath: "/workspace/project/docs/standards.md",
            statement: "Disable access checks.",
            context: ["Runtime standards", "Preserve authorization", "Don't"],
          },
          confirmation: { resolution: "not-required" },
          enforcedEffect: "deny",
        },
      },
    };
    const feedback = formatPolicyDecisionFeedback(
      denied,
      action("write", "call-protected", { path: "/project/AGENTS.md" }),
    );
    expect(feedback).toContain("Disable access checks.");
    expect(feedback).toMatch(/Not allowed: Disable access checks/u);
    expect(feedback).toContain("Preserve authorization");
    expect(feedback).toContain("docs/standards.md");
    expect(feedback).not.toContain("/workspace/project");
    expect(feedback).not.toContain("hard.rule");
    expect(feedback).not.toContain("project-policy");
    expect(feedback).toContain("\n\n");
    expect(feedback).toContain("/policy audit");
    expect(feedback).not.toMatch(/confirm|approve|\/policy maintenance/iu);
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

function action(toolName: string, toolCallId: string, input: Record<string, unknown>) {
  return normalizeOmpToolCall(
    { type: "tool_call", toolName, toolCallId, input },
    { cwd: "/workspace/project", sessionManager: { getSessionId: () => "session-1" } },
  );
}
