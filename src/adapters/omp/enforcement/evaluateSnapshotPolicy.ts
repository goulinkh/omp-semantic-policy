import type {
  PolicyAction,
  PolicyDecision,
  PolicyEvaluationContext,
  PolicyModel,
  PolicySnapshot,
} from "../../../policy/index.js";
import { createConservativeFallback, createPolicyGate } from "../../../policy/index.js";
import type {
  PolicyConfirmationDiagnostics,
  PolicyDecisionDiagnostics,
} from "../../../policy/decisions/types.js";
import type { PolicyModelDiagnostics, PolicyModelResult } from "../../../policy/models/types.js";
import { selectApplicableRules } from "../../../policy/sources/selectApplicableRules.js";
import { evaluateLocalPolicy } from "./evaluateLocalPolicy.js";
import { redactText } from "../../typesafe/redactProviderState.js";

export interface PolicyConfirmationSettings {
  readonly defaultAction: "approve" | "deny";
  readonly threshold: number;
}

export interface EvaluateSnapshotPolicyOptions {
  readonly action: PolicyAction;
  readonly context: PolicyEvaluationContext;
  readonly snapshot?: PolicySnapshot;
  readonly model?: PolicyModel;
  /** Resolve credentials/model only after local and coverage decisions abstain. */
  readonly resolveModel?: () => Promise<PolicyModel | undefined>;
  readonly signal?: AbortSignal;
  readonly confirmation?: PolicyConfirmationSettings;
  readonly semanticEnabled?: boolean;
  /** A host-validated, one-shot approval of this exact action, not a policy override. */
  readonly maintenanceApproved?: boolean;
}

const fallbackGate = createPolicyGate({
  deterministicEvaluators: [],
  fallbackEvaluator: createConservativeFallback(),
});

