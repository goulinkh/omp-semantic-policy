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

export interface EvaluateSnapshotPolicyOptions {
  readonly action: PolicyAction;
  readonly context: PolicyEvaluationContext;
  readonly snapshot?: PolicySnapshot;
  readonly model?: PolicyModel;
  readonly signal?: AbortSignal;
}

/** Apply deterministic coverage, then semantic policy, then conservative fallback. */
export async function evaluateSnapshotPolicy(
  options: EvaluateSnapshotPolicyOptions,
): Promise<PolicyDecision> {
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
              return {
                effect: result.effect,
                reason:
                  result.effect === "deny"
                    ? `Semantic policy denied the action (hard-rule probability ${formatProbability(result.hardViolationProbability)}).`
                    : `Semantic policy requires confirmation (confidence ${formatProbability(result.confidence)}).`,
                ruleIds: applicableRuleIds,
              };
            },
          },
        }),
    fallbackEvaluator: createConservativeFallback(),
  });

  return gate.evaluate(options.action, options.context, options.signal);
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

function formatProbability(value: number): string {
  return `${Math.round(value * 100)}%`;
}
