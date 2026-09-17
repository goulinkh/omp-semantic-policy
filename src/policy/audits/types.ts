import type { InterceptionCapability, PolicyOperation } from "../actions/types.js";
import type { PolicyEvidenceSource } from "../decisions/types.js";

export type PolicyAuditPhase = "decision" | "result" | "workflow";

/** Redacted, persistence-safe record of a policy decision or observed outcome. */
export interface PolicyAuditRecord {
  readonly phase: PolicyAuditPhase;
  readonly actionId: string;
  readonly projectRoot: string;
  readonly snapshotId?: string;
  readonly occurredAtMs: number;
  readonly operation: PolicyOperation;
  readonly interception: InterceptionCapability;
  readonly targetSummaries: readonly string[];
  readonly effect?: "allow" | "prompt" | "deny" | "revise";
  readonly evaluatorId?: string;
  readonly evidenceSource?: PolicyEvidenceSource;
  readonly ruleIds?: readonly string[];
  readonly outcome?: "success" | "error" | "blocked";
}
