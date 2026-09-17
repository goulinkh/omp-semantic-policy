import type { PolicyVersionTuple } from "../../../policy/index.js";
import { compilePolicySnapshot } from "../../../policy/index.js";
import type { PolicyRepository } from "../persistence/index.js";
import {
  discoverProfileInstructionSources,
  discoverProjectInstructionSources,
  findGitProjectRoot,
} from "../projects/index.js";

export interface ProjectOnboarderOptions {
  readonly repository: PolicyRepository;
  readonly profileInstructionPaths: readonly string[];
  readonly versions: Omit<PolicyVersionTuple, "compiler"> & { readonly compiler?: string };
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

      const [profileSources, projectSources] = await Promise.all([
        discoverProfileInstructionSources(options.profileInstructionPaths),
        discoverProjectInstructionSources(projectRoot),
      ]);
      const snapshot = compilePolicySnapshot({
        projectRoot,
        sources: [...profileSources, ...projectSources],
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