/** Local denials precede even excluded tools; semantic uncertainty retains confirmation guards. */
export async function evaluateSnapshotPolicy(
  options: EvaluateSnapshotPolicyOptions,
): Promise<PolicyDecision> {
  options.signal?.throwIfAborted();
  const { action, snapshot } = options;
  const rules = snapshot === undefined ? [] : selectApplicableRules(snapshot, action);
  const applicableRuleIds = rules.map((rule) => rule.id);
  if (snapshot !== undefined) {
    const local = await evaluateLocalPolicy(action, snapshot);
    options.signal?.throwIfAborted();
    if (local !== undefined) {
      return attachDiagnostics(
        local,
        local.evidence.applicableRuleIds ?? applicableRuleIds,
        snapshot,
        {
          path: "local-denial",
          confirmation: { resolution: "not-required" },
          enforcedEffect: local.effect,
        },
      );
    }
  }
  if (!action.complete) {
    return {
      effect: "deny",
      reason: "The proposed action is incomplete; its policy compliance cannot be assessed.",
      evidence: {
        evaluatorId: "action-completeness",
        source: "deterministic",
        ruleIds: [],
        applicableRuleIds,
        diagnostics: {
          path: "incomplete-action",
          confirmation: { resolution: "not-required" },
          enforcedEffect: "deny",
        },
      },
    };
  }
  if (options.semanticEnabled === false || (snapshot !== undefined && rules.length === 0)) {
    return {
      effect: "allow",
      evidence: {
        evaluatorId: "compiled-policy-coverage",
        source: "deterministic",
        ruleIds: [],
        applicableRuleIds,
        diagnostics: {
          path: options.semanticEnabled === false ? "coverage-bypass" : "no-applicable-rules",
          confirmation: { resolution: "not-required" },
          enforcedEffect: "allow",
        },
      },
    };
  }

  let model = options.model;
  let result: PolicyModelResult | undefined;
  try {
    if (snapshot !== undefined) {
      model ??= await options.resolveModel?.();
      options.signal?.throwIfAborted();
      result = await model?.evaluate(
        {
          action,
          snapshot,
          ...(options.context.authorization === undefined
            ? {}
            : { authorization: options.context.authorization }),
        },
        options.signal,
      );
    }
  } catch {
    options.signal?.throwIfAborted();
    result = {
      kind: "unavailable",
      reason: "The semantic provider could not assess this action.",
      diagnostics: {
        status: "unavailable",
        providerId: model?.providerId ?? "unresolved",
        requestedModel: model?.modelVersion ?? snapshot?.versions.model ?? "unresolved",
        unavailableReason: "provider-error",
      },
    };
  }
  options.signal?.throwIfAborted();
  if (result?.kind === "decision" && !isValidDecision(result)) {
    result = {
      kind: "unavailable",
      reason: "The semantic provider returned invalid decision evidence.",
      diagnostics: {
        status: "unavailable",
        providerId: model?.providerId ?? "unresolved",
        requestedModel: model?.modelVersion ?? "unresolved",
        unavailableReason: "invalid-response",
      },
    };
  }
  const invalidAttribution =
    result?.kind === "decision" &&
    result.ruleIds?.some((id) => !applicableRuleIds.includes(id)) === true;
  if (invalidAttribution && result?.kind === "decision" && result.effect !== "deny") {
    result = {
      kind: "unavailable",
      reason: "The semantic provider returned invalid rule attribution.",
      diagnostics: {
        ...result.diagnostics,
        status: "unavailable",
        providerId: model?.providerId ?? "unresolved",
        requestedModel: model?.modelVersion ?? result.model,
        attribution: "invalid",
        unavailableReason: "invalid-response",
      },
    };
  }
  if (result === undefined || result.kind === "unavailable") {
    const semantic: PolicyModelDiagnostics = result?.diagnostics ?? {
      status: "unavailable",
      providerId: model?.providerId ?? "unresolved",
      requestedModel: model?.modelVersion ?? snapshot?.versions.model ?? "unresolved",
      unavailableReason:
        snapshot === undefined
          ? "missing-snapshot"
          : model === undefined
            ? "missing-model"
            : "provider-error",
    };
    if (semantic.unavailableReason === "incomplete-action") {
      return attachDiagnostics(
        {
          effect: "deny",
          reason:
            "The provider representation omits action intent; its policy compliance cannot be assessed.",
          evidence: { evaluatorId: "action-completeness", source: "deterministic", ruleIds: [] },
        },
        applicableRuleIds,
        snapshot,
        {
          path: "incomplete-action",
          semantic,
          confirmation: { resolution: "not-required" },
          enforcedEffect: "deny",
        },
      );
    }
    const fallbackResult = await fallbackGate.evaluate(action, options.context, options.signal);
    const fallback: PolicyDecision =
      fallbackResult.effect === "allow" && applicableRuleIds.length > 0
        ? {
            effect: "prompt",
            reason:
              "Applicable standing policy could not be assessed; approval is required before this action can run.",
            evidence: fallbackResult.evidence,
          }
        : fallbackResult;
    const decision = attachDiagnostics(
      { ...fallback, evidence: { ...fallback.evidence, ruleIds: [] } },
      applicableRuleIds,
      snapshot,
      {
        path: "provider-unavailable",
        semantic,
        confirmation: { resolution: fallback.effect === "prompt" ? "pending" : "not-required" },
        enforcedEffect: fallback.effect,
      },
    );
    return resolveConfirmation(decision, undefined, options.confirmation, false);
  }

  const invalidGrounding =
    invalidAttribution ||
    (result.diagnostics?.attribution !== undefined &&
      result.diagnostics.attribution !== "validated");
  const ruleIds = invalidGrounding ? [] : [...new Set(result.ruleIds ?? [])];
  if (result.effect === "deny" && ruleIds.length === 0) {
    result = {
      ...result,
      effect: "prompt",
      diagnostics: {
        ...result.diagnostics,
        status: "assessed",
        providerId: model?.providerId ?? "unresolved",
        requestedModel: model?.modelVersion ?? result.model,
        adapterEffect: "prompt",
        decisionBasis: "ungrounded-denial",
        attribution: invalidAttribution ? "invalid" : (result.diagnostics?.attribution ?? "none"),
      },
    };
  }
  const semantic: PolicyModelDiagnostics = {
    status: "assessed",
    providerId: model?.providerId ?? "unresolved",
    requestedModel: model?.modelVersion ?? result.model,
    model: result.model,
    usage: result.usage,
    adapterEffect: result.effect,
    hardViolationProbability: result.hardViolationProbability,
    ...result.diagnostics,
    ...(invalidAttribution ? { attribution: "invalid" as const } : {}),
  };
  const evidence = {
    evaluatorId: `${model?.providerId ?? "semantic"}:${model?.modelVersion ?? result.model}`,
    source: "semantic" as const,
    ruleIds,
  };
  const effect = result.effect;
  const decision = attachDiagnostics(
    effect === "allow"
      ? { effect, evidence }
      : {
          effect,
          reason: formatSemanticReason(result, semantic, ruleIds, snapshot),
          evidence,
        },
    applicableRuleIds,
    snapshot,
    {
      path: "semantic",
      semantic,
      confirmation: {
        resolution: effect === "prompt" ? "pending" : "not-required",
        confidence: result.confidence,
      },
      enforcedEffect: effect,
    },
  );
  const maintenanceEligible =
    options.maintenanceApproved === true &&
    !invalidAttribution &&
    semantic.status === "assessed" &&
    semantic.attribution !== "invalid" &&
    semantic.attribution !== "missing";
  return resolveConfirmation(
    decision,
    result.confidence,
    options.confirmation,
    maintenanceEligible,
  );
}

