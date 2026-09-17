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

export interface PolicyRuleApplicability {
  readonly phase: "completion" | "implementation";
}

/** A deliberately narrow grammar, not a natural-language or shell sandbox. */
export interface LocalPathProhibition {
  readonly kind: "path-prohibition";
  /** Literal paths relative to the source scope (profile paths use the project root). */
  readonly paths: readonly string[];
  readonly operations: readonly ("read" | "write")[];
  /**
   * The entire statement describes direct path effects. Even then, absence of a
   * match only assesses precise local read/write actions, not indirect execution.
   */
  readonly exhaustive: boolean;
}

/** One source statement retained with provenance for semantic evaluation. */
export interface CompiledPolicyRule {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceKind: InstructionSourceKind;
  readonly scopeRoot: string;
  readonly classification: PolicyRuleClass;
  readonly statement: string;
  readonly precedence: number;
  readonly context?: readonly string[];
  readonly applicability?: PolicyRuleApplicability;
  readonly localEnforcement?: LocalPathProhibition;
}
