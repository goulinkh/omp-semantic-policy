import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { PolicyAction } from "../../../policy/actions/types.js";
import { mayQualifyPathProhibition } from "../../../policy/compiler/compilePolicySnapshot.js";
import type { PolicyDecision } from "../../../policy/decisions/types.js";
import type { PolicySnapshot } from "../../../policy/snapshots/types.js";
import {
  isPolicyPathWithin,
  resolveLocalPolicyPath,
  selectApplicableRules,
} from "../../../policy/sources/selectApplicableRules.js";

interface LocalTarget {
  readonly lexical: string;
  readonly canonical: string;
  readonly recursive: boolean;
}

/**
 * Deny grounded literal-path violations, otherwise abstain. This is neither a
 * natural-language interpreter nor a shell/delegation/LSP-workspace sandbox.
 * Filesystem inspection resolves aliases, including writes below symlinked
 * parents; it does not read protected file contents or invoke a remote model.
 */
export async function evaluateLocalPolicy(
  action: PolicyAction,
  snapshot: PolicySnapshot,
): Promise<PolicyDecision | undefined> {
  if (
    action.hostAction.name === "glob" ||
    !snapshot.rules.some((rule) => rule.localEnforcement !== undefined)
  ) {
    return undefined;
  }
  const isLsp = action.hostAction.name === "lsp" || action.hostAction.input.path === "xd://lsp";
  const effects: readonly ("read" | "write")[] =
    action.operation === "read"
      ? ["read"]
      : action.operation === "write"
        ? isLsp
          ? ["read", "write"]
          : ["write"]
        : [];
  if (effects.length === 0) {
    return undefined;
  }
  const isRecursiveSearch = action.hostAction.name === "grep";
  const pathValues = action.targets
    .filter((target) => target.kind === "path")
    .flatMap((target) => (isRecursiveSearch ? target.value.split(";") : [target.value]));
  if (pathValues.length === 0 && isRecursiveSearch) {
    pathValues.push(".");
  }
  const targets: LocalTarget[] = [];
  for await (const lexical of expandLocalTargets(
    pathValues,
    action.workingDirectory,
    isRecursiveSearch || action.hostAction.name === "read",
  )) {
    const canonical = await canonicalizeExistingParent(lexical);
    if (canonical === undefined) {
      // No denial can be inferred from a failed filesystem lookup alone.
      continue;
    }
    let recursive = false;
    if (isRecursiveSearch) {
      try {
        recursive = (await stat(canonical)).isDirectory();
      } catch {
        // Exact prohibited paths still match even if the final target is absent.
      }
    }
    targets.push({ lexical, canonical, recursive });
  }
  if (targets.length === 0) {
    return undefined;
  }
  const applicable = selectApplicableRules(snapshot, {
    ...action,
    targets: [
      ...action.targets,
      ...targets.map((target) => ({ kind: "path" as const, value: target.canonical })),
    ],
  });
  const matched: string[] = [];
  for (const rule of applicable) {
    const prohibition = rule.localEnforcement;
    if (
      prohibition === undefined ||
      !prohibition.operations.some((effect) => effects.includes(effect))
    ) {
      continue;
    }
    for (const path of prohibition.paths) {
      // Separate standing-policy permissions can qualify an otherwise simple ban.
      // Keep the entire set for semantic assessment instead of guessing precedence.
      if (
        applicable.some(
          (other) => other.id !== rule.id && mayQualifyPathProhibition(other.statement, path),
        )
      ) {
        continue;
      }
      const lexical = resolve(
        rule.sourceKind === "profile" ? snapshot.projectRoot : rule.scopeRoot,
        path,
      );
      const canonical = await canonicalizeExistingParent(lexical);
      if (canonical === undefined) {
        continue;
      }
      if (
        targets.some(
          (target) =>
            isPolicyPathWithin(lexical, target.lexical) ||
            isPolicyPathWithin(canonical, target.canonical) ||
            (target.recursive &&
              (isPolicyPathWithin(target.lexical, lexical) ||
                isPolicyPathWithin(target.canonical, canonical))),
        )
      ) {
        matched.push(rule.id);
        break;
      }
    }
  }
  if (matched.length === 0) {
    return undefined;
  }
  return {
    effect: "deny",
    reason: "Standing policy prohibits access to a targeted local path.",
    evidence: {
      evaluatorId: "local-path-prohibition",
      source: "deterministic",
      ruleIds: matched,
      applicableRuleIds: applicable.map((rule) => rule.id),
    },
  };
}

async function* expandLocalTargets(
  values: readonly string[],
  workingDirectory: string,
  allowPattern: boolean,
): AsyncGenerator<string> {
  for (const value of new Set(values)) {
    const path = resolveLocalPolicyPath(value, workingDirectory, allowPattern);
    if (path === undefined) {
      continue;
    }
    if (!allowPattern || !/[*?[\]{}]/u.test(path)) {
      yield path;
      continue;
    }
    try {
      // Enumerate names, not contents. Canonicalization of each matching entry
      // catches a wildcard matching an alias rather than the protected filename.
      yield* new Bun.Glob(path).scan({
        cwd: workingDirectory,
        absolute: true,
        onlyFiles: false,
        followSymlinks: false,
        dot: true,
      });
    } catch {
      // Unresolvable patterns are unassessed, never a deterministic allow.
    }
  }
}

async function canonicalizeExistingParent(path: string): Promise<string | undefined> {
  const missing: string[] = [];
  let candidate = path;
  while (true) {
    try {
      return join(await realpath(candidate), ...missing);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      ) {
        return undefined;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return undefined;
      }
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}
