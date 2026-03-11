import type { OrchestratorConfig } from "./config.js";
import { expandWorkflowDefinition } from "./dsl.js";
import type {
  FanOutBranch,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
} from "./workflow-schema.js";

export type WorkflowValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  normalizedWorkflow?: WorkflowDefinition;
};

function ensureUniqueStepIds(steps: WorkflowStep[], errors: string[]) {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      errors.push(`Duplicate step id: ${step.id}`);
      continue;
    }
    seen.add(step.id);
  }
}

function ensureDependsOnExists(steps: WorkflowStep[], errors: string[]) {
  const known = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!known.has(dep)) {
        errors.push(`Step ${step.id} depends on unknown step ${dep}`);
      }
      if (dep === step.id) {
        errors.push(`Step ${step.id} cannot depend on itself`);
      }
    }
  }
}

function detectCycles(steps: WorkflowStep[], errors: string[]) {
  const map = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (stepId: string) => {
    if (visited.has(stepId)) {
      return;
    }
    if (visiting.has(stepId)) {
      errors.push(`Cycle detected at step ${stepId}`);
      return;
    }
    visiting.add(stepId);
    for (const dep of map.get(stepId)?.dependsOn ?? []) {
      visit(dep);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };

  for (const step of steps) {
    visit(step.id);
  }
}

function validateTargetAgent(
  stepId: string,
  agentId: string | undefined,
  cfg: OrchestratorConfig,
  errors: string[],
  requesterAgentId?: string,
) {
  if (!agentId?.trim()) {
    errors.push(`Step ${stepId} is missing agentId`);
    return;
  }
  if (cfg.allowedTargetAgents && !cfg.allowedTargetAgents.includes(agentId)) {
    errors.push(`Step ${stepId} targets disallowed agent ${agentId}`);
  }
  const submitterPolicy = requesterAgentId ? cfg.submitterPolicies?.[requesterAgentId] : undefined;
  if (
    submitterPolicy?.allowedTargetAgents &&
    !submitterPolicy.allowedTargetAgents.includes(agentId)
  ) {
    errors.push(
      `Step ${stepId} targets agent ${agentId}, which ${requesterAgentId} cannot dispatch`,
    );
  }
}

function validateFanOutBranch(
  stepId: string,
  branch: FanOutBranch,
  cfg: OrchestratorConfig,
  errors: string[],
  requesterAgentId?: string,
) {
  const branchStepId = `${stepId}.${branch.id}`;
  validateTargetAgent(branchStepId, branch.agentId, cfg, errors, requesterAgentId);
  if (branch.kind === "agent_run") {
    if (!branch.task?.trim()) {
      errors.push(`Step ${branchStepId} is fan_out agent_run but missing task`);
    }
    return;
  }
  if (!branch.toolName?.trim()) {
    errors.push(`Step ${branchStepId} is fan_out tool_call but missing toolName`);
  }
}

function validateStepShape(
  step: WorkflowStep,
  cfg: OrchestratorConfig,
  errors: string[],
  requesterAgentId?: string,
) {
  if (step.kind === "agent_run") {
    validateTargetAgent(step.id, step.agentId, cfg, errors, requesterAgentId);
    if (!step.task?.trim()) {
      errors.push(`Step ${step.id} is agent_run but missing task`);
    }
    return;
  }
  if (step.kind === "session_message") {
    if (!step.sessionRef?.trim()) {
      errors.push(`Step ${step.id} is session_message but missing sessionRef`);
    }
    if (!step.task?.trim()) {
      errors.push(`Step ${step.id} is session_message but missing task`);
    }
    return;
  }
  if (step.kind === "agent_message") {
    if (!step.targetStepId?.trim()) {
      errors.push(`Step ${step.id} is agent_message but missing targetStepId`);
    }
    if (!step.task?.trim()) {
      errors.push(`Step ${step.id} is agent_message but missing task`);
    }
    return;
  }
  if (step.kind === "wait") {
    if (typeof step.delaySeconds !== "number" || step.delaySeconds < 0) {
      errors.push(`Step ${step.id} is wait but missing delaySeconds`);
    }
    return;
  }
  if (step.kind === "tool_call") {
    validateTargetAgent(step.id, step.agentId, cfg, errors, requesterAgentId);
    if (!step.toolName?.trim()) {
      errors.push(`Step ${step.id} is tool_call but missing toolName`);
    }
    return;
  }
  if (step.kind === "fan_out") {
    if (!step.branches?.length) {
      errors.push(`Step ${step.id} is fan_out but missing branches`);
      return;
    }
    const branchIds = new Set<string>();
    for (const branch of step.branches) {
      if (!branch.id?.trim()) {
        errors.push(`Step ${step.id} fan_out branch is missing id`);
      } else if (branchIds.has(branch.id)) {
        errors.push(`Step ${step.id} fan_out has duplicate branch id ${branch.id}`);
      } else {
        branchIds.add(branch.id);
      }
      validateFanOutBranch(step.id, branch, cfg, errors, requesterAgentId);
    }
    return;
  }
  if (!step.dependsOn?.length) {
    errors.push(`Step ${step.id} is condition but missing dependsOn`);
  }
  if (!step.operator) {
    errors.push(`Step ${step.id} is condition but missing operator`);
  }
  if (step.operator !== "exists" && !step.value?.trim()) {
    errors.push(`Step ${step.id} condition operator ${step.operator} requires a value`);
  }
  if (step.operator === "matches_regex" && step.value) {
    try {
      new RegExp(step.value);
    } catch (err) {
      errors.push(`Step ${step.id} has invalid regex: ${String(err)}`);
    }
  }
}

export function validateWorkflowDefinition(
  workflow: WorkflowDefinition,
  cfg: OrchestratorConfig,
  requesterAgentId?: string,
): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requesterAgentId) {
    if (cfg.allowedSubmitterAgents && !cfg.allowedSubmitterAgents.includes(requesterAgentId)) {
      errors.push(`Requester agent ${requesterAgentId} is not allowed to submit workflows`);
    }
    if (cfg.workerOnlyAgents?.includes(requesterAgentId)) {
      errors.push(`Requester agent ${requesterAgentId} is worker-only and cannot submit workflows`);
    }
  }

  if (workflow.version !== 1) {
    errors.push(`Unsupported workflow version: ${String(workflow.version)}`);
  }
  if (!workflow.label.trim()) {
    errors.push("Workflow label is required");
  }
  if (workflow.steps.length === 0) {
    errors.push("Workflow must contain at least one step");
  }

  ensureUniqueStepIds(workflow.steps, errors);
  ensureDependsOnExists(workflow.steps, errors);
  detectCycles(workflow.steps, errors);

  const allowedKinds = new Set<WorkflowStepKind>(cfg.allowedStepKinds ?? []);
  const requesterAllowedKinds = requesterAgentId
    ? new Set<WorkflowStepKind>(cfg.submitterPolicies?.[requesterAgentId]?.allowedStepKinds ?? [])
    : undefined;

  for (const step of workflow.steps) {
    if (allowedKinds.size > 0 && !allowedKinds.has(step.kind)) {
      errors.push(`Step ${step.id} uses disabled step kind ${step.kind}`);
    }
    if (
      requesterAllowedKinds &&
      requesterAllowedKinds.size > 0 &&
      !requesterAllowedKinds.has(step.kind)
    ) {
      errors.push(
        `Step ${step.id} uses step kind ${step.kind}, which ${requesterAgentId} is not allowed to submit`,
      );
    }
    if (step.kind === "fan_out") {
      for (const branch of step.branches ?? []) {
        if (allowedKinds.size > 0 && !allowedKinds.has(branch.kind)) {
          errors.push(`Step ${step.id}.${branch.id} uses disabled branch kind ${branch.kind}`);
        }
        if (
          requesterAllowedKinds &&
          requesterAllowedKinds.size > 0 &&
          !requesterAllowedKinds.has(branch.kind)
        ) {
          errors.push(
            `Step ${step.id}.${branch.id} uses branch kind ${branch.kind}, which ${requesterAgentId} is not allowed to submit`,
          );
        }
      }
    }
    validateStepShape(step, cfg, errors, requesterAgentId);
  }

  let normalizedWorkflow: WorkflowDefinition | undefined;
  if (errors.length === 0) {
    try {
      const expanded = expandWorkflowDefinition(workflow);
      normalizedWorkflow = expanded.workflow;
      warnings.push(...expanded.warnings);
      ensureUniqueStepIds(normalizedWorkflow.steps, errors);
      ensureDependsOnExists(normalizedWorkflow.steps, errors);
      detectCycles(normalizedWorkflow.steps, errors);
      for (const step of normalizedWorkflow.steps) {
        validateStepShape(step, cfg, errors, requesterAgentId);
      }
    } catch (err) {
      errors.push(String(err));
    }
  }

  const effectiveStepCount = normalizedWorkflow?.steps.length ?? workflow.steps.length;
  if (effectiveStepCount > cfg.maxConcurrentSteps) {
    warnings.push(
      `Workflow defines ${effectiveStepCount} executable steps, which exceeds maxConcurrentSteps=${cfg.maxConcurrentSteps}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalizedWorkflow,
  };
}
