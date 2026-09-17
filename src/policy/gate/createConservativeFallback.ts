import type { PolicyOperation } from "../actions/types.js";
import type { PolicyFallbackEvaluator } from "./createPolicyGate.js";

const NON_MUTATING_OPERATIONS: Readonly<Partial<Record<PolicyOperation, true>>> = {
  read: true,
  workflow: true,
};

/**
 * Provide safe behavior when compiled/semantic policy cannot decide an action.
 *
 * Reads and local workflow operations continue. Every action capable of an
 * external side effect requires explicit interactive approval and therefore
 * becomes a denial in headless OMP sessions.
 */
export function createConservativeFallback(): PolicyFallbackEvaluator {
  return {
    id: "conservative-unconfigured-policy",
    evaluate(action) {
      if (NON_MUTATING_OPERATIONS[action.operation] === true) {
        return { effect: "allow", ruleIds: ["fallback.allow-non-mutating"] };
      }

      return {
        effect: "prompt",
        reason: `No semantic policy decision is available for ${action.operation} action ${action.hostAction.name}.`,
        ruleIds: ["fallback.prompt-side-effect"],
      };
    },
  };
}
