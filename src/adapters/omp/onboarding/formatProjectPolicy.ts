import { homedir } from "node:os";
import { sep } from "node:path";
import { POLICY_LOGO, brandPolicyText } from "../policyIdentity.js";

import type { PolicyRepository } from "../persistence/index.js";

export function formatProjectPolicyStatus(
  repository: PolicyRepository,
  projectRoot: string | undefined,
  evaluatorState: EvaluatorState = undefined,
): string {
  if (projectRoot === undefined) {
    return brandPolicyText("⚠️ No Git project · conservative fallback only");
  }
  const displayRoot = compactProjectPath(projectRoot);
  const project = repository.getProject(projectRoot);
  if (project === undefined || project.activeSnapshotId === undefined) {
    return `${brandPolicyText("○ Policy not onboarded")}\n📁 ${displayRoot}`;
  }
  const snapshot = repository.getActiveSnapshot(projectRoot);
  if (snapshot === undefined) {
    return `${brandPolicyText("❌ Policy unavailable · invalid snapshot")}\n📁 ${displayRoot}`;
  }
  const consent = repository.getRemoteConsent();
  const state = project.stale ? "⚠️ Policy stale · refresh required" : "✅ Policy active";
  return [
    `${POLICY_LOGO} ${state} · ${snapshot.rules.length} rules · ${snapshot.sources.length} sources`,
    `📁 ${displayRoot} · 🧠 ${snapshot.versions.model}`,
    `${consent === true ? "🔐 Remote consented" : "🔒 Remote disabled"} · ${formatEvaluator(evaluatorState)} · ◫ ${snapshot.id.slice(0, 12)}`,
  ].join("\n");
}

type EvaluatorState = "available" | "unavailable" | "disabled" | "login-required" | undefined;

function formatEvaluator(state: EvaluatorState): string {
  switch (state) {
    case "available":
      return "✅ Evaluator available";
    case "unavailable":
      return "⚠️ Evaluator unavailable";
    case "disabled":
      return "⏸️ Evaluator disabled";
    case "login-required":
      return "🔑 Evaluator login required (/login typesafe-ai or TYPESAFE_API_KEY)";
    case undefined:
      return "○ Evaluator not checked";
  }
}

function compactProjectPath(projectRoot: string): string {
  const home = homedir();
  return projectRoot.startsWith(`${home}${sep}`)
    ? `~${projectRoot.slice(home.length)}`
    : projectRoot;
}

export function formatProjectPolicyReview(
  repository: PolicyRepository,
  projectRoot: string | undefined,
): string {
  if (projectRoot === undefined) {
    return brandPolicyText("No Git project is active.");
  }
  const snapshot = repository.getActiveSnapshot(projectRoot);
  if (snapshot === undefined) {
    return brandPolicyText("No compiled policy snapshot is active.");
  }
  if (snapshot.rules.length === 0) {
    return brandPolicyText("The active policy snapshot contains no instruction rules.");
  }

  return `${brandPolicyText("Active policy rules")}\n\n${snapshot.rules
    .map(
      (rule) =>
        `${rule.classification.toUpperCase()} [${rule.sourceKind}:${rule.sourceId}]\n${rule.statement}`,
    )
    .join("\n\n")}`;
}
