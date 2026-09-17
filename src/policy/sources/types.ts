export type InstructionSourceKind = "profile" | "project" | "subtree";

/** Instruction text with canonical scope and immutable content identity. */
export interface InstructionSource {
  readonly id: string;
  readonly kind: InstructionSourceKind;
  readonly path: string;
  readonly scopeRoot: string;
  readonly content: string;
  readonly contentDigest: string;
  readonly precedence: number;
}

export type PolicyRuleClass = "hard" | "workflow" | "advisory" | "semantic";

/** One source statement retained with provenance for semantic evaluation. */
export interface CompiledPolicyRule {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceKind: InstructionSourceKind;
  readonly scopeRoot: string;
  readonly classification: PolicyRuleClass;
  readonly statement: string;
  readonly precedence: number;
}
