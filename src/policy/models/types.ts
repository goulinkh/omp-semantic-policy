import type { AuthorizationEnvelope, PolicyAction } from "../actions/types.js";
import type { PolicySnapshot } from "../snapshots/types.js";

export interface PolicyModelValidation {
  readonly model: string;
  readonly availableModels: readonly string[];
}

export interface PolicyModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type PolicyModelResult =
  | {
      readonly kind: "decision";
      readonly effect: "allow" | "prompt" | "deny";
      readonly confidence: number;
      readonly hardViolationProbability: number;
      readonly model: string;
      readonly usage: PolicyModelUsage;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
    };

export interface PolicyModelRequest {
  readonly action: PolicyAction;
  readonly snapshot: PolicySnapshot;
  readonly authorization?: AuthorizationEnvelope;
}

/** Provider-independent semantic evaluator used after deterministic rules abstain. */
export interface PolicyModel {
  readonly providerId: string;
  readonly modelVersion: string;
  validate(signal?: AbortSignal): Promise<PolicyModelValidation>;
  evaluate(request: PolicyModelRequest, signal?: AbortSignal): Promise<PolicyModelResult>;
}
