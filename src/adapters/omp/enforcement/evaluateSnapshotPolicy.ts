import type {
  PolicyAction,
  PolicyDecision,
  PolicyEvaluationContext,
  PolicyModel,
  PolicySnapshot,
} from "../../../policy/index.js";
import {
  createConservativeFallback,
  createPolicyGate,
  selectApplicableSources,
} from "../../../policy/index.js";

export interface PolicyConfirmationSettings {
  readonly defaultAction: "approve" | "deny";
  readonly threshold: number;
}

export interface EvaluateSnapshotPolicyOptions {
  readonly action: PolicyAction;
  readonly context: PolicyEvaluationContext;
  readonly snapshot?: PolicySnapshot;
  readonly model?: PolicyModel;
  readonly signal?: AbortSignal;
  readonly confirmation?: PolicyConfirmationSettings;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.65;

/** Apply deterministic coverage, then semantic policy, then conservative fallback. */
export async function evaluateSnapshotPolicy(
  options: EvaluateSnapshotPolicyOptions,
): Promise<PolicyDecision> {
  let semanticConfirmationConfidence: number | undefined;
  const applicableRuleIds = getApplicableRuleIds(options.snapshot, options.action);
  const gate = createPolicyGate({
    deterministicEvaluators: [
      {
        id: "compiled-policy-coverage",
        source: "deterministic",
        evaluate() {
          if (options.snapshot !== undefined && applicableRuleIds.length === 0) {
            return { effect: "allow", ruleIds: ["snapshot.no-applicable-rules"] };
          }
          return undefined;
        },
      },
    ],
    ...(options.snapshot === undefined || options.model === undefined
      ? {}
      : {
          semanticEvaluator: {
            id: `${options.model.providerId}:${options.model.modelVersion}`,
            source: "semantic" as const,
            async evaluate(action, context, signal) {
              const result = await options.model?.evaluate(
                {
                  action,
                  snapshot: options.snapshot as PolicySnapshot,
                  ...(context.authorization === undefined
                    ? {}
                    : { authorization: context.authorization }),
                },
                signal,
              );
              if (result === undefined || result.kind === "unavailable") {
                return undefined;
              }
              if (result.effect === "allow") {
                return { effect: "allow" as const, ruleIds: applicableRuleIds };
              }
              semanticConfirmationConfidence =
                result.effect === "prompt" ? result.confidence : undefined;
              return {
                effect: result.effect,
                reason:
                  result.effect === "deny"
                    ? `Semantic policy denied the action (hard-rule probability ${formatProbability(result.hardViolationProbability)}).`
                    : formatConfirmationReason(result.confidence),
                ruleIds: applicableRuleIds,
              };
            },
          },
        }),
    fallbackEvaluator: createConservativeFallback(),
  });

  const decision = await gate.evaluate(options.action, options.context, options.signal);
  return resolveConfirmation(
    decision,
    semanticConfirmationConfidence,
    options.confirmation ?? { defaultAction: "deny", threshold: 1 },
  );
}

function getApplicableRuleIds(
  snapshot: PolicySnapshot | undefined,
  action: PolicyAction,
): readonly string[] {
  if (snapshot === undefined) {
    return [];
  }
  const sourceIds = new Set(
    selectApplicableSources(snapshot.sources, action).map((source) => source.id),
  );
  return snapshot.rules.filter((rule) => sourceIds.has(rule.sourceId)).map((rule) => rule.id);
}

function resolveConfirmation(
  decision: PolicyDecision,
  semanticConfidence: number | undefined,
  settings: PolicyConfirmationSettings,
): PolicyDecision {
  if (decision.effect !== "prompt") {
    return decision;
  }

  const confidence = semanticConfidence ?? 1;
  if (settings.threshold < 1 && confidence >= settings.threshold) {
    return decision;
  }
  if (settings.defaultAction === "approve") {
    return { effect: "allow", evidence: decision.evidence };
  }
  return {
    effect: "deny",
    reason: formatAutomaticDenialReason(semanticConfidence),
    evidence: decision.evidence,
  };
}
function formatAutomaticDenialReason(confidence: number | undefined): string {
  if (confidence === undefined) {
    return "Policy confirmation denied by configuration.";
  }
  return `Policy confirmation denied by configuration · ${formatConfidenceBand(confidence)} confidence · ${formatProbability(confidence)}.`;
}

function formatConfidenceBand(confidence: number): "high" | "medium" | "low" {
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) {
    return "high";
  }
  return confidence >= MEDIUM_CONFIDENCE_THRESHOLD ? "medium" : "low";
}

function formatConfirmationReason(confidence: number): string {
  const percentage = formatProbability(confidence);
  const band = formatConfidenceBand(confidence);
  if (band === "high") {
    return `🔐 Confirmation required · high confidence · ${percentage}`;
  }
  if (band === "medium") {
    return `⚠️ Confirmation recommended · medium confidence · ${percentage}`;
  }
  return `🤔 Policy match is uncertain · please confirm · ${percentage}`;
}

function formatProbability(value: number): string {
  return `${Math.round(value * 100)}%`;
}
