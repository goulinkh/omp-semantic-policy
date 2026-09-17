import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolInfo,
} from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AuthorizationEnvelope,
  PolicyAction,
  PolicyAuditRecord,
  PolicyDecision,
  PolicyModel,
  PolicySnapshot,
} from "../../../policy/index.js";
import { actionMayMutatePolicySources } from "../../../policy/index.js";
import {
  createTypeSafePolicyModel,
  DEFAULT_TYPESAFE_POLICY_MODEL,
  redactText,
  registerTypeSafeProvider,
  TYPESAFE_QUESTION_VERSION,
  TYPESAFE_THRESHOLD_VERSION,
} from "../../typesafe/index.js";
import { formatCoverageReport } from "../coverage/formatCoverageReport.js";
import { applyOmpToolDecision } from "../events/applyToolDecision.js";
import { normalizeOmpToolCall } from "../events/normalizeToolCall.js";
import {
  createProjectOnboarder,
  formatProjectPolicyReview,
  formatProjectPolicyStatus,
} from "../onboarding/index.js";
import { createPolicyRepository, type PolicyRepository } from "../persistence/index.js";
import { evaluateSnapshotPolicy } from "../enforcement/evaluateSnapshotPolicy.js";

const STATUS_KEY = "omp-semantic-policy";
const MUTATING_SLASH_COMMANDS: Readonly<Record<string, true>> = {
  branch: true,
  clear: true,
  compact: true,
  fork: true,
  login: true,
  logout: true,
  model: true,
  new: true,
  reload: true,
  "reload-plugins": true,
  resume: true,
  settings: true,
};

interface PendingAction {
  readonly action: PolicyAction;
  readonly snapshot?: PolicySnapshot;
}
export interface OmpPolicyRuntimeOptions {
  readonly databasePath?: string;
  readonly profileInstructionPaths?: readonly string[];
  readonly createPolicyModel?: (apiKey: string, hasConsent: () => boolean) => PolicyModel;
}

