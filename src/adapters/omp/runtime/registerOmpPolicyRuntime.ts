import {
  getAgentDir,
  logger,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolInfo,
} from "@oh-my-pi/pi-coding-agent";
import { Loader } from "@oh-my-pi/pi-tui";
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
import { selectShellPayloadFacts } from "../../../policy/actions/shellArguments.js";
import {
  createTypeSafePolicyModel,
  DEFAULT_TYPESAFE_POLICY_MODEL,
  redactText,
  registerTypeSafeProvider,
  TYPESAFE_QUESTION_VERSION,
  TYPESAFE_THRESHOLD_VERSION,
} from "../../typesafe/index.js";
import {
  getPolicyArgumentCompletions,
  parsePolicyCommandArguments,
} from "../commands/policyCommand.js";
import { formatCoverageReport } from "../coverage/formatCoverageReport.js";
import { applyOmpToolDecision } from "../events/applyToolDecision.js";
import { normalizeOmpToolCall } from "../events/normalizeToolCall.js";
import {
  createProjectOnboarder,
  createStandardsSourceResolver,
  formatProjectPolicyReview,
  formatProjectPolicyStatus,
  type StandardsModelCompletion,
} from "../onboarding/index.js";
import { createPolicyRepository, type PolicyRepository } from "../persistence/index.js";
import { evaluateSnapshotPolicy } from "../enforcement/evaluateSnapshotPolicy.js";
import { bindRequestAuthorization } from "../enforcement/bindRequestAuthorization.js";
import {
  createMaintenanceApprovals,
  digestPolicyAction,
} from "../enforcement/maintenanceApprovals.js";
import { POLICY_LOGO, POLICY_NAME, brandPolicyText } from "../policyIdentity.js";
import { createDefaultModelStandardsCompletion } from "./createDefaultModelStandardsCompletion.js";
import {
  DEFAULT_ENABLED_TOOL_CALLS,
  createPolicyStatusBarController,
  formatPolicyDecisionFeedback,
  stylePolicyDecisionFeedback,
  loadPolicyRuntimeSettings,
  type PolicyRuntimeSettings,
} from "./policyPresentation.js";

const STATUS_KEY = "omp-semantic-policy";
const MANUAL_ONBOARDING_START_DELAY_MS = 25;
const ONBOARDING_WIDGET_KEY = "omp-semantic-policy-onboarding";
const ONBOARDING_PROGRESS_MESSAGE = "Discovering policy sources and compiling snapshot…";

interface PendingAction {
  readonly action: PolicyAction;
  readonly snapshot?: PolicySnapshot;
}
type SemanticEvaluatorState =
  | "available"
  | "unavailable"
  | "disabled"
  | "login-required"
  | undefined;
type SemanticEvaluatorIssue =
  | "consent-disabled"
  | "login-required"
  | "credential-resolution-failed"
  | "evaluation-failed"
  | undefined;
export interface OmpPolicyRuntimeOptions {
  readonly databasePath?: string;
  readonly profileInstructionPaths?: readonly string[];
  readonly createPolicyModel?: (apiKey: string, hasConsent: () => boolean) => PolicyModel;
  readonly standardsCompletion?: StandardsModelCompletion;
  readonly runtimeSettings?: Partial<PolicyRuntimeSettings>;
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
  const maintenance = createMaintenanceApprovals();
  let activeProjectRoot: string | undefined;
  let authorization: AuthorizationEnvelope | undefined;
  let originalRequest: string | undefined;
  let consentPromptActive = false;
  let lastContinuationTurn: number | undefined;
  let cachedModel: { readonly apiKey: string; readonly model: PolicyModel } | undefined;
  let semanticEvaluatorState: SemanticEvaluatorState;
  let semanticEvaluatorIssue: SemanticEvaluatorIssue;
  let standardsContext: ExtensionContext | undefined;
  let runtimeSystemPrompt: readonly string[] | undefined;
  let runtimeSettings: PolicyRuntimeSettings = {
    showStatus: true,
    showViolationFeedback: true,
    confirmationDefault: "deny",
    disabledToolCalls: [],
    enabledToolCalls: DEFAULT_ENABLED_TOOL_CALLS,
    confirmationThreshold: 1,
  };
  let disabledToolCallNames = new Set<string>();
  let enabledToolCallNames = new Set(runtimeSettings.enabledToolCalls);
  let manualOnboardingRunning = false;
  let onboardingQueue: Promise<void> = Promise.resolve();
  const statusBarController = createPolicyStatusBarController();
  statusBarController.configure(options.runtimeSettings?.showStatus !== false);
  const standardsSourceResolver = createStandardsSourceResolver({
    complete:
      options.standardsCompletion ?? createDefaultModelStandardsCompletion(() => standardsContext),
    getRuntimeContext: () => runtimeSystemPrompt ?? standardsContext?.getSystemPrompt?.() ?? [],
    sanitize: redactText,
  });

