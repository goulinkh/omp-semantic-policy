import type { PolicyOperation } from "../actions/types.js";
import type { PolicyFallbackEvaluator } from "./createPolicyGate.js";

const NON_MUTATING_OPERATIONS: Readonly<Partial<Record<PolicyOperation, true>>> = {
  read: true,
  workflow: true,
};

/**
 * Provide safe behavior when compiled/semantic policy cannot decide an action.
 *
 * Reads and local workflow operations continue. Actions capable of an external
 * side effect return a confirmation request for the host to resolve using its
 * configured automatic default or interactive approval.
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
        reason: `The semantic evaluator is unavailable, so this ${action.operation} action was not classified as compliant or noncompliant. Explicit approval is required before ${action.hostAction.name} can run.`,
        ruleIds: ["fallback.prompt-side-effect"],
      };
    },
  };
}
