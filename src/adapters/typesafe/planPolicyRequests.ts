import { createHash } from "node:crypto";
import type { RedactedProviderState } from "./redactProviderState.js";

export const MAX_POLICY_REQUEST_BYTES = 40_000;
export const MAX_POLICY_REQUEST_CHUNKS = 64;

export type CompactProviderState = {
  readonly policy: {
    readonly snapshotId: string;
    readonly sources: [sourceId: string, precedence: number][];
    readonly contexts: string[][];
    readonly rules: [
      alias: string,
      classification: RedactedProviderState["policy"]["rules"][number]["class"],
      sourceIndex: number,
      contextIndex: number,
      statement: string,
    ][];
    readonly partition?: { readonly index: number; readonly count: number };
  };
  readonly action: RedactedProviderState["action"];
  readonly authorization: RedactedProviderState["authorization"];
};

export interface PlannedPolicyChunk {
  readonly wire: CompactProviderState;
  readonly ruleIdsByAlias: ReadonlyMap<string, string>;
  readonly stateBytes: number;
  readonly stateDigest: string;
}

export type PolicyRequestPlan =
  | {
      readonly kind: "ready";
      readonly chunks: readonly PlannedPolicyChunk[];
      readonly originalStateBytes: number;
      readonly totalStateBytes: number;
    }
  | { readonly kind: "too-large"; readonly reason: string; readonly stateBytes: number };

type Rule = RedactedProviderState["policy"]["rules"][number];

interface DictionaryEntry<T> {
  readonly value: T;
  readonly key: string;
  readonly bytes: number;
}

interface RuleGroup {
  readonly source: DictionaryEntry<[string, number]>;
  readonly context: DictionaryEntry<string[]>;
  readonly rules: { readonly rule: Rule; readonly contentBytes: number }[];
}

/** Plan every request before transmission, without removing or paraphrasing policy text. */
export function planPolicyRequests(state: RedactedProviderState): PolicyRequestPlan {
  const emptyWire: CompactProviderState = {
    policy: { snapshotId: state.policy.snapshotId, sources: [], contexts: [], rules: [] },
    action: state.action,
    authorization: state.authorization,
  };
  const emptyBytes = jsonBytes(emptyWire);
  if (emptyBytes > MAX_POLICY_REQUEST_BYTES) {
    return tooLarge(
      "The complete action and authorization exceed the provider context limit.",
      emptyBytes,
    );
  }

  const groups = prepareGroups(state.policy.rules);
  // Counting uses dictionary indexes and individual encoded fields, never a growing JSON prefix.
  const original = new ChunkBuilder(emptyWire, emptyBytes);
  for (const group of groups) original.append(group, false);
  const originalStateBytes = original.stateBytes;
  if (originalStateBytes <= MAX_POLICY_REQUEST_BYTES) {
    const single = new ChunkBuilder(emptyWire, emptyBytes);
    for (const group of groups) single.append(group);
    const chunk = single.finish();
    return {
      kind: "ready",
      chunks: [chunk],
      originalStateBytes,
      totalStateBytes: chunk.stateBytes,
    };
  }

  // Count width can grow only once within the 64-request limit. Repack only at that boundary.
  let builders = packChunks(groups, emptyWire, emptyBytes, originalStateBytes, 9);
  if (!Array.isArray(builders)) return builders;
  if (builders.length > 9) {
    builders = packChunks(
      groups,
      emptyWire,
      emptyBytes,
      originalStateBytes,
      MAX_POLICY_REQUEST_CHUNKS,
    );
    if (!Array.isArray(builders)) return builders;
  }
  const count = builders.length;
  const chunks = builders.map((builder, index) => builder.finish({ index, count }));
  return {
    kind: "ready",
    chunks,
    originalStateBytes,
    totalStateBytes: chunks.reduce((total, chunk) => total + chunk.stateBytes, 0),
  };
}

function packChunks(
  groups: readonly RuleGroup[],
  emptyWire: CompactProviderState,
  emptyBytes: number,
  originalStateBytes: number,
  reservedCount: number,
): ChunkBuilder[] | Extract<PolicyRequestPlan, { kind: "too-large" }> {
  const createEmptyChunk = (index: number): ChunkBuilder => {
    // Remove the outer braces and add the comma before policy.partition.
    const partitionBytes = jsonBytes({ partition: { index, count: reservedCount } }) - 1;
    return new ChunkBuilder(emptyWire, emptyBytes + partitionBytes);
  };
  const builders: ChunkBuilder[] = [];
  const tooMany = tooLarge(
    `The complete policy requires more than ${MAX_POLICY_REQUEST_CHUNKS} provider requests.`,
    originalStateBytes,
  );
  let current = createEmptyChunk(0);
  if (current.stateBytes > MAX_POLICY_REQUEST_BYTES) {
    return tooLarge(
      "The complete action and authorization leave no room for partition metadata.",
      originalStateBytes,
    );
  }
  const startNextChunk = (next: ChunkBuilder): boolean => {
    builders.push(current);
    if (builders.length >= MAX_POLICY_REQUEST_CHUNKS) return false;
    current = next;
    return true;
  };

  for (const group of groups) {
    if (current.sizeWith(group) <= MAX_POLICY_REQUEST_BYTES) {
      current.append(group);
      continue;
    }
    const next = createEmptyChunk(builders.length + 1);
    if (next.sizeWith(group) <= MAX_POLICY_REQUEST_BYTES) {
      if (!startNextChunk(next)) return tooMany;
      current.append(group);
      continue;
    }
    // Only an oversized context group may split, and then only between intact rules.
    for (const rule of group.rules) {
      const indivisible: RuleGroup = { ...group, rules: [rule] };
      if (current.sizeWith(indivisible) > MAX_POLICY_REQUEST_BYTES) {
        const next = createEmptyChunk(builders.length + 1);
        if (next.sizeWith(indivisible) > MAX_POLICY_REQUEST_BYTES) {
          return tooLarge(
            "An indivisible policy rule with its complete context exceeds the provider context limit.",
            originalStateBytes,
          );
        }
        if (!startNextChunk(next)) return tooMany;
      }
      current.append(indivisible);
    }
  }
  builders.push(current);
  return builders;
}

