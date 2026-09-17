import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { PolicyAction, PolicyDecision } from "../../../policy/index.js";
import { POLICY_NAME } from "../policyIdentity.js";
import { formatPolicyDecisionFeedback } from "../runtime/policyPresentation.js";

export interface OmpDecisionContext {
  readonly hasUI: ExtensionContext["hasUI"];
  readonly ui: Pick<ExtensionContext["ui"], "confirm">;
}

/** Translate a policy decision into OMP's pre-tool execution contract. */
export async function applyOmpToolDecision(
  decision: PolicyDecision,
  context: OmpDecisionContext,
  action: PolicyAction,
): Promise<ToolCallEventResult | undefined> {
  switch (decision.effect) {
    case "allow":
      return undefined;
    case "deny":
      return { block: true, reason: formatPolicyDecisionFeedback(decision, action) };
    case "revise":
      return { input: { ...decision.input } };
    case "prompt": {
      if (!context.hasUI) {
        return {
          block: true,
          reason: formatPolicyDecisionFeedback(
            {
              ...decision,
              effect: "deny",
              reason: `Policy approval required but no interactive UI is available: ${decision.reason}`,
            },
            action,
          ),
        };
      }

      const feedback = formatPolicyDecisionFeedback(decision, action);
      const approved = await context.ui.confirm(POLICY_NAME, feedback);
      return approved
        ? undefined
        : {
            block: true,
            reason: formatPolicyDecisionFeedback(
              {
                ...decision,
                effect: "deny",
                reason: `User denied policy approval: ${decision.reason}`,
              },
              action,
            ),
          };
    }
  }
}
