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
  test("gates tool, direct command, and workflow surfaces and records audits", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "profile", "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");

    const harness = createExtensionHarness();
    const modelRequests: PolicyModelRequest[] = [];
    const notifications: string[] = [];
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      createPolicyModel: () => fixturePolicyModel(modelRequests),
      runtimeSettings: { showStatus: false, showViolationFeedback: true },
    });
    const context = createContext(projectRoot, [], { notifications });

    await harness.emit("session_start", { type: "session_start" }, context);
    await harness.emit(
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
    expect(notifications.some((message) => message.includes("⛨ Policy: denied ·"))).toBe(true);

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

  test("uses an enabled allowlist and gives disabled tool names precedence", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-tool-overrides-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "profile", "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");

    const modelRequests: PolicyModelRequest[] = [];
    const harness = createExtensionHarness();
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      createPolicyModel: () => fixturePolicyModel(modelRequests),
      runtimeSettings: {
        showStatus: false,
        showViolationFeedback: false,
        confirmationDefault: "deny",
        confirmationThreshold: 1,
        enabledToolCalls: ["bash", "write"],
        disabledToolCalls: ["bash"],
      },
    });
    const context = createContext(projectRoot);

    await harness.emit("session_start", { type: "session_start" }, context);
    const disabledResult = await harness.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "disabled-bash",
        toolName: "bash",
        input: { command: "publish-secret" },
      },
      context,
    );
    const outsideAllowlistResult = await harness.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "unlisted-read",
        toolName: "read",
        input: { path: "AGENTS.md" },
      },
      context,
    );
    const enabledResult = await harness.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "enabled-write",
        toolName: "write",
        input: { path: "notes.txt", content: "safe\n" },
      },
      context,
    );
    await harness.emit("session_shutdown", { type: "session_shutdown" }, context);

    expect(disabledResult).toBeUndefined();
    expect(outsideAllowlistResult).toBeUndefined();
    expect(enabledResult).toBeUndefined();
    expect(modelRequests.map((request) => request.action.hostAction.name)).toEqual(["write"]);
  });

  test("feeds model-selected project and runtime standards into onboarding", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-standards-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "profile", "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await mkdir(join(projectRoot, "guidance"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");
    await writeFile(join(projectRoot, "guidance", "engineering.md"), "Always run checks.\n");

    const harness = createExtensionHarness();
    let scanPrompt = "";
    let scanCount = 0;
    let markManualScanStarted!: () => void;
    const manualScanStarted = new Promise<void>((resolve) => {
      markManualScanStarted = resolve;
    });
    let releaseManualScan!: () => void;
    const manualScanRelease = new Promise<void>((resolve) => {
      releaseManualScan = resolve;
    });
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      runtimeSettings: { showStatus: false, showViolationFeedback: true },
      standardsCompletion: async (prompt) => {
        scanCount += 1;
        scanPrompt = prompt;
        if (scanCount === 2) {
          markManualScanStarted();
          await manualScanRelease;
        }
        return JSON.stringify({
          projectPaths: ["guidance/engineering.md"],
          runtimeExcerpts: [{ blockId: 0, text: "Skill standard: Never skip review." }],
        });
      },
    });
    const notifications: string[] = [];
    const editorTexts: string[] = [];
    const widgets: Array<"component" | readonly string[] | undefined> = [];
    const scheduledCallbacks: Array<() => unknown> = [];
    const context = createContext(projectRoot, [], {
      notifications,
      scheduledCallbacks,
      initialEditorText: "/policy onboard",
      editorTexts,
      widgets,
    });
    await harness.emit("session_start", { type: "session_start" }, context);
    await harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Implement the feature.",
        systemPrompt: ["Skill standard: Never skip review."],
      },
      context,
    );
    expect(notifications).toEqual(["⛨ Policy onboarding started."]);
    expect(editorTexts).toEqual([""]);
    expect(widgets).toEqual(["component"]);

    await harness.runCommand("policy", "onboard", context);
    expect(notifications.at(-1)).toBe("⛨ Policy onboarding is already in progress.");
    const scheduledOnboarding = scheduledCallbacks.shift();
    if (scheduledOnboarding === undefined) {
      throw new Error("Manual onboarding was not scheduled");
    }
    const onboardingFinished = Promise.resolve(scheduledOnboarding());
    await manualScanStarted;
    releaseManualScan();
    await onboardingFinished;
    await harness.emit("session_shutdown", { type: "session_shutdown" }, context);

    const repository = await createPolicyRepository(databasePath);
    const snapshot = repository.getActiveSnapshot(await realpath(projectRoot));
    expect(scanPrompt).toContain("guidance/engineering.md");
    expect(scanCount).toBe(2);
    expect(notifications[0]).toBe("⛨ Policy onboarding started.");
    expect(notifications[1]).toBe("⛨ Policy onboarding is already in progress.");
    expect(notifications.at(-1)).toContain("⛨ ✅ Policy active");
    expect(editorTexts).toEqual(["", "", ""]);
    expect(snapshot?.sources).toHaveLength(3);
    expect(widgets.at(-1)).toBeUndefined();
    expect(snapshot?.sources.some((source) => source.path.startsWith("runtime://"))).toBe(true);
    expect(snapshot?.rules.map((rule) => rule.statement)).toContain("Always run checks.");
    expect(snapshot?.rules.map((rule) => rule.statement)).toContain(
      "Skill standard: Never skip review.",
    );
    repository.close();
  });

  test("asks for confirmation when confidence reaches the configured threshold", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-confirmation-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Ask before publishing files.\n");

    const confirmations: string[] = [];
    const harness = createExtensionHarness();
    registerOmpPolicyRuntime(harness.api, {
      databasePath: join(fixture, "policy.db"),
      profileInstructionPaths: [],
      createPolicyModel: promptPolicyModel,
      runtimeSettings: {
        showStatus: false,
        showViolationFeedback: false,
        confirmationDefault: "deny",
        confirmationThreshold: 0.8,
      },
    });
    const context = createContext(projectRoot, [], { confirmations });

    await harness.emit("session_start", { type: "session_start" }, context);
    const result = await harness.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "publish",
        toolName: "write",
        input: { path: "release.txt", content: "ready\n" },
      },
      context,
    );
    await harness.emit("session_shutdown", { type: "session_shutdown" }, context);

    expect(result).toBeUndefined();
    expect(confirmations.at(-1)).toBe("🔐 Confirmation required · high confidence · 90%");
  });

  test("suppresses noncompliance notifications when feedback is disabled", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-silent-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");

    const notifications: string[] = [];
    const harness = createExtensionHarness();
    registerOmpPolicyRuntime(harness.api, {
      databasePath: join(fixture, "policy.db"),
      profileInstructionPaths: [],
      createPolicyModel: () => fixturePolicyModel([]),
      runtimeSettings: { showStatus: false, showViolationFeedback: false },
    });
    const context = createContext(projectRoot, [], { notifications });

    await harness.emit("session_start", { type: "session_start" }, context);
    await harness.emit(
      "user_bash",
      {
        type: "user_bash",
        command: "publish-secret",
        excludeFromContext: false,
        cwd: projectRoot,
      },
      context,
    );
    await harness.emit("session_shutdown", { type: "session_shutdown" }, context);

    expect(notifications).toEqual([]);
  });

  test("explains how to configure a missing semantic evaluator credential", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-login-required-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");

    const notifications: string[] = [];
    const confirmations: string[] = [];
    const harness = createExtensionHarness();
    registerOmpPolicyRuntime(harness.api, {
      databasePath: join(fixture, "policy.db"),
      profileInstructionPaths: [],
      runtimeSettings: {
        showStatus: false,
        showViolationFeedback: true,
        confirmationDefault: "deny",
        confirmationThreshold: 1,
      },
    });
    const context = createContext(projectRoot, [], {
      notifications,
      confirmations,
      providerApiKey: null,
    });

    await harness.emit("session_start", { type: "session_start" }, context);
    const result = await harness.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "safe-bash",
        toolName: "bash",
        input: { command: "printf '%s\\n' safe-test-value" },
      },
      context,
    );
    await harness.runCommand("policy", "status", context);
    await harness.emit("session_shutdown", { type: "session_shutdown" }, context);

    expect(result).toEqual({
      block: true,
      reason:
        "⛨ TypeSafe login required. Run /login typesafe-ai or set TYPESAFE_API_KEY. This execute action remains unclassified and was denied by confirmation settings.",
    });
    expect(notifications[0]).toContain(
      "TypeSafe login required. Run /login typesafe-ai or set TYPESAFE_API_KEY.",
    );
    expect(confirmations.every((message) => !message.includes("TypeSafe login required."))).toBe(
      true,
    );
    expect(notifications.at(-1)).toContain(
      "Evaluator login required (/login typesafe-ai or TYPESAFE_API_KEY)",
    );
  });
});

