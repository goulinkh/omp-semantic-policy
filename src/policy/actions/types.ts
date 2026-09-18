export type PolicyOperation =
  | "read"
  | "write"
  | "execute"
  | "delegate"
  | "network"
  | "workflow"
  | "internal"
  | "unknown";

export type InterceptionCapability = "precise" | "dispatch-only" | "advisory" | "absent";

export type PolicyActorKind = "user" | "agent" | "subagent" | "extension" | "host";

export interface PolicyActor {
  readonly kind: PolicyActorKind;
  readonly sessionId: string;
  readonly parentSessionId?: string;
}

export type PolicyTargetKind = "path" | "command" | "code" | "query" | "agent" | "url" | "tool";

export interface PolicyTarget {
  readonly kind: PolicyTargetKind;
  readonly value: string;
}

export interface HostAction {
  readonly host: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly source?: {
    readonly kind: string;
    readonly path: string;
  };
}

/** Selected dispatch facts, never an unrestricted copy of host tool input. */
export type PolicyActionDetail =
  | string
  | number
  | boolean
  | null
  | readonly PolicyActionDetail[]
  | { readonly [key: string]: PolicyActionDetail };

/** Provider-independent description of an action before its side effect. */
export interface PolicyAction {
  readonly id: string;
  readonly occurredAtMs: number;
  readonly actor: PolicyActor;
  readonly workingDirectory: string;
  readonly operation: PolicyOperation;
  readonly interception: InterceptionCapability;
  /** False when dispatch intent is missing, malformed, unsupported, or exceeds evidence bounds. */
  readonly complete: boolean;
  readonly details: Readonly<Record<string, PolicyActionDetail>>;
  readonly targets: readonly PolicyTarget[];
  readonly hostAction: HostAction;
}

export interface AuthorizationEnvelope {
  readonly source: "current-turn" | "standing-policy" | "none";
  readonly explicit: boolean;
  readonly scope?: "request" | "exact-action";
  readonly actionDigest?: string;
  readonly summary?: string;
  /** Bounded conversational evidence, never an independently verified grant. */
  readonly requestContext?: {
    readonly status: "included" | "partial";
    readonly messages: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  };
}

export interface PolicySnapshotReference {
  readonly projectRoot: string;
  readonly snapshotId: string;
}

export interface PolicyEvaluationContext {
  readonly headless: boolean;
  readonly authorization?: AuthorizationEnvelope;
  readonly snapshot?: PolicySnapshotReference;
}
