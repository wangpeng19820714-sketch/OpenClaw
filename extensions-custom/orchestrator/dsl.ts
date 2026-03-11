import type {
  AgentMessageStep,
  AgentRunStep,
  FanOutBranch,
  FanOutStep,
  ToolCallStep,
  WorkflowDefinition,
  WorkflowStep,
} from "./workflow-schema.js";

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  return [...new Set(values)];
}

function buildFanOutBranchStepId(stepId: string, branchId: string): string {
  return `${stepId}.${branchId}`;
}

function expandDependsOn(dependsOn: string[] | undefined, aliases: Map<string, string[]>) {
  const expanded = (dependsOn ?? []).flatMap(
    (dependencyId) => aliases.get(dependencyId) ?? [dependencyId],
  );
  return uniqueStrings(expanded);
}

function expandFanOutBranch(
  fanOutStep: FanOutStep,
  branch: FanOutBranch,
  dependsOn: string[] | undefined,
): AgentRunStep | ToolCallStep {
  const metadata = {
    ...branch.metadata,
    fanOutStepId: fanOutStep.id,
    fanOutBranchId: branch.id,
  };
  const id = buildFanOutBranchStepId(fanOutStep.id, branch.id);
  if (branch.kind === "agent_run") {
    return {
      id,
      kind: "agent_run",
      agentId: branch.agentId,
      task: branch.task,
      dependsOn,
      label: branch.label,
      thinking: branch.thinking,
      runTimeoutSeconds: branch.runTimeoutSeconds,
      retry: branch.retry,
      metadata,
    };
  }
  return {
    id,
    kind: "tool_call",
    agentId: branch.agentId,
    toolName: branch.toolName,
    arguments: branch.arguments,
    task: branch.task,
    dependsOn,
    label: branch.label,
    thinking: branch.thinking,
    runTimeoutSeconds: branch.runTimeoutSeconds,
    retry: branch.retry,
    metadata,
  };
}

function expandAgentMessageStep(
  step: AgentMessageStep,
  aliases: Map<string, string[]>,
): WorkflowStep {
  const resolvedTarget = aliases.get(step.targetStepId) ?? [step.targetStepId];
  if (resolvedTarget.length !== 1) {
    throw new Error(
      `Step ${step.id} targetStepId ${step.targetStepId} must resolve to exactly one session-producing step`,
    );
  }
  const dependsOn = expandDependsOn(
    uniqueStrings([...(step.dependsOn ?? []), step.targetStepId]),
    aliases,
  );
  return {
    id: step.id,
    kind: "session_message",
    sessionRef: resolvedTarget[0],
    task: step.task,
    dependsOn,
    retry: step.retry,
    metadata: step.metadata,
  };
}

export function expandWorkflowDefinition(workflow: WorkflowDefinition): {
  workflow: WorkflowDefinition;
  warnings: string[];
} {
  const aliases = new Map<string, string[]>();
  const expandedSteps: WorkflowStep[] = [];
  const warnings: string[] = [];

  for (const step of workflow.steps) {
    if (step.kind === "fan_out") {
      const dependsOn = expandDependsOn(step.dependsOn, aliases);
      const branchStepIds: string[] = [];
      for (const branch of step.branches) {
        const branchStep = expandFanOutBranch(step, branch, dependsOn);
        if (aliases.has(branchStep.id)) {
          throw new Error(`Expanded branch step id already exists: ${branchStep.id}`);
        }
        expandedSteps.push(branchStep);
        aliases.set(branchStep.id, [branchStep.id]);
        branchStepIds.push(branchStep.id);
      }
      aliases.set(step.id, branchStepIds);
      warnings.push(`fan_out step ${step.id} expands to branches: ${branchStepIds.join(", ")}`);
      continue;
    }

    if (step.kind === "agent_message") {
      const expanded = expandAgentMessageStep(step, aliases);
      expandedSteps.push(expanded);
      aliases.set(step.id, [step.id]);
      continue;
    }

    const expanded: WorkflowStep = {
      ...step,
      dependsOn: expandDependsOn(step.dependsOn, aliases),
    };
    expandedSteps.push(expanded);
    aliases.set(step.id, [step.id]);
  }

  return {
    workflow: {
      ...workflow,
      steps: expandedSteps,
    },
    warnings,
  };
}