  pi.setLabel(POLICY_NAME);
  function refreshStatus(context: ExtensionContext, repository: PolicyRepository): void {
    updateStatus(
      context,
      repository,
      activeProjectRoot,
      runtimeSettings.showStatus,
      semanticEvaluatorState,
    );
  }

  async function performOnboarding(context: ExtensionContext, force: boolean): Promise<void> {
    standardsContext = context;
    const repository = await repositoryPromise;
    const onboarder = createProjectOnboarder({
      repository,
      profileInstructionPaths: options.profileInstructionPaths ?? defaultProfileInstructionPaths(),
      versions: {
        question: TYPESAFE_QUESTION_VERSION,
        thresholds: TYPESAFE_THRESHOLD_VERSION,
        model: DEFAULT_TYPESAFE_POLICY_MODEL,
      },
      standardsSourceResolver,
    });
    const result = await onboarder.onboard(context.cwd, force);
    activeProjectRoot = result.kind === "ready" ? result.projectRoot : undefined;

    if (repository.getRemoteConsent() === undefined && context.hasUI && !consentPromptActive) {
      consentPromptActive = true;
      try {
        const consented = await context.ui.confirm(
          POLICY_NAME,
          "Allow redacted policy rules, selected action details, and current-turn requests to be evaluated by TypeSafe AI? Credentials are redacted before transmission.",
        );
        repository.setRemoteConsent(consented);
      } finally {
        consentPromptActive = false;
      }
    }

    if (manualOnboardingRunning && runtimeSettings.showStatus) {
      context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} onboarding…`);
    } else {
      refreshStatus(context, repository);
    }
  }

  async function onboard(context: ExtensionContext, force = false): Promise<void> {
    const scheduled = onboardingQueue
      .catch(() => undefined)
      .then(() => performOnboarding(context, force));
    onboardingQueue = scheduled;
    await scheduled;
  }

  async function ensureSnapshot(
    context: ExtensionContext,
    operation: PolicyAction["operation"],
  ): Promise<{ readonly repository: PolicyRepository; readonly snapshot?: PolicySnapshot }> {
    const repository = await repositoryPromise;
    const highImpact = operation !== "read" && operation !== "workflow" && operation !== "internal";
    if (
      activeProjectRoot === undefined ||
      highImpact ||
      repository.getProject(activeProjectRoot)?.stale
    ) {
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
      semanticEvaluatorState = "disabled";
      semanticEvaluatorIssue = "consent-disabled";
      return undefined;
    }
    try {
      const apiKey = await context.modelRegistry.getApiKeyForProvider(
        "typesafe-ai",
        context.sessionManager.getSessionId(),
        signal === undefined ? {} : { signal },
      );
      if (apiKey === undefined || apiKey.trim().length === 0) {
        semanticEvaluatorState = "login-required";
        semanticEvaluatorIssue = "login-required";
        return undefined;
      }
      semanticEvaluatorIssue = undefined;
      if (cachedModel?.apiKey === apiKey) {
        return cachedModel.model;
      }
      const model =
        options.createPolicyModel?.(apiKey, () => repository.getRemoteConsent() === true) ??
        createTypeSafePolicyModel({
          apiKey,
          hasConsent: () => repository.getRemoteConsent() === true,
          onError: (error) => {
            logger.warn("TypeSafe policy evaluation failed", {
              error: redactText(
                error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              ),
            });
          },
        });
      cachedModel = { apiKey, model };
      return model;
    } catch {
      semanticEvaluatorState = "unavailable";
      semanticEvaluatorIssue = "credential-resolution-failed";
      return undefined;
    }
  }

  async function evaluateAction(
    action: PolicyAction,
    context: ExtensionContext,
    signal?: AbortSignal,
    explicitAuthorization = authorization,
    semanticEnabled = true,
  ): Promise<{ readonly decision: PolicyDecision; readonly snapshot?: PolicySnapshot }> {
    const { repository, snapshot } = await ensureSnapshot(context, action.operation);
    const maintenanceApproved =
      snapshot !== undefined && (await maintenance.consume(action, snapshot));
    const boundAuthorization = maintenanceApproved
      ? currentTurnAuthorization(action)
      : bindRequestAuthorization(action, explicitAuthorization, originalRequest);
    let modelRequested = false;
    let model: PolicyModel | undefined;
    const evaluatedDecision = await evaluateSnapshotPolicy({
      action,
      context: {
        headless: !context.hasUI,
        ...(boundAuthorization === undefined ? {} : { authorization: boundAuthorization }),
        ...(snapshot === undefined
          ? {}
          : { snapshot: { projectRoot: snapshot.projectRoot, snapshotId: snapshot.id } }),
      },
      ...(snapshot === undefined ? {} : { snapshot }),
      resolveModel: async () => {
        modelRequested = true;
        model = await resolvePolicyModel(context, repository, signal);
        return model;
      },
      semanticEnabled,
      maintenanceApproved,
      ...(signal === undefined ? {} : { signal }),
      confirmation: {
        defaultAction: runtimeSettings.confirmationDefault,
        threshold: runtimeSettings.confirmationThreshold,
      },
    });
    if (repository.getRemoteConsent() !== true) {
      semanticEvaluatorState = "disabled";
    } else if (modelRequested && model === undefined) {
      semanticEvaluatorState =
        semanticEvaluatorIssue === "login-required" ? "login-required" : "unavailable";
    } else if (modelRequested && evaluatedDecision.evidence.source !== "fallback") {
      semanticEvaluatorState = "available";
    } else if (modelRequested) {
      semanticEvaluatorState = "unavailable";
      semanticEvaluatorIssue = "evaluation-failed";
    }
    const decision = clarifyUnavailableEvaluator(evaluatedDecision, action, semanticEvaluatorIssue);
    refreshStatus(context, repository);
    const feedback = formatPolicyDecisionFeedback(decision);
    if (runtimeSettings.showViolationFeedback && context.hasUI && feedback !== undefined) {
      context.ui.notify(stylePolicyDecisionFeedback(feedback, decision, context.ui.theme), "info");
    }
    return { decision, ...(snapshot === undefined ? {} : { snapshot }) };
  }

  async function recordDecision(
    action: PolicyAction,
    decision: PolicyDecision,
    snapshot: PolicySnapshot | undefined,
    context: ExtensionContext,
    blocked: boolean,
  ): Promise<void> {
    const settled = settleConfirmation(decision, context.hasUI, blocked);
    const projectRoot = snapshot?.projectRoot ?? activeProjectRoot;
    if (projectRoot !== undefined) {
      (await repositoryPromise).appendAudit(
        createDecisionAudit(projectRoot, action, settled, snapshot),
      );
    }
    if (
      blocked &&
      snapshot !== undefined &&
      decision.evidence.diagnostics?.path === "semantic" &&
      decision.evidence.diagnostics.semantic?.adapterEffect === "prompt"
    ) {
      await maintenance.remember(action, snapshot);
      if (
        maintenance.current()?.actionId === action.id &&
        context.hasUI &&
        runtimeSettings.showViolationFeedback
      ) {
        context.ui.notify(
          brandPolicyText(
            "For an exact maintenance retry, inspect /policy maintenance. Hard denials and unavailable evaluation remain blocking.",
          ),
          "info",
        );
      }
    }
  }

  function startManualOnboarding(context: ExtensionContext): void {
    context.ui.setEditorText("");
    if (manualOnboardingRunning) {
      context.ui.notify(brandPolicyText("Policy onboarding is already in progress."), "info");
      return;
    }

    manualOnboardingRunning = true;
    context.ui.setWidget(
      ONBOARDING_WIDGET_KEY,
      (tui, theme) =>
        new Loader(
          tui,
          (spinner) => theme.fg("accent", spinner),
          (message) => theme.fg("muted", message),
          ONBOARDING_PROGRESS_MESSAGE,
          theme.spinnerFrames,
        ),
      { placement: "aboveEditor" },
    );
    context.ui.notify(brandPolicyText("Policy onboarding started."), "info");
    if (runtimeSettings.showStatus) {
      context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} onboarding…`);
    }
    let completed = false;
    context.setTimeout(async () => {
      try {
        const repository = await repositoryPromise;
        await onboard(context, true);
        completed = true;
        context.ui.notify(
          formatProjectPolicyStatus(repository, activeProjectRoot, semanticEvaluatorState),
          "info",
        );
      } catch (error) {
        if (runtimeSettings.showStatus) {
          context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} fallback · onboarding failed`);
        }
        context.ui.notify(
          brandPolicyText(
            `Policy onboarding failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
          "error",
        );
      } finally {
        manualOnboardingRunning = false;
        if (completed) {
          refreshStatus(context, await repositoryPromise);
        }
        context.ui.setWidget(ONBOARDING_WIDGET_KEY, undefined);
        clearCompletedOnboardingEditor(context);
      }
    }, MANUAL_ONBOARDING_START_DELAY_MS);
  }

  function scheduleAutomaticOnboarding(context: ExtensionContext): void {
    context.setTimeout(async () => {
      try {
        await onboard(context);
      } catch {
        if (runtimeSettings.showStatus) {
          context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} fallback · onboarding failed`);
        }
      }
    });
  }

  async function initialize(context: ExtensionContext): Promise<void> {
    lastContinuationTurn = undefined;
    activeProjectRoot = undefined;
    authorization = undefined;
    originalRequest = undefined;
    semanticEvaluatorState = undefined;
    semanticEvaluatorIssue = undefined;
    pendingActions.clear();
    maintenance.clear();
    runtimeSettings = await loadPolicyRuntimeSettings(context.cwd, options.runtimeSettings);
    disabledToolCallNames = new Set(runtimeSettings.disabledToolCalls);
    enabledToolCallNames = new Set(runtimeSettings.enabledToolCalls);
    statusBarController.configure(runtimeSettings.showStatus);
    if (!runtimeSettings.showStatus) {
      context.ui.setStatus(STATUS_KEY, undefined);
    }
    runtimeSystemPrompt = context.getSystemPrompt?.() ?? [];
    // Do not block OMP's input routing on model-assisted discovery. A command can
    // now render progress immediately while automatic onboarding continues.
    if (isOnboardingCommand(context.ui.getEditorText())) {
      startManualOnboarding(context);
    } else {
      scheduleAutomaticOnboarding(context);
    }
  }

  pi.on("session_start", async (_event, context) => initialize(context));
  pi.on("session_switch", async (_event, context) => initialize(context));

  pi.on("before_agent_start", async (event, context) => {
    originalRequest = event.prompt;
    authorization = {
      source: "current-turn",
      explicit: false,
      scope: "request",
      summary: redactText(event.prompt),
    };
    runtimeSystemPrompt = event.systemPrompt;
    try {
      await onboard(context);
    } catch {
      context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} fallback · onboarding failed`);
    }
  });

  pi.on("tool_call", async (event, context) => {
    const coverageToolName =
      event.toolName === "write" && event.input.path === "xd://lsp" ? "lsp" : event.toolName;
    const semanticEnabled =
      !disabledToolCallNames.has(coverageToolName) &&
      (enabledToolCallNames.size === 0 || enabledToolCallNames.has(coverageToolName));
    const action = normalizeOmpToolCall(event, context, {
      toolInfo: findToolInfo(pi, toolInfoByName, event.toolName),
    });
    const { decision, snapshot } = await evaluateAction(
      action,
      context,
      undefined,
      authorization,
      semanticEnabled,
    );
    pendingActions.set(action.id, { action, ...(snapshot === undefined ? {} : { snapshot }) });
    const result = await applyOmpToolDecision(decision, context);
    await recordDecision(action, decision, snapshot, context, result?.block === true);
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
      refreshStatus(context, repository);
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
    const directAuthorization = currentTurnAuthorization(action);
    const { decision, snapshot } = await evaluateAction(
      action,
      context,
      undefined,
      directAuthorization,
    );
    const allowed = await decisionAllowsExecution(decision, context);
    await recordDecision(action, decision, snapshot, context, !allowed);
    if (allowed) {
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
    const directAuthorization = currentTurnAuthorization(action);
    const { decision, snapshot } = await evaluateAction(
      action,
      context,
      undefined,
      directAuthorization,
    );
    const allowed = await decisionAllowsExecution(decision, context);
    await recordDecision(action, decision, snapshot, context, !allowed);
    if (allowed) {
      return;
    }
    await recordOutcome(action, snapshot, context, "blocked");
    return { result: blockedPythonResult(decision) };
  });

  pi.on("session_stop", async (event, context) => {
    if (lastContinuationTurn === event.turn_id) {
      return;
    }
    const action: PolicyAction = {
      id: `session-stop:${event.session_id}:${event.turn_id}`,
      occurredAtMs: Date.now(),
      actor: { kind: "agent", sessionId: event.session_id },
      workingDirectory: context.cwd,
      operation: "workflow",
      interception: "precise",
      targets: [],
      complete: true,
      details: { event: "session_stop" },
      hostAction: { host: "omp", name: "session_stop", input: {} },
    };
    const { decision, snapshot } = await evaluateAction(action, context, event.signal);
    const allowed = await decisionAllowsExecution(decision, context);
    await recordDecision(action, decision, snapshot, context, !allowed);
    if (allowed) {
      return;
    }
    lastContinuationTurn = event.turn_id;
    return { decision: "block", reason: decisionReason(decision) };
  });

  pi.registerCommand("policy", {
    description: `${POLICY_LOGO} Onboard, inspect, or configure semantic policy`,
    getArgumentCompletions: getPolicyArgumentCompletions,
    handler: async (args, context) => {
      const { command, value, actionId } = parsePolicyCommandArguments(args);
      if (command === "coverage") {
        context.ui.notify(formatCoverageReport(), "info");
      } else if (command === "onboard") {
        startManualOnboarding(context);
      } else if (command === "review") {
        const repository = await repositoryPromise;
        context.ui.notify(formatProjectPolicyReview(repository, activeProjectRoot), "info");
      } else if (command === "audit") {
        const limit = value === undefined ? 10 : Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          context.ui.notify(brandPolicyText("Usage: /policy audit [1–100]"), "warning");
          return;
        }
        const repository = await repositoryPromise;
        const records =
          activeProjectRoot === undefined ? [] : repository.listAudits(activeProjectRoot, limit);
        context.ui.notify(
          brandPolicyText(`Recent redacted audit records:\n${JSON.stringify(records, null, 2)}`),
          "info",
        );
      } else if (command === "maintenance") {
        if (value === "revoke") {
          maintenance.clear();
          context.ui.notify(brandPolicyText("Maintenance authorization cleared."), "info");
        } else if (value === "approve" && actionId !== undefined) {
          await onboard(context);
          const repository = await repositoryPromise;
          const snapshot =
            activeProjectRoot === undefined
              ? undefined
              : repository.getActiveSnapshot(activeProjectRoot);
          const approved =
            snapshot !== undefined &&
            maintenance.approve(actionId, snapshot, context.sessionManager.getSessionId());
          context.ui.notify(
            brandPolicyText(
              approved
                ? "Approved one identical maintenance retry in this session and snapshot. Hard denials, incomplete intent, and unavailable evaluation still block."
                : "No matching maintenance candidate. Inspect /policy maintenance; changed policy requires a new denied proposal.",
            ),
            approved ? "info" : "warning",
          );
        } else if (value === undefined) {
          const candidate = maintenance.current();
          context.ui.notify(
            brandPolicyText(
              candidate === undefined
                ? "No pending maintenance candidate. Only uncertain project-local install/link or plugin lockfile writes qualify."
                : `${candidate.summary}\nAction ID: ${candidate.actionId}\nInput digest: ${candidate.digest}\nSnapshot: ${candidate.snapshotId}\nReview the original tool input, then /policy maintenance approve ${candidate.actionId}. One exact retry only; no hard-policy or availability bypass.`,
            ),
            "info",
          );
        } else {
          context.ui.notify(
            brandPolicyText("Usage: /policy maintenance [approve <action-id>|revoke]"),
            "warning",
          );
        }
      } else if (command === "consent" && (value === "on" || value === "off")) {
        const repository = await repositoryPromise;
        repository.setRemoteConsent(value === "on");
        semanticEvaluatorIssue = value === "on" ? undefined : "consent-disabled";
        cachedModel = undefined;
        semanticEvaluatorState = value === "on" ? undefined : "disabled";
        refreshStatus(context, repository);
        context.ui.notify(
          brandPolicyText(`Remote semantic evaluation ${value === "on" ? "enabled" : "disabled"}.`),
          "info",
        );
      } else if (command === "status" || command.length === 0) {
        const repository = await repositoryPromise;
        context.ui.notify(
          formatProjectPolicyStatus(repository, activeProjectRoot, semanticEvaluatorState),
          "info",
        );
      } else {
        context.ui.notify(
          brandPolicyText(
            "Usage: /policy [status|review|coverage|onboard|audit [1–100]|maintenance [approve <action-id>|revoke]|consent on|consent off]",
          ),
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
    refreshStatus(context, repository);
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
    ...(decision.evidence.applicableRuleIds === undefined
      ? {}
      : { applicableRuleIds: decision.evidence.applicableRuleIds }),
    ...(decision.evidence.diagnostics === undefined
      ? {}
      : { diagnostics: decision.evidence.diagnostics }),
  };
}

function summarizeTargets(action: PolicyAction): readonly string[] {
  return action.targets.map((target) => `${target.kind}:${redactText(target.value).slice(0, 200)}`);
}

function currentTurnAuthorization(action: PolicyAction): AuthorizationEnvelope {
  return {
    source: "current-turn",
    explicit: true,
    scope: "exact-action",
    actionDigest: digestPolicyAction(action),
    summary: "The user directly requested this exact action.",
  };
}

function settleConfirmation(
  decision: PolicyDecision,
  hasUI: boolean,
  blocked: boolean,
): PolicyDecision {
  if (decision.effect !== "prompt") return decision;
  const effect: "allow" | "deny" = blocked ? "deny" : "allow";
  const evidence = {
    ...decision.evidence,
    ...(decision.evidence.diagnostics === undefined
      ? {}
      : {
          diagnostics: {
            ...decision.evidence.diagnostics,
            enforcedEffect: effect,
            confirmation: {
              ...decision.evidence.diagnostics.confirmation,
              resolution: !hasUI
                ? ("headless-denied" as const)
                : blocked
                  ? ("user-denied" as const)
                  : ("user-approved" as const),
            },
          },
        }),
  };
  return blocked
    ? { effect: "deny", reason: decision.reason, evidence }
    : { effect: "allow", evidence };
}

function createDirectAction(
  targetKind: "command" | "code",
  value: string,
  workingDirectory: string,
  sessionId: string,
  hostName: string,
): PolicyAction {
  const shellPayload = targetKind === "command" ? selectShellPayloadFacts(value) : undefined;
  return {
    id: randomUUID(),
    occurredAtMs: Date.now(),
    actor: { kind: "user", sessionId },
    workingDirectory,
    operation: "execute",
    interception: "precise",
    complete: true,
    details: { [targetKind]: value, ...(shellPayload === undefined ? {} : { shellPayload }) },
    targets: [{ kind: targetKind, value }],
    hostAction: { host: "omp", name: hostName, input: { [targetKind]: value } },
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
  return context.ui.confirm(POLICY_NAME, decision.reason);
}

function blockedBashResult(cwd: string, decision: PolicyDecision) {
  const output = brandPolicyText(`Blocked: ${decisionReason(decision)}`);
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
  const output = brandPolicyText(`Blocked: ${decisionReason(decision)}`);
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

function isOnboardingCommand(editorText: string): boolean {
  return /^\/policy\s+onboard\s*$/u.test(editorText.trim());
}

function clearCompletedOnboardingEditor(context: ExtensionContext): void {
  const editorText = context.ui.getEditorText();
  if (editorText.length === 0 || isOnboardingCommand(editorText)) {
    context.ui.setEditorText("");
  }
}

function clarifyUnavailableEvaluator(
  decision: PolicyDecision,
  action: PolicyAction,
  issue: SemanticEvaluatorIssue,
): PolicyDecision {
  if (
    (decision.effect !== "prompt" && decision.effect !== "deny") ||
    decision.evidence.source !== "fallback" ||
    decision.evidence.diagnostics?.path !== "provider-unavailable"
  ) {
    return decision;
  }
  const setup = (() => {
    switch (decision.evidence.diagnostics?.semantic?.unavailableReason) {
      case "context-limit":
        return "Policy contains an indivisible oversized rule/action or exceeds bounded chunk capacity. Inspect sources with /policy review and evaluation details with /policy audit; no policy text was truncated.";
      case "invalid-response":
        return "TypeSafe returned an invalid decision or rule attribution. Inspect /policy audit before retrying; no compliant assessment is available.";
      case "missing-snapshot":
        return "No policy snapshot is available. Open the intended Git project and run /policy onboard.";
      case "not-consented":
        return "Remote semantic evaluation is disabled. Run /policy consent on.";
    }
    switch (issue) {
      case "consent-disabled":
        return "Remote semantic evaluation is disabled. Run /policy consent on.";
      case "login-required":
        return "TypeSafe login required. Run /login typesafe-ai or set TYPESAFE_API_KEY.";
      case "credential-resolution-failed":
        return "TypeSafe credential resolution failed. Run /login typesafe-ai to refresh it.";
      case "evaluation-failed":
        return "TypeSafe policy evaluation failed. Inspect /policy audit and provider availability; retry only after identifying the failure.";
      case undefined:
        return undefined;
    }
  })();
  if (setup === undefined) {
    return decision;
  }
  return {
    ...decision,
    reason:
      decision.effect === "prompt"
        ? `${setup} This ${action.operation} action remains unclassified, so approval is required before ${action.hostAction.name} can run.`
        : `${setup} This ${action.operation} action remains unclassified and was denied by confirmation settings.`,
  };
}

function updateStatus(
  context: ExtensionContext,
  repository: PolicyRepository,
  projectRoot: string | undefined,
  visible: boolean,
  semanticEvaluatorState: SemanticEvaluatorState,
): void {
  if (!visible) {
    context.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  if (projectRoot === undefined) {
    context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} conservative fallback`);
    return;
  }
  const project = repository.getProject(projectRoot);
  if (project?.stale === true) {
    context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} stale`);
  } else if (semanticEvaluatorState === "unavailable") {
    context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} evaluator unavailable`);
  } else if (semanticEvaluatorState === "login-required") {
    context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} evaluator login required`);
  } else if (semanticEvaluatorState === "disabled") {
    context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} evaluator disabled`);
  } else {
    context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} active`);
  }
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