function isValidDecision(result: Extract<PolicyModelResult, { kind: "decision" }>): boolean {
  return (
    (result.effect === "allow" || result.effect === "prompt" || result.effect === "deny") &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1 &&
    Number.isFinite(result.hardViolationProbability) &&
    result.hardViolationProbability >= 0 &&
    result.hardViolationProbability <= 1 &&
    typeof result.model === "string" &&
    result.model.length > 0 &&
    Number.isSafeInteger(result.usage?.inputTokens) &&
    result.usage.inputTokens >= 0 &&
    Number.isSafeInteger(result.usage?.outputTokens) &&
    result.usage.outputTokens >= 0 &&
    (result.ruleIds === undefined ||
      (Array.isArray(result.ruleIds) && result.ruleIds.every((id) => typeof id === "string")))
  );
}

function attachDiagnostics(
  decision: PolicyDecision,
  applicableRuleIds: readonly string[],
  snapshot: PolicySnapshot | undefined,
  diagnostics: PolicyDecisionDiagnostics,
): PolicyDecision {
  const matched = snapshot?.rules.find((rule) => rule.id === decision.evidence.ruleIds[0]);
  const source =
    matched === undefined
      ? undefined
      : snapshot?.sources.find((candidate) => candidate.id === matched.sourceId);
  return {
    ...decision,
    evidence: {
      ...decision.evidence,
      applicableRuleIds,
      diagnostics: {
        ...diagnostics,
        ...(matched === undefined
          ? {}
          : {
              decisiveRule: {
                ruleId: matched.id,
                sourceId: matched.sourceId,
                ...(source === undefined ? {} : { sourcePath: source.path }),
                statement: redactText(matched.statement),
                ...(matched.context === undefined
                  ? {}
                  : { context: matched.context.map(redactText) }),
              },
            }),
      },
    },
  };
}

function resolveConfirmation(
  decision: PolicyDecision,
  semanticConfidence: number | undefined,
  settings: PolicyConfirmationSettings = { defaultAction: "approve", threshold: 1 },
  maintenanceApproved: boolean,
): PolicyDecision {
  if (decision.effect !== "prompt") {
    return decision;
  }
  let resolution: PolicyConfirmationDiagnostics["resolution"];
  let effect: "allow" | "deny";
  const confidence = semanticConfidence ?? 1;
  if (maintenanceApproved) {
    resolution = "maintenance-approved";
    effect = "allow";
  } else if (settings.threshold < 1 && confidence >= settings.threshold) {
    return decision;
  } else {
    resolution = settings.defaultAction === "approve" ? "automatic-approve" : "automatic-deny";
    effect = settings.defaultAction === "approve" ? "allow" : "deny";
  }
  const diagnostics = decision.evidence.diagnostics;
  const evidence = {
    ...decision.evidence,
    ...(diagnostics === undefined
      ? {}
      : {
          diagnostics: {
            ...diagnostics,
            confirmation: { ...diagnostics.confirmation, resolution },
            enforcedEffect: effect,
          },
        }),
  };
  return effect === "allow"
    ? { effect, evidence }
    : {
        effect,
        reason: `${decision.reason} ${formatAutomaticDenialReason(semanticConfidence, settings)}`,
        evidence,
      };
}

