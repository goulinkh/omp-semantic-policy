import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PolicyAction } from "../actions/types.js";
import type { InstructionSource } from "./types.js";

/** Select sources whose project/subtree scope contains the action's path targets. */
export function selectApplicableSources(
  sources: readonly InstructionSource[],
  action: PolicyAction,
): readonly InstructionSource[] {
  const pathTargets = action.targets
    .filter((target) => target.kind === "path" && !hasProtocol(target.value))
    .map((target) =>
      isAbsolute(target.value) ? target.value : resolve(action.workingDirectory, target.value),
    );
  const isProjectWorkflow = action.operation === "workflow";

  return sources
    .filter((source) => {
      if (source.kind !== "subtree" || isProjectWorkflow) {
        return true;
      }
      return pathTargets.some((target) => isPathWithin(source.scopeRoot, target));
    })
    .sort(
      (left, right) => left.precedence - right.precedence || left.path.localeCompare(right.path),
    );
}

function hasProtocol(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}
