import type { CompiledPolicyRule, InstructionSource } from "../sources/types.js";

export interface PolicyVersionTuple {
  readonly compiler: string;
  readonly question: string;
  readonly thresholds: string;
  readonly model: string;
}

/** Immutable compiled policy for one canonical Git project. */
export interface PolicySnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectRoot: string;
  readonly createdAtMs: number;
  readonly versions: PolicyVersionTuple;
  readonly sources: readonly InstructionSource[];
  readonly rules: readonly CompiledPolicyRule[];
}
