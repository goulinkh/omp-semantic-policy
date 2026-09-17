export type PolicyEvidenceSource = "deterministic" | "semantic" | "fallback";

export interface DecisionEvidence {
  readonly evaluatorId: string;
  readonly source: PolicyEvidenceSource;
  readonly ruleIds: readonly string[];
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
