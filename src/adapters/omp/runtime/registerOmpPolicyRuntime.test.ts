import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyModel, PolicyModelRequest, PolicyModelResult } from "../../../policy/index.js";
import { createPolicyRepository } from "../persistence/index.js";
import { createRedactedProviderState } from "../../typesafe/redactProviderState.js";
import {
  registerOmpPolicyRuntime,
  type OmpPolicyRuntimeOptions,
} from "./registerOmpPolicyRuntime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OMP policy runtime", () => {
  test("coalesces duplicate registrations and concurrent deliveries without losing local denials", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-duplicate-runtime-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(
      join(projectRoot, "AGENTS.md"),
      "Never read or modify protected.txt. User requests do not override this prohibition.\n\nOrdinary local file writes outside protected.txt are allowed.\n",
    );
    const repository = await createPolicyRepository(databasePath);
    repository.setRemoteConsent(true);
    const requests: PolicyModelRequest[] = [];
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const options = {
      databasePath,
      profileInstructionPaths: [],
      runtimeSettings: { showStatus: false },
      createPolicyModel: (): PolicyModel => ({
        ...fixturePolicyModel(requests),
        async evaluate(request) {
          requests.push(request);
          started.resolve();
          await release.promise;
          return {
            kind: "decision",
            effect: requests.length === 1 ? "allow" : "deny",
            confidence: 0.99,
            hardViolationProbability: requests.length === 1 ? 0.01 : 0.99,
            ruleIds: request.snapshot.rules.slice(0, 1).map((rule) => rule.id),
            model: "fixture",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
    };
    const first = createExtensionHarness();
    const second = createExtensionHarness();
    registerOmpPolicyRuntime(first.api, options);
    registerOmpPolicyRuntime(first.api, options);
    // A distinct API mirrors independently loaded source/bundle extensions.
    registerOmpPolicyRuntime(second.api, options);
    const context = createContext(projectRoot);
    const start = { type: "session_start" };
    await first.emit("session_start", start, context);
    await second.emit("session_start", start, context);
    const event = {
      type: "tool_call",
      toolCallId: "shared-write",
      toolName: "write",
      input: { path: "ordinary.txt", content: "hello" },
    };
    const pending = first.emit("tool_call", event, context);
    try {
      await started.promise;
      const duplicate = second.emit("tool_call", { ...event }, { ...context });
      release.resolve();
      expect(await pending).toBeUndefined();
      expect(await duplicate).toBeUndefined();
      expect(await first.emit("tool_call", { ...event }, context)).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(
        await second.emit(
          "tool_call",
          {
            ...event,
            input: { ...event.input, content: "changed" },
          },
          context,
        ),
      ).toMatchObject({ block: true });

      // Nested routed dispatches can legitimately reuse an ID under a new name.
      const nested = { ...event, toolName: "read", input: { path: "ordinary.txt" } };
      expect(await second.emit("tool_call", nested, context)).toBeUndefined();
      const result = { ...event, type: "tool_result", content: [], isError: false };
      await Promise.all([
        first.emit("tool_result", result, context),
        second.emit("tool_result", { ...result }, { ...context }),
      ]);
      await first.emit(
        "tool_result",
        { ...nested, type: "tool_result", content: [], isError: false },
        context,
      );
      await second.emit("tool_call", event, context);
      await second.emit("tool_result", result, context);
      const protectedCall = {
        type: "tool_call",
        toolCallId: "protected",
        toolName: "read",
        input: { path: "protected.txt" },
      };
      expect(await first.emit("tool_call", protectedCall, context)).toMatchObject({ block: true });
      expect(await second.emit("tool_call", { ...protectedCall }, context)).toMatchObject({
        block: true,
      });
      const audits = repository.listAudits(await realpath(projectRoot));
      expect(
        audits.filter((audit) => audit.actionId === event.toolCallId && audit.phase === "decision"),
      ).toHaveLength(2);
      expect(
        audits.filter(
          (audit) => audit.actionId === event.toolCallId && audit.outcome === "success",
        ),
      ).toHaveLength(2);
      expect(
        audits.filter((audit) => audit.actionId === "protected" && audit.phase === "decision"),
      ).toMatchObject([{ effect: "deny", diagnostics: { path: "local-denial" } }]);
      expect(
        audits.filter((audit) => audit.actionId === "protected" && audit.phase === "result"),
      ).toMatchObject([{ outcome: "blocked" }]);

      // Same ID cannot carry an old approval across an external policy edit.
      await writeFile(join(projectRoot, "AGENTS.md"), "Never read or modify ordinary.txt.\n");
      expect(await first.emit("tool_call", event, context)).toMatchObject({ block: true });
      expect(
        await first.emit("tool_call", { ...event, toolCallId: "after-policy-change" }, context),
      ).toMatchObject({ block: true });
    } finally {
      release.resolve();
      await pending;
      await first.emit("session_shutdown", { type: "session_shutdown" }, context);
      await second.emit("session_shutdown", { type: "session_shutdown" }, context);
      repository.close();
    }
  });

  test("assesses original source per dispatch, coalesces duplicates, and keeps source out of audits", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-source-context-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(
      join(projectRoot, "AGENTS.md"),
      "Never modify a record whose original lifecycle is frozen.\n",
    );
    const target = join(await realpath(projectRoot), "record.ts");
    const editableSource = "lifecycle=editable\nrecord=old\n";
    const frozenSource = "lifecycle=frozen\nrecord=old\n";
    await writeFile(target, editableSource);
    const repository = await createPolicyRepository(databasePath);
    repository.setRemoteConsent(true);
    const requests: PolicyModelRequest[] = [];
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const options = {
      databasePath,
      profileInstructionPaths: [],
      runtimeSettings: { showStatus: false },
      createPolicyModel: (): PolicyModel => ({
        ...fixturePolicyModel(requests),
        async evaluate(request) {
          requests.push(request);
          started.resolve();
          await release.promise;
          const source = request.action.details.sourceContext as
            | {
                readonly phase: string;
                readonly files: readonly {
                  readonly status: string;
                  readonly ranges?: readonly { readonly text: string }[];
                }[];
              }
            | undefined;
          if (
            source?.phase !== "before" ||
            source.files.length !== 1 ||
            source.files[0]?.status !== "included"
          ) {
            return { kind: "unavailable", reason: "Original lifecycle cannot be assessed." };
          }
          const original = source.files[0].ranges?.map((range) => range.text).join("\n") ?? "";
          const frozen = original.includes("lifecycle=frozen");
          return {
            kind: "decision",
            effect: frozen ? "deny" : "allow",
            confidence: 0.99,
            hardViolationProbability: frozen ? 0.99 : 0.01,
            ruleIds: frozen ? request.snapshot.rules.slice(0, 1).map((rule) => rule.id) : [],
            model: this.modelVersion,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
    };
    const first = createExtensionHarness();
    const second = createExtensionHarness();
    registerOmpPolicyRuntime(first.api, options);
    registerOmpPolicyRuntime(second.api, options);
    const confirmations: string[] = [];
    const context = createContext(projectRoot, [], { confirmations });
    const start = { type: "session_start" };
    await first.emit("session_start", start, context);
    await second.emit("session_start", start, context);
    const openFile = fs.open;
    let sourceReads = 0;
    const sourceAccess = spyOn(fs, "open").mockImplementation(async (path, ...args) => {
      if (String(path) === target) sourceReads += 1;
      return openFile(path, ...args);
    });
    const event = {
      type: "tool_call",
      toolCallId: "editable-record",
      toolName: "edit",
      input: { path: "record.ts", old_string: "record=old", new_string: "record=new" },
    };
    const pending = first.emit("tool_call", event, context);
    try {
      await started.promise;
      await writeFile(target, frozenSource);
      const duplicate = second.emit("tool_call", { ...event }, { ...context });
      release.resolve();
      expect(await pending).toBeUndefined();
      expect(await duplicate).toBeUndefined();
      expect(await first.emit("tool_call", event, context)).toBeUndefined();
      expect(sourceReads).toBe(1);
      expect(requests).toHaveLength(1);
      await first.emit(
        "tool_result",
        { ...event, type: "tool_result", content: [], isError: false },
        context,
      );

      const denied = await first.emit(
        "tool_call",
        { ...event, toolCallId: "frozen-record" },
        context,
      );
      expect(denied).toMatchObject({ block: true });
      expect(sourceReads).toBe(2);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(denied)).not.toContain("lifecycle=frozen");

      await rm(target);
      expect(
        await first.emit("tool_call", { ...event, toolCallId: "missing-record" }, context),
      ).toBeUndefined();
      expect(confirmations).toEqual([]);
      const audits = repository.listAudits(await realpath(projectRoot));
      expect(
        audits.find((audit) => audit.actionId === "missing-record" && audit.phase === "decision"),
      ).toMatchObject({
        effect: "allow",
        diagnostics: { confirmation: { resolution: "automatic-approve" } },
      });
      expect(audits.filter((audit) => audit.phase === "decision")).toHaveLength(3);
      const serialized = JSON.stringify(audits);
      expect(serialized).not.toContain("sourceContext");
      expect(serialized).not.toContain("mutationContext");
      expect(serialized).not.toContain("record=new");
      expect(serialized).not.toContain("lifecycle=editable");
      expect(serialized).not.toContain("lifecycle=frozen");
    } finally {
      release.resolve();
      await pending;
      sourceAccess.mockRestore();
      await first.emit("session_shutdown", {}, context);
      await second.emit("session_shutdown", {}, context);
      repository.close();
    }
  });

  test.each(["local-denial", "coverage-bypass", "no-consent", "no-credentials"] as const)(
    "does not read mutation source or evaluate remotely after %s",
    async (gate) => {
      const fixture = await mkdtemp(join(tmpdir(), "omp-policy-source-gates-"));
      temporaryDirectories.push(fixture);
      const projectRoot = join(fixture, "project");
      const databasePath = join(fixture, "policy.db");
      await mkdir(join(projectRoot, ".git"), { recursive: true });
      await writeFile(
        join(projectRoot, "AGENTS.md"),
        gate === "local-denial"
          ? "Never read or modify protected.ts.\n"
          : "Never modify a record whose original lifecycle is frozen.\n",
      );
      const target = join(await realpath(projectRoot), "protected.ts");
      await writeFile(target, "lifecycle=frozen\nrecord=old\n");
      const repository = await createPolicyRepository(databasePath);
      repository.setRemoteConsent(gate !== "no-consent");
      const requests: PolicyModelRequest[] = [];
      const harness = createExtensionHarness();
      registerOmpPolicyRuntime(harness.api, {
        databasePath,
        profileInstructionPaths: [],
        createPolicyModel: () => fixturePolicyModel(requests),
        runtimeSettings: {
          showStatus: false,
          disabledToolCalls: gate === "coverage-bypass" ? ["edit"] : [],
        },
      });
      const context = createContext(projectRoot, [], {
        providerApiKey: gate === "no-credentials" ? null : "fixture-api-key",
      });
      await harness.emit("session_start", {}, context);
      const openFile = fs.open;
      let sourceReads = 0;
      const sourceAccess = spyOn(fs, "open").mockImplementation(async (path, ...args) => {
        if (String(path) === target) sourceReads += 1;
        return openFile(path, ...args);
      });
      try {
        const result = await harness.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: gate,
            toolName: "edit",
            input: { path: "protected.ts", old_string: "record=old", new_string: "record=new" },
          },
          context,
        );
        if (gate === "local-denial") {
          expect(result).toMatchObject({ block: true });
        } else {
          expect(result).toBeUndefined();
        }
        expect(sourceReads).toBe(0);
        expect(requests).toEqual([]);
      } finally {
        sourceAccess.mockRestore();
        await harness.emit("session_shutdown", {}, context);
        repository.close();
      }
    },
  );

  test.each(["before-read", "before-egress"] as const)(
    "honors consent revoked %s without changing automatic approval",
    async (phase) => {
      const fixture = await mkdtemp(join(tmpdir(), "omp-policy-source-consent-"));
      temporaryDirectories.push(fixture);
      const projectRoot = join(fixture, "project");
      const databasePath = join(fixture, "policy.db");
      await mkdir(join(projectRoot, ".git"), { recursive: true });
      await writeFile(
        join(projectRoot, "AGENTS.md"),
        "Never modify a record whose original lifecycle is frozen.\n",
      );
      const target = join(await realpath(projectRoot), "record.ts");
      await writeFile(target, "lifecycle=frozen\nrecord=old\n");
      const repository = await createPolicyRepository(databasePath);
      repository.setRemoteConsent(true);
      const requests: PolicyModelRequest[] = [];
      const harness = createExtensionHarness();
      registerOmpPolicyRuntime(harness.api, {
        databasePath,
        profileInstructionPaths: [],
        createPolicyModel: () => {
          if (phase === "before-read") repository.setRemoteConsent(false);
          return fixturePolicyModel(requests);
        },
        runtimeSettings: { showStatus: false },
      });
      const context = createContext(projectRoot);
      await harness.emit("session_start", {}, context);
      const openFile = fs.open;
      let sourceReads = 0;
      const sourceAccess = spyOn(fs, "open").mockImplementation(async (path, ...args) => {
        const file = await openFile(path, ...args);
        if (String(path) === target) {
          sourceReads += 1;
          if (phase === "before-egress") repository.setRemoteConsent(false);
        }
        return file;
      });
      try {
        expect(
          await harness.emit(
            "tool_call",
            {
              type: "tool_call",
              toolCallId: "revoked-edit",
              toolName: "edit",
              input: { path: "record.ts", old_string: "record=old", new_string: "record=new" },
            },
            context,
          ),
        ).toBeUndefined();
        expect(sourceReads).toBe(phase === "before-read" ? 0 : 1);
        expect(requests).toEqual([]);
        expect(
          repository
            .listAudits(await realpath(projectRoot))
            .find((audit) => audit.phase === "decision"),
        ).toMatchObject({
          effect: "allow",
          diagnostics: {
            semantic: { unavailableReason: "not-consented" },
            confirmation: { resolution: "automatic-approve" },
          },
        });
      } finally {
        sourceAccess.mockRestore();
        await harness.emit("session_shutdown", {}, context);
        repository.close();
      }
    },
  );

  test("isolates shared action IDs across hosts, session switches, configuration and teardown", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-session-isolation-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Ask before editing files.\n");
    const repository = await createPolicyRepository(databasePath);
    repository.setRemoteConsent(true);
    const options = {
      databasePath,
      profileInstructionPaths: [],
      createPolicyModel: promptPolicyModel,
      runtimeSettings: { showStatus: false, confirmationThreshold: 0.5 },
    };
    const first = createExtensionHarness();
    const second = createExtensionHarness();
    registerOmpPolicyRuntime(first.api, options);
    registerOmpPolicyRuntime(second.api, options);
    let sessionId = "first";
    const confirmations: string[] = [];
    const firstContext = createContext(projectRoot, [], {
      confirmations,
      sessionId: () => sessionId,
    });
    const secondContext = createContext(projectRoot, [], {
      approved: false,
      sessionId: () => sessionId,
    });
    const event = {
      type: "tool_call",
      toolCallId: "same-id",
      toolName: "write",
      input: { path: "ordinary.txt", content: "hello" },
    };
    await first.emit("session_start", {}, firstContext);
    await second.emit("session_start", {}, secondContext);
    try {
      expect(await first.emit("tool_call", event, firstContext)).toBeUndefined();
      expect(await first.emit("tool_call", { ...event }, firstContext)).toBeUndefined();
      expect(confirmations).toHaveLength(1);
      expect(await second.emit("tool_call", event, secondContext)).toMatchObject({ block: true });
      sessionId = "second";
      await first.emit("session_switch", {}, firstContext);
      expect(await first.emit("tool_call", event, firstContext)).toBeUndefined();
      expect(confirmations).toHaveLength(2);

      const configured = createExtensionHarness();
      registerOmpPolicyRuntime(configured.api, {
        ...options,
        runtimeSettings: { showStatus: false, confirmationDefault: "deny" },
      });
      await configured.emit("session_start", {}, firstContext);
      expect(await configured.emit("tool_call", event, firstContext)).toMatchObject({
        block: true,
      });
      await configured.emit("session_shutdown", {}, firstContext);
    } finally {
      await first.emit("session_shutdown", {}, firstContext);
      await second.emit("session_shutdown", {}, secondContext);
    }
    const restarted = createExtensionHarness();
    registerOmpPolicyRuntime(restarted.api, options);
    await restarted.emit("session_start", {}, firstContext);
    expect(await restarted.emit("tool_call", event, firstContext)).toBeUndefined();
    expect(confirmations).toHaveLength(3);
    await restarted.emit("session_shutdown", {}, firstContext);
    repository.close();
  });

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
    expect(modelRequests.at(-1)?.authorization?.summary).not.toContain("super-secret-value");
    expect(modelRequests.at(-1)?.authorization?.requestContext).toBeUndefined();

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
    const shellRequest = modelRequests.at(-1)!;
    const shellEvidence = createRedactedProviderState(shellRequest);
    expect(shellEvidence.authorization.requestContext?.messages.at(-1)?.text).toContain(
      "Deploy with TOKEN=",
    );
    expect(JSON.stringify(shellEvidence.authorization)).not.toContain("super-secret-value");

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
    const requestsBeforeInteractiveStop = modelRequests.length;
    expect(await harness.emit("session_stop", stopEvent, context)).toBeUndefined();
    expect(modelRequests).toHaveLength(requestsBeforeInteractiveStop);
    const headlessContext = { ...context, hasUI: false };
    expect(
      await harness.emit<{ readonly decision: "block"; readonly reason: string }>(
        "session_stop",
        stopEvent,
        headlessContext,
      ),
    ).toMatchObject({ decision: "block" });
    const requestsAfterContinuation = modelRequests.length;
    expect(await harness.emit("session_stop", stopEvent, headlessContext)).toBeUndefined();
    expect(modelRequests).toHaveLength(requestsAfterContinuation);
    await harness.emit("session_switch", { type: "session_switch" }, headlessContext);
    expect(
      await harness.emit<{ readonly decision: string }>("session_stop", stopEvent, headlessContext),
    ).toMatchObject({ decision: "block" });
    expect(modelRequests).toHaveLength(requestsAfterContinuation + 1);

    await harness.emit("session_shutdown", { type: "session_shutdown" }, context);

    const repository = await createPolicyRepository(databasePath);
    const audits = repository.listAudits(await realpath(projectRoot));
    expect(audits.some((audit) => audit.phase === "result" && audit.outcome === "success")).toBe(
      true,
    );
    expect(
      audits.some((audit) => audit.operation === "execute" && audit.outcome === "blocked"),
    ).toBe(true);
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

  test("evaluates classified custom tools and bypasses disabled unknown tools", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-custom-tools-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");
    const repository = await createPolicyRepository(databasePath);
    repository.setRemoteConsent(true);
    repository.close();

    const modelRequests: PolicyModelRequest[] = [];
    const harness = createExtensionHarness([
      {
        name: "launchpad",
        sourceInfo: { source: "mcp", path: "<mcp:launchpad>" },
      } as ToolInfo,
    ]);
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      createPolicyModel: () => fixturePolicyModel(modelRequests),
      runtimeSettings: {
        showStatus: false,
        showViolationFeedback: false,
        enabledToolCalls: [],
        disabledToolCalls: ["trusted_extension"],
        toolOperations: { launchpad: "read" },
      },
    });
    const context = createContext(projectRoot);
    const input = {
      op: "search_merge_proposals",
      repository: "launchpad",
      target: "merge-proposal",
      limit: 1,
    };

    await harness.emit("session_start", { type: "session_start" }, context);
    try {
      expect(
        await harness.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "classified",
            toolName: "launchpad",
            input,
          },
          context,
        ),
      ).toMatchObject({ block: true });
      expect(
        await harness.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "disabled-unknown",
            toolName: "trusted_extension",
            input: { arbitrary: "input" },
          },
          context,
        ),
      ).toBeUndefined();
      expect(
        await harness.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "covered-unknown",
            toolName: "unmapped_extension",
            input: { arbitrary: "input" },
          },
          context,
        ),
      ).toMatchObject({ block: true });

      expect(modelRequests).toHaveLength(1);
      expect(modelRequests[0]?.action).toMatchObject({
        operation: "read",
        complete: true,
        interception: "dispatch-only",
        details: { input },
        targets: [
          { kind: "target", value: "merge-proposal" },
          { kind: "repository", value: "launchpad" },
        ],
        hostAction: {
          name: "launchpad",
          source: { kind: "mcp", path: "<mcp:launchpad>" },
        },
      });
    } finally {
      await harness.emit("session_shutdown", { type: "session_shutdown" }, context);
    }
  });

  test.each([
    { name: "defaults", enabled: undefined, disabled: [], evaluated: ["write", "bash"] },
    { name: "explicit glob opt-in", enabled: ["glob"], disabled: [], evaluated: ["glob"] },
    {
      name: "explicit all-tools opt-in",
      enabled: [],
      disabled: [],
      evaluated: ["glob", "read", "grep", "todo", "ask", "web_search", "write", "bash"],
    },
    { name: "disabled precedence", enabled: ["glob"], disabled: ["glob"], evaluated: [] },
  ])(
    "limits semantic requests with $name",
    async ({
      enabled,
      disabled,
      evaluated,
    }: {
      readonly enabled: readonly string[] | undefined;
      readonly disabled: readonly string[];
      readonly evaluated: readonly string[];
    }) => {
      const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-requests-"));
      temporaryDirectories.push(fixture);
      const projectRoot = join(fixture, "project");
      await mkdir(join(projectRoot, ".git"), { recursive: true });
      await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");
      const modelRequests: PolicyModelRequest[] = [];
      const harness = createExtensionHarness();
      registerOmpPolicyRuntime(harness.api, {
        databasePath: join(fixture, "policy.db"),
        profileInstructionPaths: [],
        createPolicyModel: () => fixturePolicyModel(modelRequests),
        runtimeSettings: {
          showStatus: false,
          showViolationFeedback: false,
          disabledToolCalls: disabled,
          ...(enabled === undefined ? {} : { enabledToolCalls: enabled }),
        },
      });
      const context = createContext(projectRoot);
      await harness.emit("session_start", { type: "session_start" }, context);
      try {
        for (const toolName of [
          "glob",
          "read",
          "grep",
          "todo",
          "ask",
          "web_search",
          "write",
          "bash",
        ]) {
          const result = await harness.emit(
            "tool_call",
            {
              type: "tool_call",
              toolCallId: toolName,
              toolName,
              input:
                toolName === "grep"
                  ? { path: "normal.txt", pattern: "fixture" }
                  : toolName === "web_search"
                    ? { query: "Bun documentation" }
                    : toolName === "todo"
                      ? { op: "view" }
                      : toolName === "ask"
                        ? {
                            questions: [
                              { id: "proceed", question: "Proceed?", options: [{ label: "Yes" }] },
                            ],
                          }
                        : toolName === "write"
                          ? { path: "notes.txt", content: "safe\n" }
                          : { path: ".", command: "pwd" },
            },
            context,
          );
          if (evaluated.includes(toolName) && toolName !== "write") {
            expect(result).toMatchObject({ block: true });
          } else {
            expect(result).toBeUndefined();
          }
        }
        expect<readonly string[]>(
          modelRequests.map((request) => request.action.hostAction.name),
        ).toEqual(evaluated);
      } finally {
        await harness.emit("session_shutdown", { type: "session_shutdown" }, context);
      }
    },
  );

  test.each([
    {
      name: "defaults",
      enabled: undefined,
      disabled: [],
      evaluated: ["file-write", "other-device"],
    },
    {
      name: "LSP opt-in",
      enabled: ["lsp"],
      disabled: [],
      evaluated: ["native-lsp", "routed-lsp"],
    },
    {
      name: "all-tools opt-in",
      enabled: [],
      disabled: [],
      evaluated: ["native-lsp", "routed-lsp", "file-write", "other-device"],
    },
    {
      name: "LSP disable precedence",
      enabled: ["lsp", "write"],
      disabled: ["lsp"],
      evaluated: ["file-write", "other-device"],
    },
    {
      name: "LSP coverage independent of write",
      enabled: ["lsp", "write"],
      disabled: ["write"],
      evaluated: ["native-lsp", "routed-lsp"],
    },
  ])(
    "selects native and routed LSP coverage with $name",
    async ({
      enabled,
      disabled,
      evaluated,
    }: {
      readonly enabled: readonly string[] | undefined;
      readonly disabled: readonly string[];
      readonly evaluated: readonly string[];
    }) => {
      const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-lsp-"));
      temporaryDirectories.push(fixture);
      const projectRoot = join(fixture, "project");
      await mkdir(join(projectRoot, ".git"), { recursive: true });
      await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");
      const modelRequests: PolicyModelRequest[] = [];
      const harness = createExtensionHarness();
      registerOmpPolicyRuntime(harness.api, {
        databasePath: join(fixture, "policy.db"),
        profileInstructionPaths: [],
        createPolicyModel: () => fixturePolicyModel(modelRequests),
        runtimeSettings: {
          showStatus: false,
          showViolationFeedback: false,
          disabledToolCalls: disabled,
          ...(enabled === undefined ? {} : { enabledToolCalls: enabled }),
        },
      });
      const context = createContext(projectRoot);
      await harness.emit("session_start", { type: "session_start" }, context);
      try {
        for (const [toolCallId, toolName, input] of [
          ["native-lsp", "lsp", { action: "references", file: "src/index.ts" }],
          [
            "routed-lsp",
            "write",
            { path: "xd://lsp", content: '{"action":"references","file":"src/index.ts"}' },
          ],
          ["file-write", "write", { path: "notes.txt", content: "safe\n" }],
          ["other-device", "write", { path: "xd://debug", content: '{"action":"sessions"}' }],
        ] as const) {
          const result = await harness.emit(
            "tool_call",
            { type: "tool_call", toolCallId, toolName, input },
            context,
          );
          if (evaluated.includes(toolCallId) && toolName === "lsp") {
            expect(result).toMatchObject({ block: true });
          } else {
            expect(result).toBeUndefined();
          }
        }
        expect<readonly string[]>(modelRequests.map((request) => request.action.id)).toEqual(
          evaluated,
        );
      } finally {
        await harness.emit("session_shutdown", { type: "session_shutdown" }, context);
      }
    },
  );

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

  test("keeps out-of-order parallel denials on their own tool results", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-parallel-feedback-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");
    const repository = await createPolicyRepository(databasePath);
    repository.setRemoteConsent(true);
    repository.close();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const notifications: string[] = [];
    const harness = createExtensionHarness();
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      runtimeSettings: { showStatus: false, showViolationFeedback: true },
      createPolicyModel: () => ({
        ...fixturePolicyModel([]),
        async evaluate(request) {
          if (request.action.hostAction.name === "bash") {
            started.resolve();
            await release.promise;
          }
          return {
            kind: "decision",
            effect: "deny",
            confidence: 0.9,
            hardViolationProbability: 0.9,
            ruleIds: request.snapshot.rules.slice(0, 1).map((rule) => rule.id),
            model: "fixture",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
    });
    const context = createContext(projectRoot, [], { notifications });
    await harness.emit("session_start", { type: "session_start" }, context);
    const bash = harness.emit<{ block: boolean; reason: string }>(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "size-check",
        toolName: "bash",
        input: { command: "wc -c dist/index.js" },
      },
      context,
    );
    try {
      await started.promise;
      const evaluated = await harness.emit<{ block: boolean; reason: string }>(
        "tool_call",
        {
          type: "tool_call",
          toolCallId: "eval-check",
          toolName: "eval",
          input: { language: "js", code: 'console.log("private-code-body")' },
        },
        context,
      );
      const read = await harness.emit(
        "tool_call",
        {
          type: "tool_call",
          toolCallId: "read-check",
          toolName: "read",
          input: { path: "dist/index.js:1-50" },
        },
        context,
      );
      release.resolve();
      const sized = await bash;
      expect(read).toBeUndefined();
      expect(sized?.block).toBe(true);
      expect(sized?.reason).toContain("bash");
      expect(sized?.reason).toContain("wc -c dist/index.js");
      expect(evaluated?.block).toBe(true);
      expect(evaluated?.reason).toContain("eval");
      expect(evaluated?.reason).not.toContain("wc -c dist/index.js");
      expect(evaluated?.reason).not.toContain("private-code-body");
      expect(notifications).toEqual([]);
    } finally {
      release.resolve();
      await bash;
      await harness.emit("session_shutdown", { type: "session_shutdown" }, context);
    }
  });

  test.each([
    { name: "defaults with UI", hasUI: true, approved: false, interactive: false },
    { name: "defaults without UI", hasUI: false, approved: false, interactive: false },
    { name: "explicit confirmation approved", hasUI: true, approved: true, interactive: true },
    { name: "explicit confirmation declined", hasUI: true, approved: false, interactive: true },
    { name: "explicit confirmation without UI", hasUI: false, approved: false, interactive: true },
  ])("gates uncertain tools and workflow with $name", async ({ hasUI, approved, interactive }) => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-neutral-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");
    const repository = await createPolicyRepository(databasePath);
    repository.setRemoteConsent(true);
    repository.close();

    const confirmations: string[] = [];
    const notifications: string[] = [];
    const harness = createExtensionHarness();
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      createPolicyModel: () => ({
        ...promptPolicyModel(),
        async evaluate() {
          return {
            kind: "decision",
            effect: "prompt",
            confidence: 0.12,
            hardViolationProbability: 0.01,
            model: "model-v1",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
      runtimeSettings: {
        showStatus: false,
        ...(interactive ? { confirmationThreshold: 0 } : {}),
      },
    });
    const context = createContext(projectRoot, [], {
      confirmations,
      notifications,
      hasUI,
      approved,
    });
    await harness.emit("session_start", { type: "session_start" }, context);
    await harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Return only the complete README.md content.",
        systemPrompt: [],
      },
      context,
    );
    try {
      for (const [toolName, input] of [
        ["todo", { op: "init", items: ["Read README content"] }],
        ["read", { path: "." }],
      ] as const) {
        expect(
          await harness.emit(
            "tool_call",
            { type: "tool_call", toolCallId: toolName, toolName, input },
            context,
          ),
        ).toBeUndefined();
      }
      for (const [toolName, input] of [
        ["write", { path: "notes.txt", content: "safe\n" }],
        ["bash", { command: "bun run build" }],
        ["eval", { language: "js", code: "console.log(1 + 1)" }],
      ] as const) {
        const toolResult = await harness.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: `uncertain-${toolName}`,
            toolName,
            input,
          },
          context,
        );
        if (!interactive || (hasUI && approved)) {
          expect(toolResult).toBeUndefined();
        } else {
          expect(toolResult).toMatchObject({ block: true });
        }
      }
      const confirmationsBeforeStop = confirmations.length;
      const stopResult = await harness.emit(
        "session_stop",
        {
          type: "session_stop",
          session_id: "session-1",
          turn_id: 1,
          signal: new AbortController().signal,
        },
        context,
      );
      expect(stopResult).toBeUndefined();
      expect(confirmations).toHaveLength(confirmationsBeforeStop);
      expect(confirmations).toHaveLength(interactive && hasUI ? 3 : 0);
    } finally {
      await harness.emit("session_shutdown", { type: "session_shutdown" }, context);
    }
    const auditRepository = await createPolicyRepository(databasePath);
    const writeDecision = auditRepository
      .listAudits(await realpath(projectRoot))
      .find((audit) => audit.phase === "decision" && audit.actionId === "uncertain-write");
    const accepted = !interactive || (hasUI && approved);
    expect(writeDecision?.effect).toBe(accepted ? "allow" : "deny");
    expect(writeDecision?.diagnostics?.enforcedEffect).toBe(accepted ? "allow" : "deny");
    expect(writeDecision?.diagnostics?.confirmation.resolution).toBe(
      !interactive
        ? "automatic-approve"
        : !hasUI
          ? "headless-denied"
          : approved
            ? "user-approved"
            : "user-denied",
    );
    auditRepository.close();
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
    expect(confirmations).toHaveLength(2);
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

  test("blocks absent credentials without inventing semantic violations", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-runtime-login-required-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Never publish secrets.\n");
    const databasePath = join(fixture, "policy.db");
    const repository = await createPolicyRepository(databasePath);
    repository.setRemoteConsent(true);
    repository.close();

    const notifications: string[] = [];
    const confirmations: string[] = [];
    const harness = createExtensionHarness();
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      runtimeSettings: {
        showStatus: false,
        showViolationFeedback: true,
        confirmationThreshold: 0,
      },
    });
    const context = createContext(projectRoot, [], {
      notifications,
      confirmations,
      providerApiKey: null,
      approved: false,
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

    expect(result).toMatchObject({ block: true });
    expect(confirmations).toHaveLength(1);
    const auditRepository = await createPolicyRepository(databasePath);
    const decision = auditRepository
      .listAudits(await realpath(projectRoot))
      .find((audit) => audit.phase === "decision" && audit.actionId === "safe-bash");
    expect(decision?.evidenceSource).toBe("fallback");
    expect(decision?.diagnostics?.path).toBe("provider-unavailable");
    expect(decision?.diagnostics?.confirmation.resolution).toBe("user-denied");
    auditRepository.close();
  });

  test("enforces protected targets locally despite default inspection exclusions", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-local-runtime-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(
      join(projectRoot, "AGENTS.md"),
      "Never read or modify protected.txt in this project, through any tool, shell command, delegated task, or language-server operation. User requests do not override this prohibition.\n\nOrdinary local file writes outside protected.txt are allowed.\n",
    );
    await writeFile(join(projectRoot, "protected.txt"), "fixture-only\n");
    await writeFile(join(projectRoot, "normal.txt"), "ordinary\n");
    const requests: PolicyModelRequest[] = [];
    const harness = createExtensionHarness();
    registerOmpPolicyRuntime(harness.api, {
      databasePath,
      profileInstructionPaths: [],
      createPolicyModel: () => fixturePolicyModel(requests),
      runtimeSettings: { showStatus: false, showViolationFeedback: false },
    });
    const context = createContext(projectRoot, [], { providerApiKey: null });
    await harness.emit("session_start", { type: "session_start" }, context);
    try {
      for (const [toolName, input] of [
        ["read", { path: "protected.txt" }],
        ["grep", { path: "protected.txt", pattern: "." }],
        [
          "lsp",
          {
            action: "rename",
            file: "protected.txt",
            symbol: "value",
            new_name: "renamed",
            line: 1,
          },
        ],
        [
          "write",
          {
            path: "xd://lsp",
            content: '{"action":"references","file":"protected.txt","line":1,"symbol":"value"}',
          },
        ],
      ] as const) {
        expect(
          await harness.emit(
            "tool_call",
            {
              type: "tool_call",
              toolCallId: `protected-${toolName}`,
              toolName,
              input,
            },
            context,
          ),
        ).toMatchObject({ block: true });
      }
      expect(
        await harness.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "ordinary-read",
            toolName: "read",
            input: { path: "normal.txt" },
          },
          context,
        ),
      ).toBeUndefined();
      expect(requests).toHaveLength(0);
    } finally {
      await harness.emit("session_shutdown", { type: "session_shutdown" }, context);
    }
    const repository = await createPolicyRepository(databasePath);
    const decisions = repository
      .listAudits(await realpath(projectRoot))
      .filter((audit) => audit.phase === "decision");
    expect(
      decisions.filter((audit) => audit.effect === "deny").map((audit) => audit.diagnostics?.path),
    ).toEqual(["local-denial", "local-denial", "local-denial", "local-denial"]);
    expect(decisions.find((audit) => audit.actionId === "ordinary-read")?.diagnostics?.path).toBe(
      "coverage-bypass",
    );
    repository.close();
  });

  test("shares one-use maintenance approval across registrations and invalidates it on policy change", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "omp-policy-maintenance-runtime-"));
    temporaryDirectories.push(fixture);
    const projectRoot = join(fixture, "project");
    const databasePath = join(fixture, "policy.db");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "Ask before installing dependencies.\n");
    const harness = createExtensionHarness();
    let hardDeny = false;
    const options: OmpPolicyRuntimeOptions = {
      databasePath,
      profileInstructionPaths: [],
      createPolicyModel: () => ({
        ...promptPolicyModel(),
        async evaluate(request) {
          return {
            kind: "decision",
            effect: hardDeny ? "deny" : "prompt",
            confidence: 0.9,
            hardViolationProbability: hardDeny ? 0.95 : 0.1,
            ruleIds: hardDeny ? request.snapshot.rules.slice(0, 1).map((rule) => rule.id) : [],
            model: "fixture",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
      runtimeSettings: {
        showStatus: false,
        showViolationFeedback: false,
        confirmationDefault: "deny",
        confirmationThreshold: 1,
      },
    };
    // The first handler owns the blocked proposal; the last command registration
    // receives /policy maintenance approve and must find that same candidate.
    registerOmpPolicyRuntime(harness.api, options);
    registerOmpPolicyRuntime(harness.api, options);
    const context = createContext(projectRoot);
    const propose = (id: string, command = "bun install --frozen-lockfile") =>
      harness.emit(
        "tool_call",
        { type: "tool_call", toolCallId: id, toolName: "bash", input: { command } },
        context,
      );
    await harness.emit("session_start", { type: "session_start" }, context);
    try {
      expect(await propose("first")).toMatchObject({ block: true });
      await harness.runCommand("policy", "maintenance approve first", context);
      expect(await propose("changed", "bun install --frozen-lockfile && echo extra")).toMatchObject(
        { block: true },
      );
      expect(await propose("approved-retry")).toBeUndefined();
      expect(await propose("approved-retry")).toBeUndefined();
      await harness.runCommand("policy", "maintenance revoke", context);
      expect(await propose("approved-retry")).toMatchObject({ block: true });
      expect(await propose("used-up")).toMatchObject({ block: true });
      await harness.runCommand("policy", "maintenance approve used-up", context);
      hardDeny = true;
      expect(await propose("hard-denial")).toMatchObject({ block: true });
      hardDeny = false;
      expect(await propose("after-hard-denial")).toMatchObject({ block: true });
      await harness.runCommand("policy", "maintenance approve after-hard-denial", context);
      await writeFile(
        join(projectRoot, "AGENTS.md"),
        "Ask before installing dependencies.\nNever publish secrets.\n",
      );
      expect(await propose("changed-policy")).toMatchObject({ block: true });
      await harness.runCommand("policy", "maintenance approve changed-policy", context);
      await harness.emit("session_switch", { type: "session_switch" }, context);
      expect(await propose("changed-session")).toMatchObject({ block: true });
    } finally {
      await harness.emit("session_shutdown", { type: "session_shutdown" }, context);
    }
    const repository = await createPolicyRepository(databasePath);
    const decisions = repository
      .listAudits(await realpath(projectRoot))
      .filter((audit) => audit.phase === "decision");
    expect(
      decisions.filter((audit) => audit.effect === "allow").map((audit) => audit.actionId),
    ).toEqual(["approved-retry"]);
    expect(
      decisions.find((audit) => audit.actionId === "approved-retry")?.diagnostics?.confirmation
        .resolution,
    ).toBe("maintenance-approved");
    repository.close();
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

function createExtensionHarness(tools: readonly ToolInfo[] = []): ExtensionHarness {
  const handlers = new Map<string, RuntimeHandler[]>();
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
      return tools;
    },
    on(event: string, handler: unknown) {
      if (typeof handler === "function") {
        const registered = handlers.get(event) ?? [];
        registered.push(handler as RuntimeHandler);
        handlers.set(event, registered);
      }
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    async emit<Result>(event: string, payload: unknown, context: ExtensionContext) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const current = await handler(payload, context);
        if (current !== undefined) result = current;
        if (
          event === "tool_call" &&
          typeof current === "object" &&
          current !== null &&
          "block" in current &&
          current.block
        )
          break;
      }
      return result as Result | undefined;
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
  readonly sessionId?: () => string;
  readonly notifications?: string[];
  readonly statuses?: Array<string | undefined>;
  readonly confirmations?: string[];
  readonly hasUI?: boolean;
  readonly approved?: boolean;
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
    hasUI: observations.hasUI ?? true,
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
        return observations.approved ?? true;
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
        return observations.sessionId?.() ?? "session-1";
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
        ruleIds: allow ? [] : request.snapshot.rules.slice(0, 1).map((rule) => rule.id),
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
