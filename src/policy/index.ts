export type {
  AuthorizationEnvelope,
  HostAction,
  InterceptionCapability,
  PolicyAction,
  PolicyActor,
  PolicyActorKind,
  PolicyEvaluationContext,
  PolicyOperation,
  PolicySnapshotReference,
  PolicyTarget,
  PolicyTargetKind,
} from "./actions/types.js";
export type {
  DecisionEvidence,
  PolicyDecision,
  PolicyDecisionDraft,
  PolicyEvidenceSource,
} from "./decisions/types.js";
export { createConservativeFallback } from "./gate/createConservativeFallback.js";
export {
  createPolicyGate,
  type PolicyEvaluator,
  type PolicyFallbackEvaluator,
  type PolicyGate,
  type PolicyGateOptions,
} from "./gate/createPolicyGate.js";
