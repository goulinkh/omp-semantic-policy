import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { PolicyAction, PolicySnapshot } from "../../../policy/index.js";

export interface MaintenanceCandidate {
  readonly actionId: string;
  readonly digest: string;
  readonly projectRoot: string;
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly summary: string;
}

export interface MaintenanceApprovals {
  remember(action: PolicyAction, snapshot: PolicySnapshot): Promise<void>;
  current(): MaintenanceCandidate | undefined;
  approve(actionId: string, snapshot: PolicySnapshot, sessionId: string): boolean;
  consume(action: PolicyAction, snapshot: PolicySnapshot): Promise<boolean>;
  clear(): void;
}

/** Bind user approval to the full proposal, not its redacted display or tool-call ID. */
export function digestPolicyAction(action: PolicyAction): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: action.actor.sessionId,
        cwd: action.workingDirectory,
        operation: action.operation,
        targets: action.targets,
        host: action.hostAction.host,
        name: action.hostAction.name,
        input: action.hostAction.input,
      }),
    )
    .digest("hex");
}

/** Session-local, one-use authorization; callers still enforce hard policy and availability. */
export function createMaintenanceApprovals(): MaintenanceApprovals {
  let candidate: MaintenanceCandidate | undefined;
  let approved: MaintenanceCandidate | undefined;
  return {
    async remember(action, snapshot) {
      const summary = await maintenanceSummary(action, snapshot);
      if (summary === undefined) return;
      candidate = {
        actionId: action.id,
        digest: digestPolicyAction(action),
        projectRoot: snapshot.projectRoot,
        snapshotId: snapshot.id,
        sessionId: action.actor.sessionId,
        summary,
      };
    },
    current() {
      return candidate;
    },
    approve(actionId, snapshot, sessionId) {
      if (
        candidate?.actionId !== actionId ||
        candidate.snapshotId !== snapshot.id ||
        candidate.projectRoot !== snapshot.projectRoot ||
        candidate.sessionId !== sessionId
      ) {
        return false;
      }
      approved = candidate;
      candidate = undefined;
      return true;
    },
    async consume(action, snapshot) {
      if (approved === undefined) return false;
      if (
        approved.snapshotId !== snapshot.id ||
        approved.projectRoot !== snapshot.projectRoot ||
        approved.sessionId !== action.actor.sessionId
      ) {
        approved = undefined;
        return false;
      }
      if (approved.digest !== digestPolicyAction(action)) return false;
      // Consume before awaiting filesystem checks: concurrent retries cannot reuse a grant.
      approved = undefined;
      return (await maintenanceSummary(action, snapshot)) !== undefined;
    },
    clear() {
      candidate = undefined;
      approved = undefined;
    },
  };
}

async function maintenanceSummary(
  action: PolicyAction,
  snapshot: PolicySnapshot,
): Promise<string | undefined> {
  if (action.hostAction.host !== "omp") return undefined;
  const input = action.hostAction.input;
  try {
    const cwd = await realpath(action.workingDirectory);
    if (cwd !== snapshot.projectRoot) return undefined;
    if (typeof input.cwd === "string" && (await realpath(resolve(cwd, input.cwd))) !== cwd) {
      return undefined;
    }
    // Environment overrides could redirect package/plugin installation outside this project.
    if (input.env !== undefined) return undefined;
    if (action.hostAction.name === "bash" || action.hostAction.name === "user_bash") {
      const command = action.targets.find((target) => target.kind === "command")?.value;
      if (command === undefined) return undefined;
      const commands = command.trim().split(/\s*&&\s*/u);
      if (
        commands.length > 2 ||
        new Set(commands).size !== commands.length ||
        !commands.every(
          (part) => part === "bun install --frozen-lockfile" || part === "omp plugin link .",
        )
      ) {
        return undefined;
      }
      return `${command.trim()} (cwd: ${cwd})`;
    }
    if (
      action.hostAction.name !== "write" ||
      typeof input.path !== "string" ||
      typeof input.content !== "string"
    )
      return undefined;
    const target = resolve(cwd, input.path);
    if (relative(cwd, target) !== "plugin/omp-plugins.lock.json") return undefined;
    const parent = await realpath(dirname(target));
    const parentRelative = relative(cwd, parent);
    if (isAbsolute(parentRelative) || parentRelative === ".." || parentRelative.startsWith("../"))
      return undefined;
    try {
      if ((await lstat(target)).isSymbolicLink()) return undefined;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const content: unknown = JSON.parse(input.content);
    if (content === null || typeof content !== "object" || Array.isArray(content)) return undefined;
    return `Write project-local ${target}; review the complete proposed JSON before approving`;
  } catch {
    return undefined;
  }
}
