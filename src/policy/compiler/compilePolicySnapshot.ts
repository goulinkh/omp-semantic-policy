import { createHash } from "node:crypto";
import type { PolicySnapshot, PolicyVersionTuple } from "../snapshots/types.js";
import type { CompiledPolicyRule, InstructionSource, PolicyRuleClass } from "../sources/types.js";

export const POLICY_COMPILER_VERSION = "instruction-compiler-v1";

export interface CompilePolicySnapshotOptions {
  readonly projectRoot: string;
  readonly sources: readonly InstructionSource[];
  readonly versions: Omit<PolicyVersionTuple, "compiler"> & { readonly compiler?: string };
  readonly createdAtMs?: number;
}

/** Compile source text into a stable, provenance-preserving immutable snapshot. */
export function compilePolicySnapshot(options: CompilePolicySnapshotOptions): PolicySnapshot {
  const sources = [...options.sources].sort(
    (left, right) => left.precedence - right.precedence || left.path.localeCompare(right.path),
  );
  const rules = sources.flatMap(compileSource);
  const versions: PolicyVersionTuple = {
    compiler: options.versions.compiler ?? POLICY_COMPILER_VERSION,
    question: options.versions.question,
    thresholds: options.versions.thresholds,
    model: options.versions.model,
  };
  const identity = {
    schemaVersion: 1,
    projectRoot: options.projectRoot,
    versions,
    sources: sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      path: source.path,
      scopeRoot: source.scopeRoot,
      contentDigest: source.contentDigest,
      precedence: source.precedence,
    })),
    rules,
  };

  return {
    schemaVersion: 1,
    id: digestJson(identity),
    projectRoot: options.projectRoot,
    createdAtMs: options.createdAtMs ?? Date.now(),
    versions,
    sources,
    rules,
  };
}

function compileSource(source: InstructionSource): CompiledPolicyRule[] {
  return extractStatements(source.content).map((statement, index) => ({
    id: digestJson({ sourceId: source.id, index, statement }),
    sourceId: source.id,
    sourceKind: source.kind,
    scopeRoot: source.scopeRoot,
    classification: classifyStatement(statement),
    statement,
    precedence: source.precedence,
  }));
}

export function extractStatements(content: string): readonly string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let inCodeFence = false;

  const flush = () => {
    const statement = current.join(" ").replace(/\s+/gu, " ").trim();
    if (statement.length > 0) {
      statements.push(statement);
    }
    current = [];
  };

  for (const rawLine of content.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      flush();
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    if (line.length === 0 || /^#{1,6}\s+/u.test(line)) {
      flush();
      continue;
    }

    const bullet = line.match(/^(?:[-*+] |\d+[.)] )(.*)$/u);
    if (bullet !== null) {
      flush();
      current.push((bullet[1] ?? "").replace(/^\[[ xX]\]\s*/u, ""));
      continue;
    }
    current.push(line);
  }
  flush();
  return statements;
}

export function classifyStatement(statement: string): PolicyRuleClass {
  if (
    /\b(?:before|after|then|first|finally|workflow|sequence|before yielding|before completing)\b/iu.test(
      statement,
    )
  ) {
    return "workflow";
  }
  if (
    /\b(?:must(?:\s+not)?|never|do not|don't|shall(?:\s+not)?|prohibited|required)\b/iu.test(
      statement,
    )
  ) {
    return "hard";
  }
  if (/\b(?:should(?:\s+not)?|prefer|recommended|avoid|may)\b/iu.test(statement)) {
    return "advisory";
  }
  return "semantic";
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