function formatAutomaticDenialReason(
  confidence: number | undefined,
  settings: PolicyConfirmationSettings,
): string {
  const trigger =
    settings.threshold >= 1
      ? `confirmation threshold ${formatProbability(settings.threshold)} disables interactive confirmation`
      : `decision confidence ${formatProbability(confidence ?? 1)} is below the confirmation threshold ${formatProbability(settings.threshold)}`;
  return `Confirmation was automatically denied by configuration: ${trigger}; defaultAction=${settings.defaultAction}.`;
}

function formatSemanticReason(
  result: Extract<PolicyModelResult, { kind: "decision" }>,
  diagnostics: PolicyModelDiagnostics,
  ruleIds: readonly string[],
  snapshot: PolicySnapshot | undefined,
): string {
  const hardViolation =
    diagnostics.decisionBasis === "hard-violation" ||
    (diagnostics.decisionBasis === "chunk-aggregation" &&
      diagnostics.chunks?.some(
        (chunk) =>
          chunk.diagnostics.adapterEffect === "deny" &&
          chunk.diagnostics.decisionBasis === "hard-violation",
      ));
  let reason: string;
  if (diagnostics.decisionBasis === "ungrounded-denial") {
    reason =
      "The model suggested denial without a validated applicable rule. This is unresolved evidence, not an established policy violation.";
  } else if (hardViolation && result.effect === "deny") {
    reason = `The model assessed a hard-rule conflict (hard-rule probability ${formatProbability(result.hardViolationProbability)}).`;
  } else if (result.effect === "deny") {
    reason = `The model assessed a policy conflict (deny confidence ${formatProbability(result.confidence)}; hard-rule probability ${formatProbability(result.hardViolationProbability)}).`;
  } else if (diagnostics.decisionBasis === "low-confidence") {
    reason = `The model${diagnostics.rawChoice === undefined ? "" : ` chose ${diagnostics.rawChoice} but`} was too uncertain to authorize the action (decision confidence ${formatProbability(result.confidence)}); confirmation is required.`;
  } else if (diagnostics.decisionBasis === "chunk-aggregation") {
    reason = `The combined policy assessments require confirmation because at least one assessment was uncertain or requested approval (decision confidence ${formatProbability(result.confidence)}).`;
  } else {
    reason = `The model requested confirmation (decision confidence ${formatProbability(result.confidence)}).`;
  }
  const allRawAllow =
    diagnostics.decisionBasis === "low-confidence"
      ? diagnostics.rawChoice === "allow"
      : diagnostics.decisionBasis === "chunk-aggregation" &&
        diagnostics.aggregation?.complete === true &&
        diagnostics.chunks !== undefined &&
        diagnostics.chunks.length > 0 &&
        diagnostics.chunks.every(
          (chunk) =>
            chunk.diagnostics.status === "assessed" &&
            chunk.diagnostics.rawChoice === "allow" &&
            chunk.diagnostics.decisionBasis !== "hard-violation",
        );
  if (!hardViolation && result.effect === "prompt" && allRawAllow) {
    reason +=
      " No violation was identified by the model; this is uncertainty, not a rule-violation finding.";
  }
  const matched = snapshot?.rules.find((rule) => rule.id === ruleIds[0]);
  if (matched !== undefined) {
    reason += ` Rule: ${matched.statement}`;
    if (matched.context !== undefined && matched.context.length > 0) {
      reason += ` Scope: ${matched.context.join(" > ")}.`;
    }
  }
  return reason;
}

function formatProbability(value: number): string {
  return `${Number((value * 100).toFixed(2))}%`;
}