function prepareGroups(rules: readonly Rule[]): RuleGroup[] {
  const sources = new Map<string, DictionaryEntry<[string, number]>>();
  const contexts = new Map<string, DictionaryEntry<string[]>>();
  const groups: RuleGroup[] = [];
  for (const rule of rules) {
    const source = intern<[string, number]>(sources, [rule.sourceId, rule.precedence]);
    const context = intern(contexts, rule.context ?? []);
    let group = groups[groups.length - 1];
    if (!group || group.source !== source || group.context !== context) {
      group = { source, context, rules: [] };
      groups.push(group);
    }
    group.rules.push({ rule, contentBytes: jsonBytes(rule.class) + jsonBytes(rule.statement) });
  }
  return groups;
}

function intern<T>(entries: Map<string, DictionaryEntry<T>>, value: T): DictionaryEntry<T> {
  const key = JSON.stringify(value);
  let entry = entries.get(key);
  if (!entry) {
    entry = { value, key, bytes: Buffer.byteLength(key) };
    entries.set(key, entry);
  }
  return entry;
}

class ChunkBuilder {
  private readonly sources: CompactProviderState["policy"]["sources"] = [];
  private readonly contexts: CompactProviderState["policy"]["contexts"] = [];
  private readonly sourceIndexes = new Map<string, number>();
  private readonly contextIndexes = new Map<string, number>();
  private readonly rules: CompactProviderState["policy"]["rules"] = [];
  private readonly ruleIdsByAlias = new Map<string, string>();
  private ruleCount = 0;

  constructor(
    private readonly emptyWire: CompactProviderState,
    public stateBytes: number,
  ) {}

  sizeWith(group: RuleGroup): number {
    const sourceIndex = this.sourceIndexes.get(group.source.key) ?? this.sources.length;
    const contextIndex = this.contextIndexes.get(group.context.key) ?? this.contexts.length;
    let bytes = this.stateBytes;
    if (!this.sourceIndexes.has(group.source.key)) {
      bytes += group.source.bytes + (this.sources.length > 0 ? 1 : 0);
    }
    if (!this.contextIndexes.has(group.context.key)) {
      bytes += group.context.bytes + (this.contexts.length > 0 ? 1 : 0);
    }
    const indexBytes = String(sourceIndex).length + String(contextIndex).length;
    for (let offset = 0; offset < group.rules.length; offset += 1) {
      const rule = group.rules[offset]!;
      const index = this.ruleCount + offset;
      // Tuple brackets, four commas, alias quotes and the alias's leading 'r'.
      bytes += 9 + index.toString(36).length + indexBytes + rule.contentBytes + (index > 0 ? 1 : 0);
    }
    return bytes;
  }

  append(group: RuleGroup, retainRules = true): void {
    this.stateBytes = this.sizeWith(group);
    let sourceIndex = this.sourceIndexes.get(group.source.key);
    if (sourceIndex === undefined) {
      sourceIndex = this.sources.length;
      this.sources.push(group.source.value);
      this.sourceIndexes.set(group.source.key, sourceIndex);
    }
    let contextIndex = this.contextIndexes.get(group.context.key);
    if (contextIndex === undefined) {
      contextIndex = this.contexts.length;
      this.contexts.push(group.context.value);
      this.contextIndexes.set(group.context.key, contextIndex);
    }
    if (retainRules) {
      for (const { rule } of group.rules) {
        const alias = `r${this.ruleCount.toString(36)}`;
        this.rules.push([alias, rule.class, sourceIndex, contextIndex, rule.statement]);
        this.ruleIdsByAlias.set(alias, rule.id);
        this.ruleCount += 1;
      }
    } else {
      this.ruleCount += group.rules.length;
    }
  }

  finish(partition?: { readonly index: number; readonly count: number }): PlannedPolicyChunk {
    const wire: CompactProviderState = {
      policy: {
        snapshotId: this.emptyWire.policy.snapshotId,
        sources: this.sources,
        contexts: this.contexts,
        rules: this.rules,
        ...(partition ? { partition } : {}),
      },
      action: this.emptyWire.action,
      authorization: this.emptyWire.authorization,
    };
    const serialized = JSON.stringify(wire);
    return {
      wire,
      ruleIdsByAlias: this.ruleIdsByAlias,
      stateBytes: Buffer.byteLength(serialized),
      stateDigest: createHash("sha256").update(serialized).digest("hex"),
    };
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function tooLarge(
  reason: string,
  stateBytes: number,
): Extract<PolicyRequestPlan, { kind: "too-large" }> {
  return { kind: "too-large", reason, stateBytes };
}
