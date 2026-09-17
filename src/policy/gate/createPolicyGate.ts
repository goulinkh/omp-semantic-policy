import type { PolicyAction, PolicyEvaluationContext } from "../actions/types.js";
import type {
  DecisionEvidence,
  PolicyDecision,
  PolicyDecisionDraft,
  PolicyEvidenceSource,
} from "../decisions/types.js";

export interface PolicyEvaluator {
  readonly id: string;
  readonly source: Exclude<PolicyEvidenceSource, "fallback">;
  evaluate(
    action: PolicyAction,
    context: PolicyEvaluationContext,
    signal?: AbortSignal,
  ): PolicyDecisionDraft | undefined | Promise<PolicyDecisionDraft | undefined>;
}

export interface PolicyFallbackEvaluator {
  readonly id: string;
  evaluate(
    action: PolicyAction,
    context: PolicyEvaluationContext,
    signal?: AbortSignal,
  ): PolicyDecisionDraft | Promise<PolicyDecisionDraft>;
}

export interface PolicyGate {
  evaluate(
    action: PolicyAction,
    context: PolicyEvaluationContext,
    signal?: AbortSignal,
  ): Promise<PolicyDecision>;
}

export interface PolicyGateOptions {
  readonly deterministicEvaluators: readonly PolicyEvaluator[];
  readonly semanticEvaluator?: PolicyEvaluator;
  readonly fallbackEvaluator: PolicyFallbackEvaluator;
}

/**
 * Build a gate with explicit precedence.
 *
 * Deterministic evaluators run in declaration order. Their first decision is
 * final, so a later semantic evaluator cannot weaken a deterministic result.
 * Semantic evaluation runs only when every deterministic evaluator abstains.
 */
export function createPolicyGate(options: PolicyGateOptions): PolicyGate {
  const deterministicEvaluators = [...options.deterministicEvaluators];
  const semanticEvaluator = options.semanticEvaluator;
  const fallbackEvaluator = options.fallbackEvaluator;

  return {
    async evaluate(action, context, signal) {
      signal?.throwIfAborted();

      for (const evaluator of deterministicEvaluators) {
        const draft = await evaluator.evaluate(action, context, signal);
        signal?.throwIfAborted();
        if (draft !== undefined) {
          return finalizeDecision(draft, evaluator.id, evaluator.source);
        }
      }

      if (semanticEvaluator !== undefined) {
        const draft = await semanticEvaluator.evaluate(action, context, signal);
        signal?.throwIfAborted();
        if (draft !== undefined) {
          return finalizeDecision(draft, semanticEvaluator.id, semanticEvaluator.source);
        }
      }

      const fallback = await fallbackEvaluator.evaluate(action, context, signal);
      signal?.throwIfAborted();
      return finalizeDecision(fallback, fallbackEvaluator.id, "fallback");
    },
  };
}

function finalizeDecision(
  draft: PolicyDecisionDraft,
  evaluatorId: string,
  source: PolicyEvidenceSource,
): PolicyDecision {
  const evidence: DecisionEvidence = {
    evaluatorId,
    source,
    ruleIds: draft.ruleIds === undefined ? [] : [...draft.ruleIds],
  };

  switch (draft.effect) {
    case "allow":
      return { effect: "allow", evidence };
    case "prompt":
      return { effect: "prompt", reason: draft.reason, evidence };
    case "deny":
      return { effect: "deny", reason: draft.reason, evidence };
    case "revise":
      return { effect: "revise", input: { ...draft.input }, reason: draft.reason, evidence };
  }
}
