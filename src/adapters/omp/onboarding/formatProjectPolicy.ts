import type { PolicyRepository } from "../persistence/index.js";

export function formatProjectPolicyStatus(
  repository: PolicyRepository,
  projectRoot: string | undefined,
): string {
  if (projectRoot === undefined) {
    return "No Git project is active; only the conservative fallback is available.";
  }
  const project = repository.getProject(projectRoot);
  if (project === undefined || project.activeSnapshotId === undefined) {
    return `Project: ${projectRoot}\nPolicy: not onboarded`;
  }
  const snapshot = repository.getActiveSnapshot(projectRoot);
  if (snapshot === undefined) {
    return `Project: ${projectRoot}\nPolicy: invalid active snapshot`;
  }
  const consent = repository.getRemoteConsent();
  return [
    `Project: ${projectRoot}`,
    `Snapshot: ${snapshot.id}`,
    `State: ${project.stale ? "stale; refresh required before high-impact actions" : "active"}`,
    `Sources: ${snapshot.sources.length}`,
    `Rules: ${snapshot.rules.length}`,
    `Remote semantic evaluation: ${consent === true ? "consented" : "disabled"}`,
    `Model: ${snapshot.versions.model}`,
  ].join("\n");
}

export function formatProjectPolicyReview(
  repository: PolicyRepository,
  projectRoot: string | undefined,
): string {
  if (projectRoot === undefined) {
    return "No Git project is active.";
  }
  const snapshot = repository.getActiveSnapshot(projectRoot);
  if (snapshot === undefined) {
    return "No compiled policy snapshot is active.";
  }
  if (snapshot.rules.length === 0) {
    return "The active policy snapshot contains no instruction rules.";
  }

  return snapshot.rules
    .map(
      (rule) =>
        `${rule.classification.toUpperCase()} [${rule.sourceKind}:${rule.sourceId}]\n${rule.statement}`,
    )
    .join("\n\n");
}
