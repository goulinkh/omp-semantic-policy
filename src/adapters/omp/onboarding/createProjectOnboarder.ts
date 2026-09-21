import type { InstructionSource, PolicyVersionTuple } from "../../../policy/index.js";
import { compilePolicySnapshot } from "../../../policy/index.js";
import type { PolicyRepository } from "../persistence/index.js";
import {
  discoverProfileInstructionSources,
  discoverLinkedInstructionSources,
  discoverProjectInstructionSources,
  findGitProjectRoot,
} from "../projects/index.js";
import type { StandardsSourceResolver } from "./createStandardsSourceResolver.js";

export interface ProjectOnboarderOptions {
  readonly repository: PolicyRepository;
  readonly profileInstructionPaths: readonly string[];
  readonly versions: Omit<PolicyVersionTuple, "compiler"> & { readonly compiler?: string };
  readonly standardsSourceResolver?: StandardsSourceResolver;
}

export type ProjectOnboardingResult =
  | { readonly kind: "no-project" }
  | {
      readonly kind: "ready";
      readonly projectRoot: string;
      readonly snapshotId: string;
      readonly sourceCount: number;
      readonly ruleCount: number;
      readonly changed: boolean;
    };

export interface ProjectOnboarder {
  onboard(startPath: string, force?: boolean): Promise<ProjectOnboardingResult>;
}

export function createProjectOnboarder(options: ProjectOnboarderOptions): ProjectOnboarder {
  return {
    async onboard(startPath, force = false) {
      const projectRoot = await findGitProjectRoot(startPath);
      if (projectRoot === undefined) {
        return { kind: "no-project" };
      }

      const linkedSourcePaths = options.repository.listLinkedSources(projectRoot);
      const [profileSources, projectSources, linkedSources] = await Promise.all([
        discoverProfileInstructionSources(options.profileInstructionPaths),
        discoverProjectInstructionSources(projectRoot),
        discoverLinkedInstructionSources(projectRoot, linkedSourcePaths),
      ]);
      const baselineSources: InstructionSource[] = [];
      const baselinePaths = new Set<string>();
      for (const source of [...profileSources, ...projectSources, ...linkedSources]) {
        if (!baselinePaths.has(source.path)) {
          baselineSources.push(source);
          baselinePaths.add(source.path);
        }
      }
      let standardsSources: readonly InstructionSource[] = [];
      try {
        standardsSources =
          (await options.standardsSourceResolver?.resolve({
            projectRoot,
            existingSources: baselineSources,
            force,
          })) ?? [];
      } catch {
        standardsSources = [];
      }
      const snapshot = compilePolicySnapshot({
        projectRoot,
        sources: [...baselineSources, ...standardsSources],
        versions: options.versions,
      });
      const storedProject = options.repository.getProject(projectRoot);
      const changed =
        force || storedProject?.activeSnapshotId !== snapshot.id || storedProject.stale;

      if (changed) {
        options.repository.saveSnapshot(snapshot);
      } else {
        options.repository.touchProject(projectRoot);
      }

      return {
        kind: "ready",
        projectRoot,
        snapshotId: snapshot.id,
        sourceCount: snapshot.sources.length,
        ruleCount: snapshot.rules.length,
        changed,
      };
    },
  };
}
