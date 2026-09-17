import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicyAction } from "../actions/types.js";
import type { PolicySnapshot } from "../snapshots/types.js";
import type { CompiledPolicyRule } from "./types.js";

/**
 * Narrow only proven source/phase mismatches. Opaque execution and unknown
 * constraints retain context; permissions and exceptions are never keyword-filtered.
 * Canonical aliases supplied by adapters participate alongside lexical targets.
 */
export function selectApplicableRules(
  snapshot: PolicySnapshot,
  action: PolicyAction,
): readonly CompiledPolicyRule[] {
  let hasPathPattern = false;
  const paths = action.targets.flatMap((target) => {
    if (target.kind !== "path") {
      return [];
    }
    const values =
      action.hostAction.name === "grep" || action.hostAction.name === "glob"
        ? target.value.split(";")
        : [target.value];
    return values.flatMap((value) => {
      const path = resolveLocalPolicyPath(value, action.workingDirectory, true);
      if (path === undefined) {
        return [];
      }
      const wildcard = path.search(/[*?[\]{}]/u);
      if (wildcard !== -1) {
        hasPathPattern = true;
        return [path.slice(0, path.lastIndexOf(sep, wildcard)) || sep];
      }
      return [path];
    });
  });
  const opaque =
    action.operation === "execute" ||
    action.operation === "delegate" ||
    action.operation === "unknown";
  const treeInspection =
    hasPathPattern || action.hostAction.name === "grep" || action.hostAction.name === "glob";
  if (paths.length === 0 && (opaque || treeInspection)) {
    paths.push(resolve(action.workingDirectory));
  }
  const implementationAction =
    action.operation !== "read" &&
    action.operation !== "internal" &&
    action.operation !== "network" &&
    !isOperationalShellAction(action);
  return snapshot.rules.filter((rule) => {
    if (rule.sourceKind === "subtree" && action.operation !== "workflow") {
      const overlaps = paths.some(
        (path) =>
          isPolicyPathWithin(rule.scopeRoot, path) ||
          ((opaque || treeInspection) && isPolicyPathWithin(path, rule.scopeRoot)),
      );
      // A path inside a script is not an exhaustive account of its eventual effects.
      if (!overlaps && !opaque) {
        return false;
      }
    }
    if (rule.applicability?.phase === "completion") {
      return (
        action.operation === "workflow" &&
        action.hostAction.name !== "ask" &&
        action.hostAction.name !== "todo"
      );
    }
    if (rule.applicability?.phase === "implementation") {
      return implementationAction;
    }
    return true;
  });
}

/** Resolve OMP local selectors without interpreting remote/internal resource URIs. */
export function resolveLocalPolicyPath(
  value: string,
  workingDirectory: string,
  allowPattern = false,
): string | undefined {
  let path = value.trim();
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(path)) {
    return undefined;
  }
  // Literal selector punctuation is percent-encoded by the host path contract.
  path = path.split(/:|\?(?=[^/?]*=)/u)[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (path.length === 0 || /\0/u.test(path) || (!allowPattern && /[*?[\]{}]/u.test(path))) {
    return undefined;
  }
  return isAbsolute(path) ? resolve(path) : resolve(workingDirectory, path);
}

/** Segment-aware containment avoids confusing sibling names with descendants. */
export function isPolicyPathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

function isOperationalShellAction(action: PolicyAction): boolean {
  if (
    !action.complete ||
    action.operation !== "execute" ||
    (action.hostAction.name !== "bash" && action.hostAction.name !== "user_bash") ||
    action.hostAction.input.env !== undefined
  ) {
    return false;
  }
  const shell = action.details.shellPayload;
  if (
    shell !== null &&
    typeof shell === "object" &&
    !Array.isArray(shell) &&
    "syntax" in shell &&
    shell.syntax === "direct-curl" &&
    "assessment" in shell &&
    shell.assessment === "complete"
  ) {
    return true;
  }
  const command = action.hostAction.input.command;
  if (typeof command !== "string" || /[\r\n]/u.test(command)) {
    return false;
  }
  // Whole supported commands only, never safe prefixes. Package installation
  // can run lifecycle hooks: this excludes coding style, not behavioral policy.
  // Maintenance authorization separately requires exact approval and its
  // stricter project-local frozen-lockfile/link grammar.
  return command
    .trim()
    .split(/\s*&&\s*/u)
    .every((part) =>
      /^(?:(?:bun|node|npm|npx|pnpm|yarn|python(?:3)?|git|tsc|rustc|cargo)\s+--version|node\s+-v|(?:git|go|cargo)\s+version|pwd|git\s+status(?:\s+--(?:short|porcelain))?|git\s+diff\s+--(?:stat|name-only)|bun\s+install(?:\s+--frozen-lockfile)?|omp\s+plugin\s+link\s+\.)$/u.test(
        part,
      ),
    );
}
