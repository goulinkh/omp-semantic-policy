import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { Fetch } from "@typesafe-ai/sdk";
import type { PolicyModelRequest, PolicySnapshot } from "../../policy/index.js";
import { createTestPolicyAction } from "../../../testing/createPolicyAction.js";
import {
  createTypeSafePolicyModel,
  DEFAULT_TYPESAFE_POLICY_MODEL,
} from "./createTypeSafePolicyModel.js";
import { registerTypeSafeProvider } from "./registerTypeSafeProvider.js";
import { createRedactedProviderState, type RedactedProviderState } from "./redactProviderState.js";
import { evaluateSnapshotPolicy } from "../omp/enforcement/evaluateSnapshotPolicy.js";

interface CapturedRequest {
  readonly url: string;
  readonly body?: string;
}

interface CapturedWireRequest {
  readonly state: {
    readonly policy: {
      readonly snapshotId: string;
      readonly sources: readonly (readonly [string, number])[];
      readonly contexts: readonly (readonly string[])[];
      readonly rules: readonly (readonly [string, string, number, number, string])[];
    };
    readonly action: RedactedProviderState["action"];
    readonly authorization: RedactedProviderState["authorization"];
  };
}

describe("TypeSafe policy model", () => {
  test("does not make a request without profile consent", async () => {
    let requestCount = 0;
    const model = createTypeSafePolicyModel({
      apiKey: "not-sent",
      hasConsent: () => false,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse({});
      },
    });

    const result = await model.evaluate(createRequest());

    expect(result.kind).toBe("unavailable");
    expect(requestCount).toBe(0);
    await expect(model.validate()).rejects.toThrow("not been consented");
    expect(requestCount).toBe(0);
  });

  test("validates the configured model with the models endpoint", async () => {
    const captured: CapturedRequest[] = [];
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch(captured),
    });

    const validation = await model.validate();

    expect(validation).toEqual({
      model: DEFAULT_TYPESAFE_POLICY_MODEL,
      availableModels: [DEFAULT_TYPESAFE_POLICY_MODEL],
    });
    expect(captured).toEqual([{ url: "https://api.typesafe.ai/v1/models" }]);
  });

  test("sends only redacted state and denies high-probability hard violations", async () => {
    const captured: CapturedRequest[] = [];
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch(captured, {
        model: DEFAULT_TYPESAFE_POLICY_MODEL,
        answers: {
          decision: {
            type: "choice",
            choice: "allow",
            confidence: 0.99,
            probabilities: { allow: 0.99, prompt: 0.005, deny: 0.005 },
          },
          hardViolation: { type: "noul", noul: 0.91 },
          matchedRule: {
            type: "choice",
            choice: "r0",
            confidence: 0.95,
            probabilities: { r0: 0.95, none: 0.05 },
          },
        },
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    });

    const result = await model.evaluate(createRequest());
    const body = captured[0]?.body ?? "";

    expect(result).toMatchObject({
      kind: "decision",
      effect: "deny",
      confidence: 0.91,
      hardViolationProbability: 0.91,
      model: DEFAULT_TYPESAFE_POLICY_MODEL,
      usage: { inputTokens: 50, outputTokens: 5 },
      ruleIds: ["root-rule"],
      diagnostics: {
        rawChoice: "allow",
        rawConfidence: 0.99,
        adapterEffect: "deny",
        decisionBasis: "hard-violation",
        attribution: "validated",
      },
    });
    expect(body).toContain("[REDACTED:NONEMPTY]");
    expect(body).not.toContain("super-secret-value");
    expect(body).not.toContain("hostInputSecret");
    expect(body).not.toContain("unrelated-web-rule");
  });

  test("keeps permissions and prohibitions together at the indivisible wire size boundary", async () => {
    const captured: CapturedRequest[] = [];
    const request = createRequest();
    const rootRule = request.snapshot.rules[0];
    if (rootRule === undefined) {
      throw new Error("Root rule fixture is missing");
    }
    const permission = {
      ...rootRule,
      id: "exception",
      statement: "An explicitly requested repair is permitted.",
    };
    const baseRequest = {
      ...request,
      snapshot: { ...request.snapshot, rules: [rootRule, permission] },
    };
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch(captured, modelResponse("allow", 0.99, 0.01)),
    });
    expect((await model.evaluate(baseRequest)).kind).toBe("decision");
    const basePayload = JSON.parse(captured[0]?.body ?? "{}") as CapturedWireRequest;
    const padding = 40_000 - Buffer.byteLength(JSON.stringify(basePayload.state));
    const boundaryRequest = {
      ...baseRequest,
      snapshot: {
        ...baseRequest.snapshot,
        rules: [{ ...rootRule, statement: "x".repeat(padding) + rootRule.statement }, permission],
      },
    };
    expect(await model.evaluate(boundaryRequest)).toMatchObject({
      kind: "decision",
      diagnostics: { stateBytes: 40_000 },
    });
    const payload = JSON.parse(captured[1]?.body ?? "{}") as CapturedWireRequest;
    expect(captured).toHaveLength(2);
    expect(payload.state.policy.rules.map((rule) => rule[0])).toEqual(["r0", "r1"]);
    expect(payload.state.policy.rules[1]?.[4]).toBe(permission.statement);
    expect(Buffer.byteLength(JSON.stringify(payload.state))).toBe(40_000);
    const oversized = await model.evaluate({
      ...boundaryRequest,
      snapshot: {
        ...boundaryRequest.snapshot,
        rules: [
          { ...rootRule, statement: "x".repeat(padding + 1) + rootRule.statement },
          permission,
        ],
      },
    });
    expect(oversized).toMatchObject({
      kind: "unavailable",
      diagnostics: {
        status: "unavailable",
        unavailableReason: "context-limit",
        stateBytes: 40_001,
      },
    });
    expect(captured).toHaveLength(2);
  });

  test("losslessly interns large repeated rule context and maps request-local aliases to canonical matches", async () => {
    const request = createRequest();
    const rootRule = request.snapshot.rules[0];
    if (rootRule === undefined) {
      throw new Error("Root rule fixture is missing");
    }
    const rules = Array.from({ length: 120 }, (_, index) => ({
      ...rootRule,
      id: String(index).padStart(64, "0"),
      classification: index % 2 === 0 ? rootRule.classification : ("semantic" as const),
      statement:
        index % 2 === 0
          ? `Never perform operation ${index / 2} unless the following exception permits it.`
          : `The previous rule permits a user-requested repair of operation ${Math.floor(index / 2)}.`,
      context: [
        "Shared policy",
        `Quoted "permission" – ${"context ".repeat(40)}`,
        index % 2 === 0 ? "Prohibitions" : "Exceptions",
      ],
      precedence: index % 2 === 0 ? 100 : 200,
    }));
    const largeRequest = { ...request, snapshot: { ...request.snapshot, rules } };
    const canonical = createRedactedProviderState(largeRequest);
    expect(Buffer.byteLength(JSON.stringify(canonical))).toBeGreaterThan(40_000);
    const captured: CapturedRequest[] = [];
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch(captured, modelResponse("allow", 0.99, 0.01, "r1")),
    });
    const result = await model.evaluate(largeRequest);
    const payload = JSON.parse(captured[0]?.body ?? "{}") as CapturedWireRequest;
    const restored = payload.state.policy.rules.map(
      ([, classification, sourceIndex, contextIndex, statement]) => ({
        class: classification,
        sourceId: payload.state.policy.sources[sourceIndex]?.[0],
        precedence: payload.state.policy.sources[sourceIndex]?.[1],
        context: payload.state.policy.contexts[contextIndex],
        statement,
      }),
    );
    expect(restored).toEqual(
      canonical.policy.rules.map(({ id: _id, context, ...rule }) => ({ ...rule, context })),
    );
    expect(payload.state.action).toEqual(canonical.action);
    expect(payload.state.authorization).toEqual(canonical.authorization);
    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({
      kind: "decision",
      effect: "allow",
      ruleIds: [rules[1]?.id],
      diagnostics: {
        attribution: "validated",
        stateBytes: Buffer.byteLength(JSON.stringify(payload.state)),
      },
    });
  });

  test("never assesses an incomplete dispatch as compliant", async () => {
    const captured: CapturedRequest[] = [];
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch(captured, modelResponse("allow", 0.99, 0.01)),
    });
    const request = createRequest();
    expect(
      await model.evaluate({ ...request, action: { ...request.action, complete: false } }),
    ).toMatchObject({
      kind: "unavailable",
      diagnostics: { unavailableReason: "incomplete-action" },
    });
    expect(
      await model.evaluate({
        ...request,
        action: { ...request.action, details: { task: "x".repeat(32_001) } },
      }),
    ).toMatchObject({
      kind: "unavailable",
      diagnostics: { unavailableReason: "incomplete-action" },
    });
    expect(captured).toHaveLength(0);
  });

  test("does not let automatic or maintenance approval bypass aggregate redaction omissions", async () => {
    const captured: CapturedRequest[] = [];
    const request = createRequest();
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch(captured, modelResponse("allow", 0.99, 0.01)),
    });
    const action = {
      ...request.action,
      details: { task: "x".repeat(16_000) },
      targets: [{ kind: "command" as const, value: "x".repeat(16_001) }],
    };
    const decision = await evaluateSnapshotPolicy({
      action,
      snapshot: request.snapshot,
      context: { headless: false },
      model,
      maintenanceApproved: true,
      confirmation: { defaultAction: "approve", threshold: 1 },
    });
    expect(decision.effect).toBe("deny");
    expect(decision.evidence.diagnostics).toMatchObject({
      path: "incomplete-action",
      semantic: { status: "unavailable", unavailableReason: "incomplete-action" },
      confirmation: { resolution: "not-required" },
      enforcedEffect: "deny",
    });
    expect(captured).toHaveLength(0);
  });

  test("records raw choice, threshold adaptation, and enforced confirmation separately", async () => {
    const request = createRequest();
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch([], modelResponse("allow", 0.14, 0.1)),
    });
    const decision = await evaluateSnapshotPolicy({
      ...request,
      context: { headless: true },
      model,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.evidence.ruleIds).toEqual([]);
    expect(decision.evidence.applicableRuleIds).toEqual(["root-rule"]);
    expect(decision.evidence.diagnostics).toMatchObject({
      path: "semantic",
      semantic: {
        rawChoice: "allow",
        rawConfidence: 0.14,
        hardViolationProbability: 0.1,
        adapterEffect: "prompt",
        model: DEFAULT_TYPESAFE_POLICY_MODEL,
        usage: { inputTokens: 50, outputTokens: 5 },
      },
      confirmation: { resolution: "automatic-deny", confidence: 0.14 },
      enforcedEffect: "deny",
    });
  });

  test("rejects invented or out-of-scope attribution without weakening a hard denial", async () => {
    const request = createRequest();
    for (const invalidId of ["invented-rule", "web-rule", "root-rule", "r1", "r00"]) {
      const model = createTypeSafePolicyModel({
        apiKey: "fixture-key",
        hasConsent: () => true,
        fetch: createFetch([], modelResponse("allow", 0.99, 0.1, invalidId)),
      });
      const invalid = await model.evaluate(request);
      expect(invalid).toMatchObject({
        kind: "unavailable",
        diagnostics: { unavailableReason: "invalid-response", attribution: "invalid" },
      });
      expect(JSON.stringify(invalid)).not.toContain(invalidId);
    }
    const denyingModel = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch([], modelResponse("allow", 0.14, 0.91, "invented-rule")),
    });
    expect(await denyingModel.evaluate(request)).toMatchObject({
      kind: "decision",
      effect: "deny",
      confidence: 0.91,
      ruleIds: [],
      diagnostics: { attribution: "invalid", decisionBasis: "hard-violation" },
    });
  });

  test("rejects malformed core decision evidence instead of treating it as uncertainty", async () => {
    const malformed = modelResponse("allow", 0.99, 0.1);
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch([], {
        ...malformed,
        answers: {
          ...malformed.answers,
          decision: { type: "choice", choice: "allow", confidence: 2 },
        },
      }),
    });
    expect(await model.evaluate(createRequest())).toMatchObject({
      kind: "unavailable",
      diagnostics: { unavailableReason: "invalid-response" },
    });
  });

  test("prompts for a token and returns it for OMP credential persistence", async () => {
    let providerConfig: ProviderConfig | undefined;
    const validated: string[] = [];
    registerTypeSafeProvider(
      {
        registerProvider(name: string, config: ProviderConfig) {
          expect(name).toBe("typesafe-ai");
          providerConfig = config;
        },
      } as unknown as ExtensionAPI,
      {
        validateApiKey: async (apiKey) => {
          validated.push(apiKey);
        },
      },
    );
    expect(providerConfig?.apiKey).toBeUndefined();
    const login = providerConfig?.oauth?.login;
    if (login === undefined) {
      throw new Error("TypeSafe login provider was not registered");
    }

    const credential = await login({
      onAuth() {},
      async onPrompt() {
        return "  fixture-token  ";
      },
      onProgress() {},
    });

    expect(credential).toBe("fixture-token");
    expect(validated).toEqual(["fixture-token"]);
  });
});

