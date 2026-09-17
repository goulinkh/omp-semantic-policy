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
export type { PolicyAuditPhase, PolicyAuditRecord } from "./audits/types.js";
export {
  classifyStatement,
  compilePolicySnapshot,
  extractStatements,
  POLICY_COMPILER_VERSION,
  type CompilePolicySnapshotOptions,
} from "./compiler/compilePolicySnapshot.js";
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
export type {
  PolicyModel,
  PolicyModelRequest,
  PolicyModelResult,
  PolicyModelUsage,
  PolicyModelValidation,
} from "./models/types.js";
export { actionMayMutatePolicySources } from "./snapshots/staleness.js";
export type { PolicySnapshot, PolicyVersionTuple } from "./snapshots/types.js";
export type {
  CompiledPolicyRule,
  InstructionSource,
  InstructionSourceKind,
  PolicyRuleClass,
} from "./sources/types.js";
export { selectApplicableSources } from "./sources/selectApplicableSources.js";
