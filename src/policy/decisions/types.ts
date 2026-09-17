import type { PolicyModelDiagnostics } from "../models/types.js";

export type PolicyEvidenceSource = "deterministic" | "semantic" | "fallback";

export interface PolicyConfirmationDiagnostics {
  readonly resolution:
    | "not-required"
    | "pending"
    | "automatic-approve"
    | "automatic-deny"
    | "maintenance-approved"
    | "user-approved"
    | "user-denied"
    | "headless-denied";
  readonly confidence?: number;
}

/** Persistence-safe explanation of the provider, adapter, and final enforcement stages. */
export interface PolicyDecisionDiagnostics {
  readonly path:
    | "local-denial"
    | "coverage-bypass"
    | "no-applicable-rules"
    | "semantic"
    | "provider-unavailable"
    | "incomplete-action";
  readonly semantic?: PolicyModelDiagnostics;
  readonly decisiveRule?: {
    readonly ruleId: string;
    readonly sourceId: string;
    readonly sourcePath?: string;
  };
  readonly confirmation: PolicyConfirmationDiagnostics;
  readonly enforcedEffect: "allow" | "prompt" | "deny" | "revise";
}

export interface DecisionEvidence {
  readonly evaluatorId: string;
  readonly source: PolicyEvidenceSource;
  readonly ruleIds: readonly string[];
  readonly applicableRuleIds?: readonly string[];
  readonly diagnostics?: PolicyDecisionDiagnostics;
}

export type PolicyDecision =
  | {
      readonly effect: "allow";
      readonly evidence: DecisionEvidence;
    }
  | {
      readonly effect: "prompt";
      readonly reason: string;
      readonly evidence: DecisionEvidence;
    }
  | {
      readonly effect: "deny";
      readonly reason: string;
      readonly evidence: DecisionEvidence;
    }
  | {
      readonly effect: "revise";
      readonly input: Readonly<Record<string, unknown>>;
      readonly reason: string;
      readonly evidence: DecisionEvidence;
    };

export type PolicyDecisionDraft =
  | {
      readonly effect: "allow";
      readonly ruleIds?: readonly string[];
    }
  | {
      readonly effect: "prompt";
      readonly reason: string;
      readonly ruleIds?: readonly string[];
    }
  | {
      readonly effect: "deny";
      readonly reason: string;
      readonly ruleIds?: readonly string[];
    }
  | {
      readonly effect: "revise";
      readonly input: Readonly<Record<string, unknown>>;
      readonly reason: string;
      readonly ruleIds?: readonly string[];
    };
