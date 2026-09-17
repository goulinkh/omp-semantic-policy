import { resolve } from "node:path";
import type { AuthorizationEnvelope, PolicyAction } from "../../../policy/index.js";
import { digestPolicyAction } from "./maintenanceApprovals.js";

/**
 * Recognize a whole affirmative command request, never a substring or safe prefix.
 * Compare original values: two different credentials can have identical redacted text.
 * Unrecognized prose remains request-scoped evidence for semantic interpretation.
 */
export function bindRequestAuthorization(
  action: PolicyAction,
  authorization: AuthorizationEnvelope | undefined,
  originalRequest: string | undefined,
): AuthorizationEnvelope | undefined {
  if (
    authorization?.scope === "exact-action" ||
    originalRequest === undefined ||
    authorization?.source !== "current-turn" ||
    action.hostAction.name !== "bash" ||
    !action.complete ||
    action.hostAction.input.env !== undefined
  ) {
    return authorization;
  }
  const command = action.hostAction.input.command;
  const cwd = action.hostAction.input.cwd;
  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    (cwd !== undefined &&
      (typeof cwd !== "string" ||
        resolve(action.workingDirectory, cwd) !== resolve(action.workingDirectory)))
  ) {
    return authorization;
  }
  const request = originalRequest.trim();
  const prefix = /^(?:please\s+)?(?:run|execute)\s+(?:exactly\s*:\s*)?/iu.exec(request);
  if (prefix === null) return authorization;
  const body = request.slice(prefix[0].length);
  const literal = command.trim();
  const forms = [literal, `\`${literal}\``];
  const suffixes = [
    "",
    ".",
    " in this project",
    " in this project.",
    " in this directory",
    " in this directory.",
  ];
  if (!forms.some((form) => suffixes.some((suffix) => body === form + suffix))) {
    return authorization;
  }
  return {
    ...authorization,
    explicit: true,
    scope: "exact-action",
    actionDigest: digestPolicyAction(action),
    summary: "The user explicitly requested this exact action.",
  };
}
