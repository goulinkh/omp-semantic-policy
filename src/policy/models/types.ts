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

export type PolicyModelUnavailableReason =
  | "not-consented"
  | "context-limit"
  | "incomplete-action"
  | "invalid-response"
  | "provider-error"
  | "missing-model"
  | "missing-snapshot";

/** Provider trace containing only validated labels, probabilities, and accounting metadata. */
export interface PolicyModelDiagnostics {
  readonly status: "assessed" | "unavailable";
  readonly providerId: string;
  readonly requestedModel: string;
  readonly model?: string;
  readonly usage?: PolicyModelUsage;
  readonly rawChoice?: "allow" | "prompt" | "deny";
  readonly rawConfidence?: number;
  readonly hardViolationProbability?: number;
  readonly adapterEffect?: "allow" | "prompt" | "deny";
  readonly decisionBasis?: "choice" | "hard-violation" | "low-confidence";
  readonly attribution?: "validated" | "none" | "invalid" | "missing";
  readonly unavailableReason?: PolicyModelUnavailableReason;
  readonly stateBytes?: number;
}

export type PolicyModelResult =
  | {
      readonly kind: "decision";
      readonly effect: "allow" | "prompt" | "deny";
      readonly confidence: number;
      readonly hardViolationProbability: number;
      readonly model: string;
      /** Actual validated model-reported matches, never every candidate rule. */
      readonly ruleIds?: readonly string[];
      readonly diagnostics?: PolicyModelDiagnostics;
      readonly usage: PolicyModelUsage;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly diagnostics?: PolicyModelDiagnostics;
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
