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

interface CapturedRequest {
  readonly url: string;
  readonly body?: string;
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
        },
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    });

    const result = await model.evaluate(createRequest());
    const body = captured[0]?.body ?? "";

    expect(result).toEqual({
      kind: "decision",
      effect: "deny",
      confidence: 0.99,
      hardViolationProbability: 0.91,
      model: DEFAULT_TYPESAFE_POLICY_MODEL,
      usage: { inputTokens: 50, outputTokens: 5 },
    });
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("super-secret-value");
    expect(body).not.toContain("hostInputSecret");
    expect(body).not.toContain("unrelated-web-rule");
  });

  test("partitions large policy state without dropping rules", async () => {
    const captured: CapturedRequest[] = [];
    const request = createRequest();
    const rootRule = request.snapshot.rules[0];
    if (rootRule === undefined) {
      throw new Error("Root rule fixture is missing");
    }
    const rules = Array.from({ length: 320 }, (_, index) => ({
      ...rootRule,
      id: `rule-${index}`,
      statement: `Rule ${index}: ${"bounded policy text ".repeat(18)}`,
    }));
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
          hardViolation: { type: "noul", noul: 0.01 },
        },
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    });

    const result = await model.evaluate({
      ...request,
      snapshot: { ...request.snapshot, rules },
    });
    const sentRuleIds = captured.flatMap(({ body }) => {
      const payload = JSON.parse(body ?? "{}") as {
        state?: { policy?: { rules?: Array<{ id?: string }> } };
      };
      return (payload.state?.policy?.rules ?? []).flatMap((rule) =>
        rule.id === undefined ? [] : [rule.id],
      );
    });

    expect(captured.length).toBeGreaterThan(1);
    expect(captured.every(({ body }) => Buffer.byteLength(body ?? "") < 44_000)).toBe(true);
    expect(sentRuleIds).toEqual(rules.map((rule) => rule.id));
    expect(result).toMatchObject({
      kind: "decision",
      effect: "allow",
      usage: {
        inputTokens: captured.length * 50,
        outputTokens: captured.length * 5,
      },
    });
  });

  test("prompts for a token and returns it for OMP credential persistence", async () => {
    let providerConfig: ProviderConfig | undefined;
    const validated: string[] = [];
    const progress: string[] = [];
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
      async onPrompt(prompt) {
        expect(prompt.message).toBe("Paste your TypeSafe API token");
        expect(prompt.placeholder).toBe("TypeSafe API token");
        return "  fixture-token  ";
      },
      onProgress(message) {
        progress.push(message);
      },
    });

    expect(credential).toBe("fixture-token");
    expect(validated).toEqual(["fixture-token"]);
    expect(progress).toEqual(["Validating TypeSafe API token…"]);
  });
});

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
        input: { token: "hostInputSecret" },
      },
    },
    snapshot,
    authorization: {
      source: "current-turn",
      explicit: true,
      summary: "Use TOKEN=super-secret-value",
    },
  };
}
