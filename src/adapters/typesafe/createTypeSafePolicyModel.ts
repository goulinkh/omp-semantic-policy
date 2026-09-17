import { TypeSafeClient, choice, noul, type Fetch } from "@typesafe-ai/sdk";
import type {
  PolicyModel,
  PolicyModelRequest,
  PolicyModelResult,
  PolicyModelValidation,
} from "../../policy/index.js";
import { createRedactedProviderState } from "./redactProviderState.js";

export const DEFAULT_TYPESAFE_POLICY_MODEL = "jev-latest";
export const TYPESAFE_QUESTION_VERSION = "policy-decision-v1";
export const TYPESAFE_THRESHOLD_VERSION = "policy-thresholds-v1";

const DECISION_CONFIDENCE_THRESHOLD = 0.65;
const HARD_VIOLATION_THRESHOLD = 0.8;
const DECISION_QUESTION = choice(
  "Choose the safest enforcement outcome required by the applicable policy rules.",
  {
    allow: "The action complies with all applicable rules and needs no user confirmation.",
    prompt:
      "The action may be acceptable but requires explicit user confirmation or clarification.",
    deny: "The action conflicts with an applicable rule and must not execute.",
  },
);
const HARD_VIOLATION_QUESTION = noul(
  "Would executing this action violate an explicit MUST, NEVER, prohibition, or required workflow step?",
  {
    true: "At least one applicable hard or workflow rule would be violated.",
    false: "No applicable hard or workflow rule would be violated.",
  },
);

export interface TypeSafePolicyModelOptions {
  readonly apiKey: string;
  readonly modelVersion?: string;
  readonly baseURL?: string;
  readonly fetch?: Fetch;
  readonly hasConsent: () => boolean;
  readonly timeoutMs?: number;
}

export function createTypeSafePolicyModel(options: TypeSafePolicyModelOptions): PolicyModel {
  const modelVersion = options.modelVersion ?? DEFAULT_TYPESAFE_POLICY_MODEL;
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    defaultModel: modelVersion,
    logLevel: "off",
    timeout: options.timeoutMs ?? 10_000,
    retry: { maxRetries: 0 },
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    providerId: "typesafe-ai",
    modelVersion,
    async validate(signal): Promise<PolicyModelValidation> {
      assertConsent(options.hasConsent());
      const availableModels = (
        await client.models.list(signal === undefined ? {} : { signal })
      ).map((model) => model.name);
      return { model: modelVersion, availableModels };
    },
    async evaluate(request: PolicyModelRequest, signal?: AbortSignal): Promise<PolicyModelResult> {
      if (!options.hasConsent()) {
        return {
          kind: "unavailable",
          reason: "Remote semantic evaluation has not been consented to.",
        };
      }

      try {
        const result = await client.systemOne(
          {
            state: createRedactedProviderState(request),
            questions: {
              decision: DECISION_QUESTION,
              hardViolation: HARD_VIOLATION_QUESTION,
            },
            model: modelVersion,
          },
          signal === undefined ? {} : { signal },
        );
        const decision = result.answers.decision;
        const hardViolation = result.answers.hardViolation.noul;
        const effect = resolveEffect(decision.choice, decision.confidence, hardViolation);
        return {
          kind: "decision",
          effect,
          confidence: decision.confidence,
          hardViolationProbability: hardViolation,
          model: result.model,
          usage: {
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
          },
        };
      } catch {
        return { kind: "unavailable", reason: "TypeSafe policy evaluation is unavailable." };
      }
    },
  };
}

function resolveEffect(
  choiceResult: string,
  confidence: number,
  hardViolation: number,
): "allow" | "prompt" | "deny" {
  if (hardViolation >= HARD_VIOLATION_THRESHOLD) {
    return "deny";
  }
  if (confidence < DECISION_CONFIDENCE_THRESHOLD) {
    return "prompt";
  }
  if (choiceResult === "allow" || choiceResult === "deny") {
    return choiceResult;
  }
  return "prompt";
}

function assertConsent(consented: boolean): void {
  if (!consented) {
    throw new Error("Remote semantic evaluation has not been consented to.");
  }
}