function modelResponse(
  rawChoice: "allow" | "prompt" | "deny",
  confidence: number,
  hardViolation: number,
  matchedRule = "none",
) {
  return {
    model: DEFAULT_TYPESAFE_POLICY_MODEL,
    answers: {
      decision: {
        type: "choice",
        choice: rawChoice,
        confidence,
        probabilities: { allow: confidence, prompt: 1 - confidence, deny: 0 },
      },
      hardViolation: { type: "noul", noul: hardViolation },
      matchedRule: {
        type: "choice",
        choice: matchedRule,
        confidence: 0.95,
        probabilities:
          matchedRule === "none" ? { none: 0.95, r0: 0.05 } : { [matchedRule]: 0.95, none: 0.05 },
      },
    },
    usage: { input_tokens: 50, output_tokens: 5 },
  };
}

function createFetch(captured: CapturedRequest[], systemOneResult?: unknown): Fetch {
  return async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    captured.push({ url: input, ...(body === undefined ? {} : { body }) });
    if (input.endsWith("/v1/models")) {
      return jsonResponse({
        models: [
          {
            name: DEFAULT_TYPESAFE_POLICY_MODEL,
            description: "fixture",
            release_date: "2025-01-01",
          },
        ],
      });
    }
    return jsonResponse(systemOneResult);
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createRequest(): PolicyModelRequest {
  const action = createTestPolicyAction("write");
  const snapshot: PolicySnapshot = {
    schemaVersion: 1,
    id: "snapshot-1",
    projectRoot: action.workingDirectory,
    createdAtMs: 1,
    versions: {
      compiler: "compiler-1",
      question: "question-1",
      thresholds: "thresholds-1",
      model: DEFAULT_TYPESAFE_POLICY_MODEL,
    },
    sources: [
      {
        id: "root",
        kind: "project",
        path: "/workspace/project/AGENTS.md",
        scopeRoot: "/workspace/project",
        content: "TOKEN=super-secret-value",
        contentDigest: "root-digest",
        precedence: 100,
      },
      {
        id: "web",
        kind: "subtree",
        path: "/workspace/project/web/AGENTS.md",
        scopeRoot: "/workspace/project/web",
        content: "unrelated-web-rule",
        contentDigest: "web-digest",
        precedence: 201,
      },
    ],
    rules: [
      {
        id: "root-rule",
        sourceId: "root",
        sourceKind: "project",
        scopeRoot: "/workspace/project",
        classification: "hard",
        statement: "Never expose TOKEN=super-secret-value",
        precedence: 100,
      },
      {
        id: "web-rule",
        sourceId: "web",
        sourceKind: "subtree",
        scopeRoot: "/workspace/project/web",
        classification: "semantic",
        statement: "unrelated-web-rule",
        precedence: 201,
      },
    ],
  };

  return {
    action: {
      ...action,
      targets: [
        { kind: "path", value: "src/index.ts" },
        { kind: "command", value: "API_KEY=super-secret-value deploy" },
      ],
      hostAction: {
        host: "omp",
        name: "bash",
        input: { command: "API_KEY=super-secret-value deploy", token: "hostInputSecret" },
      },
      details: { command: "API_KEY=super-secret-value deploy" },
    },
    snapshot,
    authorization: {
      source: "current-turn",
      explicit: true,
      summary: "Use TOKEN=super-secret-value",
    },
  };
}
