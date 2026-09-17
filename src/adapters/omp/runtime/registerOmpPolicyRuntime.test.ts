import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyModel, PolicyModelRequest, PolicyModelResult } from "../../../policy/index.js";
import { createPolicyRepository } from "../persistence/index.js";
import { registerOmpPolicyRuntime } from "./registerOmpPolicyRuntime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OMP policy runtime", () => {
  test("gates tool, direct command, slash, and workflow surfaces and records audits", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "profile", "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");

    const harness = createExtensionHarness();
    const modelRequests: PolicyModelRequest[] = [];
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      createPolicyModel: () => fixturePolicyModel(modelRequests),
    });
    const context = createContext(projectRoot);

    await harness.emit("session_start", { type: "session_start" }, context);
    harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Deploy with TOKEN=super-secret-value",
        systemPrompt: [],
      },
      context,
    );

    const toolCallResult = await harness.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "tool-1",
        toolName: "write",
        input: { path: "AGENTS.md", content: "Never publish secrets.\n" },
      },
      context,
    );
    expect(toolCallResult).toBeUndefined();
    expect(modelRequests.at(-1)?.authorization?.summary).toContain("[REDACTED]");

    await harness.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "tool-1",
        toolName: "write",
        input: { path: "AGENTS.md", content: "Never publish secrets.\n" },
        content: [],
        isError: false,
        details: undefined,
      },
      context,
    );

    const bashResult = await harness.emit<{ readonly result?: { readonly exitCode?: number } }>(
      "user_bash",
      { type: "user_bash", command: "publish-secret", excludeFromContext: false, cwd: projectRoot },
      context,
    );
    expect(bashResult?.result?.exitCode).toBe(126);

    const pythonResult = await harness.emit<{ readonly result?: { readonly exitCode?: number } }>(
      "user_python",
      {
        type: "user_python",
        code: "publish_secret()",
        excludeFromContext: false,
        cwd: projectRoot,
      },
      context,
    );
    expect(pythonResult?.result?.exitCode).toBe(1);

    const inputResult = await harness.emit(
      "input",
      { type: "input", text: "/model unsafe", source: "interactive" },
      context,
    );
    expect(inputResult).toEqual({ handled: true });

    const stopEvent = {
      type: "session_stop",
      messages: [],
      turn_id: 7,
      session_id: "session-1",
      stop_hook_active: false,
      signal: new AbortController().signal,
    };
    expect(
      await harness.emit<{ readonly decision: "block"; readonly reason: string }>(
        "session_stop",
        stopEvent,
        context,
      ),
    ).toEqual({
      decision: "block",
      reason: "Semantic policy denied the action (hard-rule probability 95%).",
    });
    expect(await harness.emit("session_stop", stopEvent, context)).toBeUndefined();

    await harness.emit("session_shutdown", { type: "session_shutdown" }, context);

    const repository = await createPolicyRepository(databasePath);
    const audits = repository.listAudits(await realpath(projectRoot));
    expect(audits.some((audit) => audit.phase === "result" && audit.outcome === "success")).toBe(
      true,
    );
    expect(
      audits.some((audit) => audit.operation === "execute" && audit.outcome === "blocked"),
    ).toBe(true);
    expect(audits.filter((audit) => audit.phase === "workflow")).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("super-secret-value");
    repository.close();
  });
});

type RuntimeHandler = (event: unknown, context: ExtensionContext) => unknown;

interface ExtensionHarness {
  readonly api: ExtensionAPI;
  emit<Result = unknown>(
    event: string,
    payload: unknown,
    context: ExtensionContext,
  ): Promise<Result | undefined>;
}

function createExtensionHarness(): ExtensionHarness {
  const handlers = new Map<string, RuntimeHandler>();
  const api = {
    registerProvider() {},
    setLabel() {},
    registerCommand() {},
    getAllTools() {
      return [];
    },
    on(event: string, handler: unknown) {
      if (typeof handler === "function") {
        handlers.set(event, handler as RuntimeHandler);
      }
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    async emit<Result>(event: string, payload: unknown, context: ExtensionContext) {
      const handler = handlers.get(event);
      if (handler === undefined) {
        return undefined;
      }
      return (await handler(payload, context)) as Result;
    },
  };
}

function createContext(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: {
      async confirm() {
        return true;
      },
      notify() {},
      setStatus() {},
    },
    sessionManager: {
      getSessionId() {
        return "session-1";
      },
    },
    modelRegistry: {
      async getApiKeyForProvider() {
        return "fixture-api-key";
      },
    },
  } as unknown as ExtensionContext;
}

function fixturePolicyModel(requests: PolicyModelRequest[]): PolicyModel {
  return {
    providerId: "fixture",
    modelVersion: "model-v1",
    async validate() {
      return { model: "model-v1", availableModels: ["model-v1"] };
    },
    async evaluate(request): Promise<PolicyModelResult> {
      requests.push(request);
      const allow = request.action.hostAction.name === "write";
      return {
        kind: "decision",
        effect: allow ? "allow" : "deny",
        confidence: 0.99,
        hardViolationProbability: allow ? 0.01 : 0.95,
        model: "model-v1",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}