type RuntimeHandler = (event: unknown, context: ExtensionContext) => unknown;
type RuntimeCommandHandler = (args: string, context: ExtensionContext) => unknown;

interface ExtensionHarness {
  readonly api: ExtensionAPI;
  emit<Result = unknown>(
    event: string,
    payload: unknown,
    context: ExtensionContext,
  ): Promise<Result | undefined>;
  runCommand(name: string, args: string, context: ExtensionContext): Promise<void>;
}

function createExtensionHarness(): ExtensionHarness {
  const handlers = new Map<string, RuntimeHandler>();
  const commands = new Map<string, RuntimeCommandHandler>();
  const api = {
    registerProvider() {},
    setLabel() {},
    registerCommand(name: string, options: unknown) {
      if (
        typeof options === "object" &&
        options !== null &&
        "handler" in options &&
        typeof options.handler === "function"
      ) {
        commands.set(name, options.handler as RuntimeCommandHandler);
      }
    },
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
    async runCommand(name, args, context) {
      const handler = commands.get(name);
      if (handler === undefined) {
        throw new Error(`Command ${name} is not registered`);
      }
      await handler(args, context);
    },
  };
}

interface ContextObservations {
  readonly notifications?: string[];
  readonly statuses?: Array<string | undefined>;
  readonly confirmations?: string[];
  readonly providerApiKey?: string | null;
  readonly workingMessages?: Array<string | undefined>;
  readonly scheduledCallbacks?: Array<() => unknown>;
  readonly initialEditorText?: string;
  readonly editorTexts?: string[];
  readonly widgets?: Array<"component" | readonly string[] | undefined>;
}

