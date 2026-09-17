import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
      readonly partition?: { readonly index: number; readonly count: number };
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

  test("keeps a fitting policy together and partitions a 40001-byte multi-rule policy", async () => {
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
      kind: "decision",
      effect: "allow",
      ruleIds: [],
      diagnostics: {
        decisionBasis: "chunk-aggregation",
        aggregation: {
          totalChunks: 2,
          assessedChunks: 2,
          complete: true,
          originalStateBytes: 40_001,
        },
      },
    });
    expect(captured).toHaveLength(4);
    const chunks = captured
      .slice(2)
      .map(({ body }) => JSON.parse(body ?? "{}") as CapturedWireRequest);
    expect(chunks.flatMap(({ state }) => state.policy.rules.map((rule) => rule[4]))).toEqual([
      "x".repeat(padding + 1) + createRedactedProviderState(baseRequest).policy.rules[0]?.statement,
      permission.statement,
    ]);
    expect(chunks.map(({ state }) => state.policy.partition)).toEqual([
      { index: 0, count: 2 },
      { index: 1, count: 2 },
    ]);
    for (const { state } of chunks) {
      expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(40_000);
    }
  });

  test("rejects indivisible oversized rules and UTF-8 action state before any provider call", async () => {
    const captured: CapturedRequest[] = [];
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: createFetch(captured, modelResponse("allow", 0.99, 0.01)),
    });
    const request = createChunkedRequest(1, 40_001);
    expect(await model.evaluate(request)).toMatchObject({
      kind: "unavailable",
      diagnostics: { unavailableReason: "context-limit" },
    });
    const oversizedAction = {
      ...createRequest(),
      action: { ...request.action, details: { task: "界".repeat(14_000) } },
    };
    expect(createRedactedProviderState(oversizedAction).action.complete).toBe(true);
    expect(await model.evaluate(oversizedAction)).toMatchObject({
      kind: "unavailable",
      diagnostics: { unavailableReason: "context-limit" },
    });
    expect(captured).toHaveLength(0);
  });

  test("covers every rule losslessly before allowing, with at most four concurrent requests", async () => {
    const request = createChunkedRequest(7);
    const canonical = createRedactedProviderState(request);
    const gate = createGatedFetch();
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: gate.fetch,
    });
    const pending = model.evaluate(request);
    await gate.waitForCount(4);
    expect(gate.calls).toHaveLength(4);
    expect(gate.active()).toBe(4);
    // A completed request opens exactly one slot; other in-flight requests remain blocked.
    gate.respond(2, modelResponse("allow", 0.99, 0.01, gate.alias(2)));
    await gate.waitForCount(5);
    expect(gate.active()).toBe(4);
    gate.respond(0, modelResponse("allow", 0.99, 0.01, gate.alias(0)));
    await gate.waitForCount(6);
    gate.respond(1, modelResponse("allow", 0.99, 0.01, gate.alias(1)));
    await gate.waitForCount(7);
    for (const index of [3, 4, 5, 6]) {
      gate.respond(index, modelResponse("allow", 0.99, 0.01, gate.alias(index)));
    }
    const result = await pending;
    expect(gate.maxActive()).toBe(4);
    expect(result).toMatchObject({
      kind: "decision",
      effect: "allow",
      ruleIds: request.snapshot.rules.map((rule) => rule.id),
      usage: { inputTokens: 350, outputTokens: 35 },
      diagnostics: {
        decisionBasis: "chunk-aggregation",
        aggregation: {
          strategy: "all-allow-any-deny",
          totalChunks: 7,
          assessedChunks: 7,
          attemptedChunks: 7,
          concurrencyLimit: 4,
          complete: true,
        },
      },
    });
    expect(result.diagnostics?.rawChoice).toBeUndefined();
    expect(result.diagnostics?.rawConfidence).toBeUndefined();
    const states = gate.calls.map(({ state }) => state);
    const restored = states.flatMap((state) =>
      state.policy.rules.map(([, classification, sourceIndex, contextIndex, statement]) => ({
        class: classification,
        sourceId: state.policy.sources[sourceIndex]?.[0],
        precedence: state.policy.sources[sourceIndex]?.[1],
        context: state.policy.contexts[contextIndex],
        statement,
      })),
    );
    expect(restored).toEqual(
      canonical.policy.rules.map(({ id: _id, context, ...rule }) => ({
        ...rule,
        context: context ?? [],
      })),
    );
    for (const [index, state] of states.entries()) {
      expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(40_000);
      expect(state.action).toEqual(canonical.action);
      expect(state.authorization).toEqual(canonical.authorization);
      expect(state.policy.partition).toEqual({ index, count: 7 });
    }
    const sizes = states.map((state) => Buffer.byteLength(JSON.stringify(state)));
    expect(result.diagnostics).toMatchObject({
      stateBytes: Math.max(...sizes),
      aggregation: { totalStateBytes: sizes.reduce((total, size) => total + size, 0) },
      chunks: states.map((state, index) => ({
        index,
        attempted: true,
        applicableRuleIds: [request.snapshot.rules[index]?.id],
        ruleIds: [request.snapshot.rules[index]?.id],
        stateDigest: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
        diagnostics: { status: "assessed", adapterEffect: "allow" },
      })),
    });
  });

  test("a valid denying chunk wins over an allowing chunk and a failed sibling", async () => {
    const request = createChunkedRequest(3);
    const gate = createGatedFetch();
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: gate.fetch,
    });
    const pending = model.evaluate(request);
    await gate.waitForCount(3);
    gate.fail(0);
    gate.respond(1, modelResponse("allow", 0.99, 0.01, gate.alias(1)));
    gate.respond(2, modelResponse("allow", 0.99, 0.8, gate.alias(2)));
    expect(await pending).toMatchObject({
      kind: "decision",
      effect: "deny",
      ruleIds: [request.snapshot.rules[2]?.id],
      usage: { inputTokens: 100, outputTokens: 10 },
      diagnostics: {
        decisionBasis: "chunk-aggregation",
        aggregation: { totalChunks: 3, attemptedChunks: 3, assessedChunks: 2, complete: false },
      },
    });
    expect(gate.calls).toHaveLength(3);
  });

  test("one uncertain chunk prevents allow and cites only the prompting chunk", async () => {
    const request = createChunkedRequest(2);
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: async (_input, init) => {
        const { state } = parseWireRequest(init?.body);
        return jsonResponse(
          modelResponse(
            "allow",
            state.policy.partition?.index === 0 ? 0.64 : 0.99,
            0.01,
            state.policy.rules[0]?.[0],
          ),
        );
      },
    });
    expect(await model.evaluate(request)).toMatchObject({
      kind: "decision",
      effect: "prompt",
      ruleIds: [request.snapshot.rules[0]?.id],
      diagnostics: { aggregation: { complete: true, assessedChunks: 2 } },
    });
  });

  test("a malformed or missing chunk assessment cannot be filled in by an allowing sibling", async () => {
    const valid = modelResponse("allow", 0.99, 0.01);
    for (const invalid of [
      {
        ...valid,
        answers: { ...valid.answers, decision: { type: "choice", choice: "allow", confidence: 2 } },
      },
      {
        ...valid,
        answers: { decision: valid.answers.decision, matchedRule: valid.answers.matchedRule },
      },
    ]) {
      let calls = 0;
      const model = createTypeSafePolicyModel({
        apiKey: "fixture-key",
        hasConsent: () => true,
        fetch: async (_input, init) => {
          calls += 1;
          return jsonResponse(
            parseWireRequest(init?.body).state.policy.partition?.index === 0 ? valid : invalid,
          );
        },
      });
      expect(await model.evaluate(createChunkedRequest(2))).toMatchObject({
        kind: "unavailable",
        diagnostics: {
          aggregation: { totalChunks: 2, attemptedChunks: 2, assessedChunks: 1, complete: false },
        },
      });
      expect(calls).toBe(2);
    }
  });

  test("a citation alias from another chunk cannot authorize an allowing chunk", async () => {
    const request = createChunkedRequest(3);
    const rules = request.snapshot.rules.map((rule, index) => ({
      ...rule,
      statement: rule.statement.slice(0, index < 2 ? 10_000 : 21_000),
    }));
    const gate = createGatedFetch();
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: gate.fetch,
    });
    const pending = model.evaluate({ ...request, snapshot: { ...request.snapshot, rules } });
    await gate.waitForCount(2);
    const secondAliases = new Set(gate.calls[1]?.state.policy.rules.map((rule) => rule[0]));
    const foreignAlias = gate.calls[0]?.state.policy.rules.find(
      (rule) => !secondAliases.has(rule[0]),
    )?.[0];
    if (foreignAlias === undefined)
      throw new Error("Expected a citation available only in the first chunk");
    gate.respond(0, modelResponse("allow", 0.99, 0.01));
    gate.respond(1, modelResponse("allow", 0.99, 0.01, foreignAlias));
    expect(await pending).toMatchObject({
      kind: "unavailable",
      diagnostics: { aggregation: { complete: false } },
    });
  });

  test("caller cancellation aborts in-flight requests and never starts queued chunks", async () => {
    const gate = createGatedFetch();
    const controller = new AbortController();
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: gate.fetch,
    });
    const pending = model.evaluate(createChunkedRequest(7), controller.signal);
    await gate.waitForCount(4);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.calls).toHaveLength(4);
    expect(gate.signals.every((signal) => signal?.aborted)).toBe(true);
    expect(gate.active()).toBe(0);
  });

  test("the evaluation deadline aborts a blocked batch without starting queued chunks", async () => {
    const gate = createGatedFetch();
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => true,
      fetch: gate.fetch,
      timeoutMs: 100,
    });
    const pending = model.evaluate(createChunkedRequest(7));
    expect(await pending).toMatchObject({
      kind: "unavailable",
      diagnostics: { aggregation: { totalChunks: 7, attemptedChunks: 4, complete: false } },
    });
    expect(gate.calls).toHaveLength(4);
    expect(gate.signals.every((signal) => signal?.aborted)).toBe(true);
    expect(gate.active()).toBe(0);
  });

  test("revoking consent mid-batch prevents queued requests and prevents aggregate allow", async () => {
    const gate = createGatedFetch();
    let consent = true;
    const model = createTypeSafePolicyModel({
      apiKey: "fixture-key",
      hasConsent: () => consent,
      fetch: gate.fetch,
    });
    const pending = model.evaluate(createChunkedRequest(7));
    await gate.waitForCount(4);
    consent = false;
    for (let index = 0; index < 4; index += 1) {
      gate.respond(index, modelResponse("allow", 0.99, 0.01));
    }
    expect(await pending).toMatchObject({
      kind: "unavailable",
      diagnostics: { aggregation: { totalChunks: 7, attemptedChunks: 4, complete: false } },
    });
    expect(gate.calls).toHaveLength(4);
  });

  test("different resolved models cannot aggregate to allow but cannot erase a denial", async () => {
    for (const deny of [false, true]) {
      const model = createTypeSafePolicyModel({
        apiKey: "fixture-key",
        hasConsent: () => true,
        fetch: async (_input, init) => {
          const index = parseWireRequest(init?.body).state.policy.partition?.index;
          return jsonResponse({
            ...modelResponse("allow", 0.99, deny && index === 1 ? 0.8 : 0.01),
            model: index === 0 ? "resolved-a" : "resolved-b",
          });
        },
      });
      expect(await model.evaluate(createChunkedRequest(2))).toMatchObject(
        deny ? { kind: "decision", effect: "deny" } : { kind: "unavailable" },
      );
    }
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

function createChunkedRequest(ruleCount: number, statementBytes = 21_000): PolicyModelRequest {
  const request = createRequest();
  const root = request.snapshot.rules[0];
  if (root === undefined) throw new Error("Root rule fixture is missing");
  return {
    ...request,
    snapshot: {
      ...request.snapshot,
      rules: Array.from({ length: ruleCount }, (_, index) => ({
        ...root,
        id: `chunk-rule-${index}`,
        context: ["Batch policy", "Applicable operations"],
        statement: `Rule ${index}: `.padEnd(statementBytes, "x "),
      })),
    },
  };
}

function parseWireRequest(body: unknown): CapturedWireRequest {
  if (typeof body !== "string") throw new Error("Expected a serialized provider request");
  return JSON.parse(body) as CapturedWireRequest;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createGatedFetch() {
  const calls: CapturedWireRequest[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const responses: Deferred<Response>[] = [];
  const waiters: { count: number; resolve: (value: void) => void }[] = [];
  let active = 0;
  let maximum = 0;
  const fetch: Fetch = async (_input, init) => {
    const response = deferred<Response>();
    calls.push(parseWireRequest(init?.body));
    responses.push(response);
    const signal = init?.signal;
    signals.push(signal);
    active += 1;
    maximum = Math.max(maximum, active);
    const abort = () => response.reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const waiter of waiters) {
      if (calls.length >= waiter.count) waiter.resolve();
    }
    try {
      return await response.promise;
    } finally {
      active -= 1;
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    fetch,
    calls,
    signals,
    active: () => active,
    maxActive: () => maximum,
    waitForCount(count: number): Promise<void> {
      if (calls.length >= count) return Promise.resolve();
      const waiter = deferred<void>();
      waiters.push({ count, resolve: waiter.resolve });
      return waiter.promise;
    },
    alias(index: number): string {
      const alias = calls[index]?.state.policy.rules[0]?.[0];
      if (alias === undefined) throw new Error(`No rule in provider request ${index}`);
      return alias;
    },
    respond(index: number, value: unknown) {
      const response = responses[index];
      if (response === undefined) throw new Error(`No pending provider request ${index}`);
      response.resolve(jsonResponse(value));
    },
    fail(index: number) {
      const response = responses[index];
      if (response === undefined) throw new Error(`No pending provider request ${index}`);
      response.reject(new Error("Fixture provider transport failure"));
    },
  };
}
