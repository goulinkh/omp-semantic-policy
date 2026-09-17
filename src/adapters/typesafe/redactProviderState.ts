import type { EntryType } from "@typesafe-ai/sdk";
import type { PolicyModelRequest, PolicyTarget } from "../../policy/index.js";
import { selectApplicableSources } from "../../policy/sources/selectApplicableSources.js";

const REDACTION_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  {
    pattern: /\b(authorization\s*:\s*bearer\s+)[^\s,;]+/giu,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /\b([A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)[A-Z0-9_]*\s*[=:]\s*)[^\s,;]+/giu,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gu,
    replacement: "[REDACTED]",
  },
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/giu,
    replacement: "$1[REDACTED]@",
  },
];

export function redactText(value: string): string {
  return REDACTION_PATTERNS.reduce(
    (redacted, item) => redacted.replace(item.pattern, item.replacement),
    value,
  );
}

/** Build the only payload permitted to cross the semantic provider boundary. */
export function createRedactedProviderState(request: PolicyModelRequest): EntryType {
  const applicableSourceIds = new Set(
    selectApplicableSources(request.snapshot.sources, request.action).map((source) => source.id),
  );
  const rules = request.snapshot.rules
    .filter((rule) => applicableSourceIds.has(rule.sourceId))
    .map((rule) => ({
      id: rule.id,
      class: rule.classification,
      statement: redactText(rule.statement),
    }));

  return {
    policy: {
      snapshotId: request.snapshot.id,
      rules,
    },
    action: {
      operation: request.action.operation,
      interception: request.action.interception,
      targets: request.action.targets.map(redactTarget),
      host: request.action.hostAction.host,
      name: request.action.hostAction.name,
    },
    authorization: {
      source: request.authorization?.source ?? "none",
      explicit: request.authorization?.explicit ?? false,
      ...(request.authorization?.summary === undefined
        ? {}
        : { summary: redactText(request.authorization.summary) }),
    },
  };
}

function redactTarget(target: PolicyTarget): Record<string, string> {
  return { kind: target.kind, value: redactText(target.value) };
}
