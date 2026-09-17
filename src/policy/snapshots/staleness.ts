import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { PolicyAction } from "../actions/types.js";
import type { PolicySnapshot } from "./types.js";

const INSTRUCTION_FILENAMES: Readonly<Record<string, true>> = {
  "AGENTS.md": true,
  "CLAUDE.md": true,
};

/** Detect writes that can alter the active policy, including creation of a new source file. */
export function actionMayMutatePolicySources(
  action: PolicyAction,
  snapshot: PolicySnapshot,
): boolean {
  if (action.operation !== "write" && action.operation !== "execute") {
    return false;
  }

  const knownSourcePaths = new Set(snapshot.sources.map((source) => resolve(source.path)));
  return action.targets.some((target) => {
    if (target.kind !== "path" || hasProtocol(target.value)) {
      return false;
    }
    const candidate = resolve(
      isAbsolute(target.value) ? target.value : resolve(action.workingDirectory, target.value),
    );
    if (!isPathWithin(snapshot.projectRoot, candidate)) {
      return false;
    }
    return knownSourcePaths.has(candidate) || INSTRUCTION_FILENAMES[basename(candidate)] === true;
  });
}

function hasProtocol(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}
