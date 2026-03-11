import { randomUUID } from "node:crypto";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { normalizeAgentId } from "openclaw/plugin-sdk";
import { readLatestAssistantReply } from "../../src/agents/tools/agent-step.js";
import { resolveAnnounceTarget } from "../../src/agents/tools/sessions-announce-target.js";
import { callGateway } from "../../src/gateway/call.js";
import type { OrchestratorConfig } from "./config.js";
import { derivePlanningQueryFromWorkflow, type OrchestratorMemoryIntegration } from "./memory.js";
import { OrchestratorStore, type StoredWorkflowRecord } from "./store.js";
import { validateWorkflowDefinition } from "./validate.js";
import type {
  AgentRunStep,
  ConditionStep,
  SessionMessageStep,
  StepStatus,
  ToolCallStep,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepRecord,
} from "./workflow-schema.js";

function nowIso() {
  return new Date().toISOString();
}

function toStepStatusSummary(workflow: StoredWorkflowRecord) {
  const counts = new Map<StepStatus, number>();
  for (const step of workflow.steps) {
    counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  }
  return Object.fromEntries(counts.entries());
}

function parseIso(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildWorkflowSessionKey(step: AgentRunStep | ToolCallStep, workflowId: string): string {
  return `agent:${normalizeAgentId(step.agentId)}:workflow:${workflowId}:${step.id}`;
}

function trimText(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildDependencyContext(
  workflow: StoredWorkflowRecord,
  step: WorkflowStep,
): string | undefined {
  const dependencyBlocks = (step.dependsOn ?? [])
    .map((depId) => {
      const depRecord = workflow.steps.find((candidate) => candidate.stepId === depId);
      const depDefinition = workflow.definition.steps.find((candidate) => candidate.id === depId);
      const output = trimText(depRecord?.outputSummary);
      if (!output) {
        return undefined;
      }
      const titleParts = [
        depDefinition?.label ? depDefinition.label : undefined,
        depDefinition?.kind,
        depRecord?.targetAgentId ? `agent=${depRecord.targetAgentId}` : undefined,
      ].filter(Boolean);
      const title = titleParts.length > 0 ? titleParts.join(" | ") : depId;
      return [`Dependency ${depId} (${title})`, output].join("\n");
    })
    .filter((value): value is string => Boolean(value));
  if (dependencyBlocks.length === 0) {
    return undefined;
  }
  return [
    `Workflow: ${workflow.definition.label}`,
    "Completed dependency outputs:",
    dependencyBlocks.join("\n\n"),
  ].join("\n\n");
}

function buildStepMessage(workflow: StoredWorkflowRecord, step: WorkflowStep): string {
  const dependencyContext = buildDependencyContext(workflow, step);
  const stepTask =
    step.kind === "tool_call"
      ? step.task?.trim() || `Call the ${step.toolName} tool with the provided arguments.`
      : step.kind === "wait" || step.kind === "condition"
        ? ""
        : step.task;
  if (!dependencyContext || step.kind === "wait" || step.kind === "condition") {
    return stepTask;
  }
  return `${dependencyContext}\n\nCurrent step task:\n${stepTask}`;
}

function buildToolCallSystemPrompt(step: ToolCallStep): string {
  const argsJson = JSON.stringify(step.arguments ?? {}, null, 2);
  return [
    "Workflow tool execution step.",
    `You must call the ${step.toolName} tool before responding.`,
    "Use the provided arguments as the starting point. Only make minimal normalization changes if the target tool requires them.",
    `Tool arguments JSON:\n${argsJson}`,
    "After the tool returns, briefly summarize the result for the workflow transcript.",
  ].join("\n\n");
}

function buildConditionSourceText(workflow: StoredWorkflowRecord, step: ConditionStep): string {
  const outputs = (step.dependsOn ?? [])
    .map((depId) =>
      workflow.steps.find((candidate) => candidate.stepId === depId)?.outputSummary?.trim(),
    )
    .filter((value): value is string => Boolean(value));
  if ((step.source ?? "latest_dependency_output") === "dependencies_output") {
    return outputs.join("\n\n");
  }
  return outputs.at(-1) ?? "";
}

function evaluateCondition(
  sourceText: string,
  step: ConditionStep,
): { passed: boolean; detail: string } {
  const caseSensitive = step.caseSensitive === true;
  const normalizedSource = caseSensitive ? sourceText : sourceText.toLowerCase();
  const normalizedValue = caseSensitive ? step.value : step.value?.toLowerCase();
  switch (step.operator) {
    case "exists":
      return {
        passed: normalizedSource.trim().length > 0,
        detail:
          normalizedSource.trim().length > 0
            ? "dependency output exists"
            : "dependency output is empty",
      };
    case "contains":
      return {
        passed: normalizedValue ? normalizedSource.includes(normalizedValue) : false,
        detail: `contains "${step.value ?? ""}"`,
      };
    case "not_contains":
      return {
        passed: normalizedValue ? !normalizedSource.includes(normalizedValue) : false,
        detail: `does not contain "${step.value ?? ""}"`,
      };
    case "equals":
      return {
        passed: normalizedSource.trim() === (normalizedValue ?? "").trim(),
        detail: `equals "${step.value ?? ""}"`,
      };
    case "matches_regex": {
      const regex = new RegExp(step.value ?? "", caseSensitive ? "" : "i");
      return {
        passed: regex.test(sourceText),
        detail: `matches /${step.value ?? ""}/${caseSensitive ? "" : "i"}`,
      };
    }
  }
}

function buildCompletionMessage(workflow: StoredWorkflowRecord): string {
  const header = `Workflow "${workflow.definition.label}" ${workflow.status}.`;
  const body =
    trimText(workflow.resultSummary) ??
    workflow.steps
      .map((step) => {
        const output = trimText(step.outputSummary) ?? trimText(step.lastError);
        if (!output) {
          return undefined;
        }
        return `${step.stepId} (${step.status})\n${output}`;
      })
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
  return body ? `${header}\n\n${body}` : header;
}

function resolveReferencedSessionKey(
  workflow: StoredWorkflowRecord,
  step: SessionMessageStep,
): { sessionKey?: string; agentId?: string } {
  const referenced = workflow.steps.find((candidate) => candidate.stepId === step.sessionRef);
  return {
    sessionKey: referenced?.targetSessionKey,
    agentId: referenced?.targetAgentId,
  };
}

function areDependenciesComplete(workflow: StoredWorkflowRecord, step: WorkflowStep) {
  return (step.dependsOn ?? []).every((dep) => {
    const status = workflow.steps.find((candidate) => candidate.stepId === dep)?.status;
    return status === "completed";
  });
}

function hasBlockingFailure(workflow: StoredWorkflowRecord) {
  return workflow.steps.some((step) => step.status === "failed" || step.status === "timed_out");
}

function isWorkflowDone(workflow: StoredWorkflowRecord) {
  return workflow.steps.every((step) =>
    ["completed", "failed", "cancelled", "skipped", "timed_out"].includes(step.status),
  );
}

function isRetriableStep(
  step: WorkflowStep,
): step is AgentRunStep | SessionMessageStep | ToolCallStep {
  return step.kind === "agent_run" || step.kind === "session_message" || step.kind === "tool_call";
}

export class OrchestratorRuntime {
  private timer: NodeJS.Timeout | undefined;
  private tickInFlight = false;

  constructor(
    private readonly store: OrchestratorStore,
    private readonly config: OrchestratorConfig,
    private readonly logger: PluginLogger,
    private readonly memory?: OrchestratorMemoryIntegration,
  ) {}

  async submitWorkflow(input: {
    workflow: WorkflowDefinition;
    requesterAgentId?: string;
    requesterSessionKey?: string;
    startAt?: string;
  }) {
    const validation = validateWorkflowDefinition(
      input.workflow,
      this.config,
      input.requesterAgentId,
    );
    if (!validation.ok) {
      throw new Error(`Invalid workflow: ${validation.errors.join("; ")}`);
    }
    const normalizedWorkflow = validation.normalizedWorkflow ?? input.workflow;
    const workflowId = randomUUID();
    const record = await this.store.createWorkflow({
      workflowId,
      definition: normalizedWorkflow,
      requesterAgentId: input.requesterAgentId,
      requesterSessionKey: input.requesterSessionKey,
      startAt: input.startAt,
    });
    const enriched = await this.attachPlanningMemories(record);
    this.logger.info(`orchestrator: accepted workflow ${workflowId} (${normalizedWorkflow.label})`);
    return {
      workflowId,
      status: enriched.status,
      warnings: validation.warnings,
      stepCount: enriched.steps.length,
      planningMemoryCount: enriched.planningMemories?.length ?? 0,
    };
  }

  async validateWorkflow(workflow: WorkflowDefinition, requesterAgentId?: string) {
    return validateWorkflowDefinition(workflow, this.config, requesterAgentId);
  }

  async getWorkflowStatus(workflowId: string, includeSteps = false) {
    const workflow = await this.store.getWorkflow(workflowId);
    if (!workflow) {
      return null;
    }
    return {
      workflowId: workflow.workflowId,
      label: workflow.definition.label,
      status: workflow.status,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      startedAt: workflow.startedAt,
      completedAt: workflow.completedAt,
      startAt: workflow.startAt,
      resultSummary: workflow.resultSummary,
      cancelReason: workflow.cancelReason,
      stepSummary: toStepStatusSummary(workflow),
      steps: includeSteps ? workflow.steps : undefined,
    };
  }

  async listWorkflows(params?: { status?: StoredWorkflowRecord["status"]; limit?: number }) {
    const workflows = await this.store.listWorkflows(params);
    return workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      label: workflow.definition.label,
      status: workflow.status,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      stepSummary: toStepStatusSummary(workflow),
    }));
  }

  async cancelWorkflow(workflowId: string, reason?: string) {
    const updated = await this.store.setWorkflowStatus(workflowId, "cancelling", {
      cancelReason: reason?.trim() || "cancel requested",
    });
    return updated
      ? { workflowId, status: updated.status, cancelReason: updated.cancelReason }
      : null;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.logger.info("orchestrator: service started");
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.logger.info("orchestrator: service stopped");
  }

  private async tick() {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      const workflows = await this.store.listWorkflows({ limit: 200 });
      await this.cleanupCompletedWorkflows(workflows);
      let runningWorkflows = workflows.filter((workflow) => workflow.status === "running").length;
      for (const workflow of workflows) {
        if (
          workflow.status === "pending" &&
          runningWorkflows >= this.config.maxConcurrentWorkflows
        ) {
          continue;
        }
        const beforeStatus = workflow.status;
        await this.processWorkflow(workflow);
        const updated = await this.store.getWorkflow(workflow.workflowId);
        if (beforeStatus !== "running" && updated?.status === "running") {
          runningWorkflows += 1;
        }
        if (
          beforeStatus === "running" &&
          updated &&
          ["completed", "failed", "cancelled"].includes(updated.status)
        ) {
          runningWorkflows = Math.max(0, runningWorkflows - 1);
        }
      }
    } catch (err) {
      this.logger.warn(`orchestrator: tick failed: ${String(err)}`);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async processWorkflow(workflow: StoredWorkflowRecord) {
    if (
      workflow.status === "completed" ||
      workflow.status === "failed" ||
      workflow.status === "cancelled"
    ) {
      await this.maybePersistTerminalMemory(workflow);
      await this.maybeNotifyRequester(workflow);
      return;
    }

    if (workflow.status === "cancelling") {
      const hasRunning = workflow.steps.some((step) => step.status === "running");
      if (!hasRunning) {
        await this.store.setWorkflowStatus(workflow.workflowId, "cancelled", {
          completedAt: nowIso(),
          resultSummary: workflow.cancelReason || "Workflow cancelled",
          terminalMemoryState: "skipped",
          completionNoticeState: workflow.requesterSessionKey ? "pending" : "skipped",
        });
      }
      return;
    }

    const startAtMs = parseIso(workflow.startAt);
    if (startAtMs && startAtMs > Date.now()) {
      return;
    }

    await this.pollRunningSteps(workflow);
    const refreshed = await this.store.getWorkflow(workflow.workflowId);
    if (!refreshed) {
      return;
    }

    if (hasBlockingFailure(refreshed)) {
      await this.store.setWorkflowStatus(refreshed.workflowId, "failed", {
        completedAt: nowIso(),
        resultSummary: refreshed.steps
          .filter((step) => step.status === "failed" || step.status === "timed_out")
          .map((step) =>
            `${step.stepId} (${step.status})\n${step.lastError ?? step.outputSummary ?? ""}`.trim(),
          )
          .join("\n\n"),
        terminalMemoryState: this.memory ? "pending" : "skipped",
        terminalMemoryKind: "failed",
        completionNoticeState: refreshed.requesterSessionKey ? "pending" : "skipped",
      });
      return;
    }

    if (isWorkflowDone(refreshed)) {
      await this.store.setWorkflowStatus(refreshed.workflowId, "completed", {
        completedAt: nowIso(),
        resultSummary: refreshed.steps
          .map((step) => step.outputSummary)
          .filter((value): value is string => Boolean(value))
          .join("\n\n"),
        terminalMemoryState: this.memory ? "pending" : "skipped",
        terminalMemoryKind: "completed",
        completionNoticeState: refreshed.requesterSessionKey ? "pending" : "skipped",
      });
      return;
    }

    const runningCount = refreshed.steps.filter((step) => step.status === "running").length;
    const availableSlots = Math.max(0, this.config.maxConcurrentSteps - runningCount);
    if (availableSlots === 0) {
      return;
    }

    const readySteps = refreshed.definition.steps.filter((step) => {
      const record = refreshed.steps.find((candidate) => candidate.stepId === step.id);
      if (!record || record.status !== "pending") {
        return false;
      }
      return areDependenciesComplete(refreshed, step);
    });

    for (const step of readySteps.slice(0, availableSlots)) {
      await this.dispatchStep(refreshed.workflowId, step);
    }

    if (refreshed.status === "pending" && readySteps.length > 0) {
      await this.store.setWorkflowStatus(refreshed.workflowId, "running", {
        startedAt: refreshed.startedAt ?? nowIso(),
      });
    }
  }

  private async pollRunningSteps(workflow: StoredWorkflowRecord) {
    for (const stepRecord of workflow.steps.filter((step) => step.status === "running")) {
      const definition = workflow.definition.steps.find((step) => step.id === stepRecord.stepId);
      if (!definition) {
        continue;
      }
      if (definition.kind === "wait") {
        const waitUntilMs = parseIso(stepRecord.outputSummary);
        if (waitUntilMs && Date.now() >= waitUntilMs) {
          await this.store.updateStep(workflow.workflowId, stepRecord.stepId, (step) => ({
            ...step,
            status: "completed",
            completedAt: nowIso(),
            outputSummary: `Waited ${definition.delaySeconds}s`,
          }));
        }
        continue;
      }
      if (!stepRecord.outputSummary) {
        continue;
      }
      const waitRes = await callGateway<{
        status?: string;
        endedAt?: number;
        error?: string;
      }>({
        method: "agent.wait",
        params: {
          runId: stepRecord.outputSummary,
          timeoutMs: 1,
        },
        timeoutMs: 5000,
      });
      if (waitRes?.status === "timeout" && waitRes.endedAt == null) {
        continue;
      }
      if (waitRes?.status === "ok") {
        const text = stepRecord.targetSessionKey
          ? await readLatestAssistantReply({ sessionKey: stepRecord.targetSessionKey })
          : undefined;
        await this.store.updateStep(workflow.workflowId, stepRecord.stepId, (step) => ({
          ...step,
          status: "completed",
          completedAt: nowIso(),
          outputSummary: text || "(completed with no assistant text)",
        }));
        continue;
      }
      if (waitRes?.status === "timeout" && waitRes.endedAt != null) {
        await this.failStep(workflow.workflowId, definition, stepRecord, "Agent run timed out");
        continue;
      }
      await this.failStep(
        workflow.workflowId,
        definition,
        stepRecord,
        waitRes?.error || "agent.wait failed",
      );
    }
  }

  private async dispatchStep(workflowId: string, step: WorkflowStep) {
    if (step.kind === "wait") {
      const waitUntil = new Date(Date.now() + step.delaySeconds * 1000).toISOString();
      await this.store.updateStep(workflowId, step.id, (record) => ({
        ...record,
        status: "running",
        attempt: record.attempt + 1,
        startedAt: nowIso(),
        outputSummary: waitUntil,
      }));
      return;
    }

    if (step.kind === "condition") {
      const workflow = await this.store.getWorkflow(workflowId);
      if (!workflow) {
        return;
      }
      const sourceText = buildConditionSourceText(workflow, step);
      const result = evaluateCondition(sourceText, step);
      await this.store.updateStep(workflowId, step.id, (record) => ({
        ...record,
        status: result.passed
          ? "completed"
          : step.onFalse === "fail_workflow"
            ? "failed"
            : "completed",
        attempt: record.attempt + 1,
        startedAt: record.startedAt ?? nowIso(),
        completedAt: nowIso(),
        outputSummary: `Condition ${result.passed ? "passed" : "failed"}: ${result.detail}`,
        lastError:
          result.passed || step.onFalse !== "fail_workflow"
            ? undefined
            : `Condition failed: ${result.detail}`,
      }));
      if (!result.passed && step.onFalse !== "fail_workflow") {
        await this.skipDependentBranch(
          workflow,
          step.id,
          `Skipped because condition ${step.id} evaluated false`,
        );
      }
      return;
    }

    try {
      if (step.kind === "agent_run" || step.kind === "tool_call") {
        const workflow = await this.store.getWorkflow(workflowId);
        if (!workflow) {
          return;
        }
        const runId = randomUUID();
        const sessionKey = buildWorkflowSessionKey(step, workflowId);
        await this.store.updateStep(workflowId, step.id, (record) => ({
          ...record,
          status: "running",
          attempt: record.attempt + 1,
          startedAt: nowIso(),
          targetAgentId: step.agentId,
          targetSessionKey: sessionKey,
          outputSummary: runId,
        }));
        const response = await callGateway<{ runId?: string }>({
          method: "agent",
          params: {
            agentId: step.agentId,
            sessionKey,
            message: buildStepMessage(workflow, step),
            deliver: false,
            label: step.label,
            thinking: "thinking" in step ? step.thinking : undefined,
            idempotencyKey: runId,
            extraSystemPrompt:
              step.kind === "tool_call" ? buildToolCallSystemPrompt(step) : undefined,
            timeout: step.runTimeoutSeconds ?? this.config.defaultRunTimeoutSeconds,
          },
          timeoutMs: 10_000,
        });
        const actualRunId =
          typeof response?.runId === "string" && response.runId ? response.runId : runId;
        await this.store.updateStep(workflowId, step.id, (record) => ({
          ...record,
          outputSummary: actualRunId,
        }));
        return;
      }

      const workflow = await this.store.getWorkflow(workflowId);
      if (!workflow) {
        return;
      }
      const resolved = resolveReferencedSessionKey(workflow, step);
      if (!resolved.sessionKey) {
        throw new Error(`sessionRef ${step.sessionRef} did not resolve to a target session`);
      }
      const runId = randomUUID();
      await this.store.updateStep(workflowId, step.id, (record) => ({
        ...record,
        status: "running",
        attempt: record.attempt + 1,
        startedAt: nowIso(),
        targetAgentId: resolved.agentId,
        targetSessionKey: resolved.sessionKey,
        outputSummary: runId,
      }));
      const response = await callGateway<{ runId?: string }>({
        method: "agent",
        params: {
          sessionKey: resolved.sessionKey,
          message: buildStepMessage(workflow, step),
          deliver: false,
          idempotencyKey: runId,
        },
        timeoutMs: 10_000,
      });
      const actualRunId =
        typeof response?.runId === "string" && response.runId ? response.runId : runId;
      await this.store.updateStep(workflowId, step.id, (record) => ({
        ...record,
        outputSummary: actualRunId,
      }));
    } catch (err) {
      const current = (await this.store.getWorkflow(workflowId))?.steps.find(
        (candidate) => candidate.stepId === step.id,
      );
      await this.failStep(
        workflowId,
        step,
        current ?? {
          workflowId,
          stepId: step.id,
          status: "pending",
          attempt: 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        String(err),
      );
    }
  }

  private async failStep(
    workflowId: string,
    definition: WorkflowStep,
    record: WorkflowStepRecord,
    error: string,
  ) {
    const maxAttempts = isRetriableStep(definition)
      ? (definition.retry?.maxAttempts ?? this.config.defaultRetryLimit + 1)
      : 1;
    if (record.attempt < maxAttempts) {
      await this.store.updateStep(workflowId, record.stepId, (step) => ({
        ...step,
        status: "pending",
        lastError: error,
        outputSummary: undefined,
        startedAt: undefined,
        targetAgentId: undefined,
        targetSessionKey: undefined,
        completedAt: undefined,
      }));
      return;
    }
    await this.store.updateStep(workflowId, record.stepId, (step) => ({
      ...step,
      status: "failed",
      completedAt: nowIso(),
      lastError: error,
    }));
  }

  private async cleanupCompletedWorkflows(workflows: StoredWorkflowRecord[]) {
    const cutoffMs = Date.now() - this.config.cleanupCompletedAfterHours * 60 * 60 * 1000;
    for (const workflow of workflows) {
      if (!["completed", "failed", "cancelled"].includes(workflow.status)) {
        continue;
      }
      const completedAtMs = parseIso(workflow.completedAt);
      if (!completedAtMs || completedAtMs > cutoffMs) {
        continue;
      }
      await this.store.deleteWorkflow(workflow.workflowId);
    }
  }

  private async maybeNotifyRequester(workflow: StoredWorkflowRecord) {
    if (!workflow.requesterSessionKey) {
      if (workflow.completionNoticeState !== "skipped") {
        await this.store.updateWorkflow(workflow.workflowId, (record) => ({
          ...record,
          completionNoticeState: "skipped",
        }));
      }
      return;
    }
    if (workflow.completionNoticeState === "sent" || workflow.completionNoticeState === "skipped") {
      return;
    }
    try {
      const target = await resolveAnnounceTarget({
        sessionKey: workflow.requesterSessionKey,
        displayKey: workflow.requesterSessionKey,
      });
      if (!target) {
        await this.store.updateWorkflow(workflow.workflowId, (record) => ({
          ...record,
          completionNoticeState: "skipped",
          completionNoticeError: "announce target unavailable",
        }));
        return;
      }
      await callGateway({
        method: "send",
        params: {
          to: target.to,
          channel: target.channel,
          accountId: target.accountId,
          message: buildCompletionMessage(workflow),
          idempotencyKey: randomUUID(),
        },
        timeoutMs: 10_000,
      });
      await this.store.updateWorkflow(workflow.workflowId, (record) => ({
        ...record,
        completionNoticeState: "sent",
        completionNoticeSentAt: nowIso(),
        completionNoticeError: undefined,
      }));
    } catch (err) {
      await this.store.updateWorkflow(workflow.workflowId, (record) => ({
        ...record,
        completionNoticeState: "pending",
        completionNoticeError: String(err),
      }));
      this.logger.warn(
        `orchestrator: completion notify failed for ${workflow.workflowId}: ${String(err)}`,
      );
    }
  }

  private async skipDependentBranch(
    workflow: StoredWorkflowRecord,
    stepId: string,
    reason: string,
    visited = new Set<string>(),
  ) {
    if (visited.has(stepId)) {
      return;
    }
    visited.add(stepId);
    const descendants = workflow.definition.steps.filter((candidate) =>
      candidate.dependsOn?.includes(stepId),
    );
    for (const descendant of descendants) {
      const current = workflow.steps.find((candidate) => candidate.stepId === descendant.id);
      if (!current || current.status !== "pending") {
        await this.skipDependentBranch(workflow, descendant.id, reason, visited);
        continue;
      }
      await this.store.updateStep(workflow.workflowId, descendant.id, (record) => ({
        ...record,
        status: "skipped",
        completedAt: nowIso(),
        lastError: reason,
      }));
      await this.skipDependentBranch(workflow, descendant.id, reason, visited);
    }
  }

  private async attachPlanningMemories(
    workflow: StoredWorkflowRecord,
  ): Promise<StoredWorkflowRecord> {
    if (!this.memory) {
      return workflow;
    }
    try {
      const planning = await this.memory.getPlanningContext({
        requesterAgentId: workflow.requesterAgentId,
        ownerAgentId: workflow.definition.ownerAgentId,
        query: derivePlanningQueryFromWorkflow(workflow),
      });
      if (!planning || planning.memories.length === 0) {
        return workflow;
      }
      return (
        (await this.store.updateWorkflow(workflow.workflowId, (record) => ({
          ...record,
          planningMemories: planning.memories.map((memory) => ({
            id: memory.id,
            text: memory.text,
            score: memory.score,
          })),
        }))) ?? workflow
      );
    } catch (err) {
      this.logger.warn(
        `orchestrator: planning memory lookup failed for ${workflow.workflowId}: ${String(err)}`,
      );
      return workflow;
    }
  }

  private async maybePersistTerminalMemory(workflow: StoredWorkflowRecord) {
    if (!this.memory) {
      if (workflow.terminalMemoryState !== "skipped") {
        await this.store.updateWorkflow(workflow.workflowId, (record) => ({
          ...record,
          terminalMemoryState: "skipped",
        }));
      }
      return;
    }
    if (workflow.terminalMemoryState === "written" || workflow.terminalMemoryState === "skipped") {
      return;
    }
    try {
      const writtenText =
        workflow.status === "completed"
          ? await this.memory.writeWorkflowCompletionMemory(workflow)
          : workflow.status === "failed"
            ? await this.memory.writeWorkflowFailureMemory(workflow)
            : null;
      await this.store.updateWorkflow(workflow.workflowId, (record) => ({
        ...record,
        terminalMemoryState: writtenText ? "written" : "skipped",
        terminalMemoryText: writtenText ?? undefined,
        terminalMemoryError: undefined,
      }));
    } catch (err) {
      await this.store.updateWorkflow(workflow.workflowId, (record) => ({
        ...record,
        terminalMemoryState: "pending",
        terminalMemoryError: String(err),
      }));
      this.logger.warn(
        `orchestrator: terminal memory sync failed for ${workflow.workflowId}: ${String(err)}`,
      );
    }
  }
}
