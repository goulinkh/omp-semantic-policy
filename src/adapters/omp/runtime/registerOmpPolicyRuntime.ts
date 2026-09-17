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
import { POLICY_LOGO, POLICY_NAME, brandPolicyText } from "../policyIdentity.js";
import { createDefaultModelStandardsCompletion } from "./createDefaultModelStandardsCompletion.js";
import {
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
  let activeProjectRoot: string | undefined;
  let authorization: AuthorizationEnvelope | undefined;
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
    enabledToolCalls: [],
    confirmationThreshold: 1,
  };
  let disabledToolCallNames = new Set<string>();
  let enabledToolCallNames = new Set<string>();
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
          "Allow redacted policy rules, action metadata, and current-turn authorization summaries to be evaluated by TypeSafe AI? Raw tool inputs are never sent.",
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
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
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
  ): Promise<{ readonly decision: PolicyDecision; readonly snapshot?: PolicySnapshot }> {
    const { repository, snapshot } = await ensureSnapshot(context, action.operation);
    const model =
      snapshot === undefined ? undefined : await resolvePolicyModel(context, repository, signal);
    const evaluatedDecision = await evaluateSnapshotPolicy({
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
      confirmation: {
        defaultAction: runtimeSettings.confirmationDefault,
        threshold: runtimeSettings.confirmationThreshold,
      },
    });
    if (repository.getRemoteConsent() !== true) {
      semanticEvaluatorState = "disabled";
    } else if (model === undefined) {
      semanticEvaluatorState =
        semanticEvaluatorIssue === "login-required" ? "login-required" : "unavailable";
    } else if (evaluatedDecision.evidence.source !== "fallback") {
      semanticEvaluatorState = "available";
    } else {
      semanticEvaluatorState = "unavailable";
      semanticEvaluatorIssue = "evaluation-failed";
    }
    const decision = clarifyUnavailableEvaluator(evaluatedDecision, action, semanticEvaluatorIssue);
    refreshStatus(context, repository);
    const feedback = formatPolicyDecisionFeedback(decision);
    if (runtimeSettings.showViolationFeedback && context.hasUI && feedback !== undefined) {
      context.ui.notify(stylePolicyDecisionFeedback(feedback, decision, context.ui.theme), "info");
    }
    if (activeProjectRoot !== undefined) {
      repository.appendAudit(createDecisionAudit(activeProjectRoot, action, decision, snapshot));
    }
    return { decision, ...(snapshot === undefined ? {} : { snapshot }) };
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
    authorization = {
      source: "current-turn",
      explicit: true,
      summary: redactText(event.prompt).slice(0, 1_000),
    };
    runtimeSystemPrompt = event.systemPrompt;
    try {
      await onboard(context);
    } catch {
      context.ui.setStatus(STATUS_KEY, `${POLICY_LOGO} fallback · onboarding failed`);
    }
  });

  pi.on("tool_call", async (event, context) => {
    if (
      disabledToolCallNames.has(event.toolName) ||
      (enabledToolCallNames.size > 0 && !enabledToolCallNames.has(event.toolName))
    ) {
      return;
    }
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
    description: `${POLICY_LOGO} Onboard, inspect, or configure semantic policy`,
    getArgumentCompletions: getPolicyArgumentCompletions,
    handler: async (args, context) => {
      const { command, value } = parsePolicyCommandArguments(args);
      if (command === "coverage") {
        context.ui.notify(formatCoverageReport(), "info");
      } else if (command === "onboard") {
        startManualOnboarding(context);
      } else if (command === "review") {
        const repository = await repositoryPromise;
        context.ui.notify(formatProjectPolicyReview(repository, activeProjectRoot), "info");
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
          brandPolicyText("Usage: /policy [status|review|coverage|onboard|consent on|consent off]"),
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
    decision.evidence.source !== "fallback"
  ) {
    return decision;
  }
  const setup = (() => {
    switch (issue) {
      case "consent-disabled":
        return "Remote semantic evaluation is disabled. Run /policy consent on.";
      case "login-required":
        return "TypeSafe login required. Run /login typesafe-ai or set TYPESAFE_API_KEY.";
      case "credential-resolution-failed":
        return "TypeSafe credential resolution failed. Run /login typesafe-ai to refresh it.";
      case "evaluation-failed":
        return "TypeSafe policy evaluation failed. Check network access or run /login typesafe-ai.";
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