export function registerOmpPolicyRuntime(
  pi: ExtensionAPI,
  options: OmpPolicyRuntimeOptions = {},
): void {
  registerTypeSafeProvider(pi);
  const repositoryPromise = createPolicyRepository(
    options.databasePath ?? join(getAgentDir(), "policy.db"),
  );
  const toolInfoByName = new Map<string, ToolInfo>();
  const pendingActions = new Map<string, PendingAction>();
  let activeProjectRoot: string | undefined;
  let authorization: AuthorizationEnvelope | undefined;
  let consentPromptActive = false;
  let lastContinuationTurn: number | undefined;
  let cachedModel: { readonly apiKey: string; readonly model: PolicyModel } | undefined;

  pi.setLabel("OMP Semantic Policy");

  async function onboard(context: ExtensionContext, force = false): Promise<void> {
    const repository = await repositoryPromise;
    const onboarder = createProjectOnboarder({
      repository,
      profileInstructionPaths: options.profileInstructionPaths ?? defaultProfileInstructionPaths(),
      versions: {
        question: TYPESAFE_QUESTION_VERSION,
        thresholds: TYPESAFE_THRESHOLD_VERSION,
        model: DEFAULT_TYPESAFE_POLICY_MODEL,
      },
    });
    const result = await onboarder.onboard(context.cwd, force);
    activeProjectRoot = result.kind === "ready" ? result.projectRoot : undefined;

    if (repository.getRemoteConsent() === undefined && context.hasUI && !consentPromptActive) {
      consentPromptActive = true;
      try {
        const consented = await context.ui.confirm(
          "OMP Semantic Policy",
          "Allow redacted policy rules, action metadata, and current-turn authorization summaries to be evaluated by TypeSafe AI? Raw tool inputs are never sent.",
        );
        repository.setRemoteConsent(consented);
      } finally {
        consentPromptActive = false;
      }
    }

    updateStatus(context, repository, activeProjectRoot);
  }

  async function ensureSnapshot(
    context: ExtensionContext,
    operation: PolicyAction["operation"],
  ): Promise<{ readonly repository: PolicyRepository; readonly snapshot?: PolicySnapshot }> {
    const repository = await repositoryPromise;
    const highImpact = operation !== "read" && operation !== "workflow" && operation !== "internal";
    if (activeProjectRoot === undefined || highImpact) {
      await onboard(context);
    }
    const snapshot =
      activeProjectRoot === undefined ? undefined : repository.getActiveSnapshot(activeProjectRoot);
    return { repository, ...(snapshot === undefined ? {} : { snapshot }) };
  }

  async function resolvePolicyModel(
    context: ExtensionContext,
    repository: PolicyRepository,
    signal?: AbortSignal,
  ): Promise<PolicyModel | undefined> {
    if (repository.getRemoteConsent() !== true) {
      return undefined;
    }
    try {
      const apiKey = await context.modelRegistry.getApiKeyForProvider(
        "typesafe-ai",
        context.sessionManager.getSessionId(),
        signal === undefined ? {} : { signal },
      );
      if (apiKey === undefined || apiKey.trim().length === 0) {
        return undefined;
      }
      if (cachedModel?.apiKey === apiKey) {
        return cachedModel.model;
      }
      const model =
        options.createPolicyModel?.(apiKey, () => repository.getRemoteConsent() === true) ??
        createTypeSafePolicyModel({
          apiKey,
          hasConsent: () => repository.getRemoteConsent() === true,
        });
      cachedModel = { apiKey, model };
      return model;
    } catch {
      return undefined;
    }
  }

  async function evaluateAction(
    action: PolicyAction,
    context: ExtensionContext,
    signal?: AbortSignal,
    explicitAuthorization = authorization,
  ): Promise<{ readonly decision: PolicyDecision; readonly snapshot?: PolicySnapshot }> {
    const { repository, snapshot } = await ensureSnapshot(context, action.operation);
    const model =
      snapshot === undefined ? undefined : await resolvePolicyModel(context, repository, signal);
    const decision = await evaluateSnapshotPolicy({
      action,
      context: {
        headless: !context.hasUI,
        ...(explicitAuthorization === undefined ? {} : { authorization: explicitAuthorization }),
        ...(snapshot === undefined
          ? {}
          : { snapshot: { projectRoot: snapshot.projectRoot, snapshotId: snapshot.id } }),
      },
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(model === undefined ? {} : { model }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (activeProjectRoot !== undefined) {
      repository.appendAudit(createDecisionAudit(activeProjectRoot, action, decision, snapshot));
    }
    return { decision, ...(snapshot === undefined ? {} : { snapshot }) };
  }

  async function initialize(context: ExtensionContext): Promise<void> {
    try {
      await onboard(context);
    } catch {
      context.ui.setStatus(STATUS_KEY, "policy: fallback (onboarding failed)");
    }
  }

  pi.on("session_start", async (_event, context) => initialize(context));
  pi.on("session_switch", async (_event, context) => initialize(context));

  pi.on("before_agent_start", (event) => {
    authorization = {
      source: "current-turn",
      explicit: true,
      summary: redactText(event.prompt).slice(0, 1_000),
    };
  });

  pi.on("tool_call", async (event, context) => {
    const action = normalizeOmpToolCall(event, context, {
      toolInfo: findToolInfo(pi, toolInfoByName, event.toolName),
    });
    const { decision, snapshot } = await evaluateAction(action, context);
    pendingActions.set(action.id, { action, ...(snapshot === undefined ? {} : { snapshot }) });
    const result = await applyOmpToolDecision(decision, context);
    if (result?.block === true) {
      await recordOutcome(action, snapshot, context, "blocked");
      pendingActions.delete(action.id);
    }
    return result;
  });

  pi.on("tool_result", async (event, context) => {
    const pending = pendingActions.get(event.toolCallId);
    if (pending === undefined) {
      return;
    }
    pendingActions.delete(event.toolCallId);
    await recordOutcome(
      pending.action,
      pending.snapshot,
      context,
      event.isError ? "error" : "success",
    );
    if (
      !event.isError &&
      pending.snapshot !== undefined &&
      actionMayMutatePolicySources(pending.action, pending.snapshot)
    ) {
      const repository = await repositoryPromise;
      repository.markStale(pending.snapshot.projectRoot);
      updateStatus(context, repository, activeProjectRoot);
    }
  });

  pi.on("user_bash", async (event, context) => {
    const action = createDirectAction(
      "command",
      event.command,
      event.cwd,
      context.sessionManager.getSessionId(),
      "user_bash",
    );
    const directAuthorization = currentTurnAuthorization(event.command);
    const { decision, snapshot } = await evaluateAction(
      action,
      context,
      undefined,
      directAuthorization,
    );
    if (await decisionAllowsExecution(decision, context)) {
      return;
    }
    await recordOutcome(action, snapshot, context, "blocked");
    return { result: blockedBashResult(event.cwd, decision) };
  });

  pi.on("user_python", async (event, context) => {
    const action = createDirectAction(
      "code",
      event.code,
      event.cwd,
      context.sessionManager.getSessionId(),
      "user_python",
    );
    const directAuthorization = currentTurnAuthorization(event.code);
    const { decision, snapshot } = await evaluateAction(
      action,
      context,
      undefined,
      directAuthorization,
    );
    if (await decisionAllowsExecution(decision, context)) {
      return;
    }
    await recordOutcome(action, snapshot, context, "blocked");
    return { result: blockedPythonResult(decision) };
  });

  pi.on("input", async (event, context) => {
    const match = event.text.match(/^\/([^\s]+)(?:\s|$)/u);
    const command = match?.[1]?.toLowerCase();
    if (command === undefined || MUTATING_SLASH_COMMANDS[command] !== true) {
      return;
    }
    const action = createDirectAction(
      "command",
      event.text,
      context.cwd,
      context.sessionManager.getSessionId(),
      `slash:${command}`,
    );
    const { decision, snapshot } = await evaluateAction(
      action,
      context,
      undefined,
      currentTurnAuthorization(event.text),
    );
    if (await decisionAllowsExecution(decision, context)) {
      return;
    }
    await recordOutcome(action, snapshot, context, "blocked");
    context.ui.notify(decisionReason(decision), "warning");
    return { handled: true };
  });

  pi.on("session_stop", async (event, context) => {
    const action: PolicyAction = {
      id: `session-stop:${event.session_id}:${event.turn_id}`,
      occurredAtMs: Date.now(),
      actor: { kind: "agent", sessionId: event.session_id },
      workingDirectory: context.cwd,
      operation: "workflow",
      interception: "precise",
      targets: [],
      hostAction: { host: "omp", name: "session_stop", input: {} },
    };
    const { decision } = await evaluateAction(action, context, event.signal);
    if (decision.effect === "allow" || lastContinuationTurn === event.turn_id) {
      return;
    }
    lastContinuationTurn = event.turn_id;
    return { decision: "block", reason: decisionReason(decision) };
  });

  pi.registerCommand("policy", {
    description: "Onboard, inspect, or configure semantic policy",
    handler: async (args, context) => {
      const repository = await repositoryPromise;
      const [command = "status", value] = args.trim().split(/\s+/u);
      if (command === "coverage") {
        context.ui.notify(formatCoverageReport(), "info");
      } else if (command === "onboard") {
        await onboard(context, true);
        context.ui.notify(formatProjectPolicyStatus(repository, activeProjectRoot), "info");
      } else if (command === "review") {
        context.ui.notify(formatProjectPolicyReview(repository, activeProjectRoot), "info");
      } else if (command === "consent" && (value === "on" || value === "off")) {
        repository.setRemoteConsent(value === "on");
        cachedModel = undefined;
        updateStatus(context, repository, activeProjectRoot);
        context.ui.notify(
          `Remote semantic evaluation ${value === "on" ? "enabled" : "disabled"}.`,
          "info",
        );
      } else if (command === "status" || command.length === 0) {
        context.ui.notify(formatProjectPolicyStatus(repository, activeProjectRoot), "info");
      } else {
        context.ui.notify(
          "Usage: /policy [status|coverage|onboard|review|consent on|consent off]",
          "warning",
        );
      }
    },
  });

  pi.on("session_shutdown", async (_event, context) => {
    context.ui.setStatus(STATUS_KEY, undefined);
    (await repositoryPromise).close();
  });

  async function recordOutcome(
    action: PolicyAction,
    snapshot: PolicySnapshot | undefined,
    context: ExtensionContext,
    outcome: "success" | "error" | "blocked",
  ): Promise<void> {
    if (activeProjectRoot === undefined) {
      return;
    }
    const repository = await repositoryPromise;
    repository.appendAudit({
      phase: "result",
      actionId: action.id,
      projectRoot: activeProjectRoot,
      ...(snapshot === undefined ? {} : { snapshotId: snapshot.id }),
      occurredAtMs: Date.now(),
      operation: action.operation,
      interception: action.interception,
      targetSummaries: summarizeTargets(action),
      outcome,
    });
    updateStatus(context, repository, activeProjectRoot);
  }
}

function defaultProfileInstructionPaths(): readonly string[] {
  return [
    join(getAgentDir(), "AGENTS.md"),
    join(getAgentDir(), "CLAUDE.md"),
    join(homedir(), ".claude", "CLAUDE.md"),
  ];
}

function createDecisionAudit(
  projectRoot: string,
  action: PolicyAction,
  decision: PolicyDecision,
  snapshot: PolicySnapshot | undefined,
): PolicyAuditRecord {
  return {
    phase: action.operation === "workflow" ? "workflow" : "decision",
    actionId: action.id,
    projectRoot,
    ...(snapshot === undefined ? {} : { snapshotId: snapshot.id }),
    occurredAtMs: Date.now(),
    operation: action.operation,
    interception: action.interception,
    targetSummaries: summarizeTargets(action),
    effect: decision.effect,
    evaluatorId: decision.evidence.evaluatorId,
    evidenceSource: decision.evidence.source,
    ruleIds: decision.evidence.ruleIds,
  };
}

function summarizeTargets(action: PolicyAction): readonly string[] {
  return action.targets.map((target) => `${target.kind}:${redactText(target.value).slice(0, 200)}`);
}

function currentTurnAuthorization(summary: string): AuthorizationEnvelope {
  return {
    source: "current-turn",
    explicit: true,
    summary: redactText(summary).slice(0, 1_000),
  };
}

function createDirectAction(
  targetKind: "command" | "code",
  value: string,
  workingDirectory: string,
  sessionId: string,
  hostName: string,
): PolicyAction {
  return {
    id: randomUUID(),
    occurredAtMs: Date.now(),
    actor: { kind: "user", sessionId },
    workingDirectory,
    operation: "execute",
    interception: "precise",
    targets: [{ kind: targetKind, value }],
    hostAction: { host: "omp", name: hostName, input: {} },
  };
}

async function decisionAllowsExecution(
  decision: PolicyDecision,
  context: ExtensionContext,
): Promise<boolean> {
  if (decision.effect === "allow" || decision.effect === "revise") {
    return true;
  }
  if (decision.effect === "deny" || !context.hasUI) {
    return false;
  }
  return context.ui.confirm("OMP Semantic Policy", decision.reason);
}

function blockedBashResult(cwd: string, decision: PolicyDecision) {
  const output = `Blocked by OMP Semantic Policy: ${decisionReason(decision)}`;
  const bytes = Buffer.byteLength(output);
  return {
    output,
    exitCode: 126,
    cancelled: false,
    truncated: false,
    totalLines: 1,
    totalBytes: bytes,
    outputLines: 1,
    outputBytes: bytes,
    workingDir: cwd,
  };
}

function blockedPythonResult(decision: PolicyDecision) {
  const output = `Blocked by OMP Semantic Policy: ${decisionReason(decision)}`;
  const bytes = Buffer.byteLength(output);
  return {
    output,
    exitCode: 1,
    cancelled: false,
    truncated: false,
    totalLines: 1,
    totalBytes: bytes,
    outputLines: 1,
    outputBytes: bytes,
    displayOutputs: [],
    stdinRequested: false,
  };
}

function decisionReason(decision: PolicyDecision): string {
  return decision.effect === "allow" ? "Action allowed." : decision.reason;
}

function updateStatus(
  context: ExtensionContext,
  repository: PolicyRepository,
  projectRoot: string | undefined,
): void {
  if (projectRoot === undefined) {
    context.ui.setStatus(STATUS_KEY, "policy: conservative fallback");
    return;
  }
  const project = repository.getProject(projectRoot);
  context.ui.setStatus(STATUS_KEY, project?.stale === true ? "policy: stale" : "policy: active");
}

function findToolInfo(
  pi: ExtensionAPI,
  toolInfoByName: Map<string, ToolInfo>,
  toolName: string,
): ToolInfo | undefined {
  const cached = toolInfoByName.get(toolName);
  if (cached !== undefined) {
    return cached;
  }
  for (const toolInfo of pi.getAllTools()) {
    toolInfoByName.set(toolInfo.name, toolInfo);
  }
  return toolInfoByName.get(toolName);
}