function createContext(
  cwd: string,
  systemPrompt: readonly string[] = [],
  observations: ContextObservations = {},
): ExtensionContext {
  let editorText = observations.initialEditorText ?? "";
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    getSystemPrompt() {
      return systemPrompt;
    },
    setTimeout(callback: (...args: unknown[]) => void, _ms = 0, ...args: unknown[]) {
      observations.scheduledCallbacks?.push(() => callback(...args));
      return 0 as unknown as Timer;
    },
    ui: {
      theme: {
        fgOnBg(_foreground: string, _background: string, text: string) {
          return text;
        },
        bold(text: string) {
          return text;
        },
        bgFill(_background: string, text: string) {
          return text;
        },
      },
      setEditorText(text: string) {
        editorText = text;
        observations.editorTexts?.push(text);
      },
      getEditorText() {
        return editorText;
      },
      setWidget(_key: string, content: readonly string[] | (() => unknown) | undefined) {
        observations.widgets?.push(typeof content === "function" ? "component" : content);
      },
      async confirm(_title: string, message: string) {
        observations.confirmations?.push(message);
        return true;
      },
      notify(message: string) {
        observations.notifications?.push(message);
      },
      setStatus(_key: string, value: string | undefined) {
        observations.statuses?.push(value);
      },
      setWorkingMessage(message?: string) {
        observations.workingMessages?.push(message);
      },
    },
    sessionManager: {
      getSessionId() {
        return "session-1";
      },
    },
    modelRegistry: {
      async getApiKeyForProvider() {
        return observations.providerApiKey === null
          ? undefined
          : (observations.providerApiKey ?? "fixture-api-key");
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

function promptPolicyModel(): PolicyModel {
  return {
    providerId: "fixture",
    modelVersion: "model-v1",
    async validate() {
      return { model: "model-v1", availableModels: ["model-v1"] };
    },
    async evaluate(): Promise<PolicyModelResult> {
      return {
        kind: "decision",
        effect: "prompt",
        confidence: 0.9,
        hardViolationProbability: 0.1,
        model: "model-v1",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}
