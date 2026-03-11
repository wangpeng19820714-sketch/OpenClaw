import { Type } from "@sinclair/typebox";

export const WORKFLOW_STEP_KINDS = [
  "agent_run",
  "session_message",
  "agent_message",
  "wait",
  "tool_call",
  "condition",
  "fan_out",
] as const;

export const FAN_OUT_BRANCH_KINDS = ["agent_run", "tool_call"] as const;

export const CONDITION_OPERATORS = [
  "contains",
  "not_contains",
  "equals",
  "matches_regex",
  "exists",
] as const;

export const CONDITION_SOURCES = ["dependencies_output", "latest_dependency_output"] as const;
export const CONDITION_FALSE_ACTIONS = ["skip_dependents", "fail_workflow"] as const;

export const WorkflowPrioritySchema = Type.Unsafe<"low" | "normal" | "high">({
  type: "string",
  enum: ["low", "normal", "high"],
});

export const WorkflowStatusSchema = Type.Unsafe<
  "pending" | "running" | "completed" | "failed" | "cancelling" | "cancelled" | "timed_out"
>({
  type: "string",
  enum: ["pending", "running", "completed", "failed", "cancelling", "cancelled", "timed_out"],
});

export const StepStatusSchema = Type.Unsafe<
  "pending" | "ready" | "running" | "completed" | "failed" | "skipped" | "cancelled" | "timed_out"
>({
  type: "string",
  enum: ["pending", "ready", "running", "completed", "failed", "skipped", "cancelled", "timed_out"],
});

export const RetryPolicySchema = Type.Object({
  maxAttempts: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
  backoffSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3600 })),
});

export const WorkflowStepKindSchema = Type.Unsafe<WorkflowStepKind>({
  type: "string",
  enum: [...WORKFLOW_STEP_KINDS],
});

export const ConditionOperatorSchema = Type.Unsafe<ConditionOperator>({
  type: "string",
  enum: [...CONDITION_OPERATORS],
});

export const ConditionSourceSchema = Type.Unsafe<ConditionSource>({
  type: "string",
  enum: [...CONDITION_SOURCES],
});

export const ConditionFalseActionSchema = Type.Unsafe<ConditionFalseAction>({
  type: "string",
  enum: [...CONDITION_FALSE_ACTIONS],
});

export const WorkflowStepSchema = Type.Object({
  id: Type.String(),
  kind: WorkflowStepKindSchema,
  agentId: Type.Optional(Type.String()),
  sessionRef: Type.Optional(Type.String()),
  targetStepId: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  delaySeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 604800 })),
  toolName: Type.Optional(Type.String()),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  branches: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        kind: Type.Unsafe<FanOutBranchKind>({
          type: "string",
          enum: [...FAN_OUT_BRANCH_KINDS],
        }),
        agentId: Type.Optional(Type.String()),
        task: Type.Optional(Type.String()),
        toolName: Type.Optional(Type.String()),
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        label: Type.Optional(Type.String()),
        thinking: Type.Optional(Type.String()),
        runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })),
        retry: Type.Optional(RetryPolicySchema),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      { minItems: 1 },
    ),
  ),
  source: Type.Optional(ConditionSourceSchema),
  operator: Type.Optional(ConditionOperatorSchema),
  value: Type.Optional(Type.String()),
  caseSensitive: Type.Optional(Type.Boolean()),
  onFalse: Type.Optional(ConditionFalseActionSchema),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  label: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })),
  retry: Type.Optional(RetryPolicySchema),
  thread: Type.Optional(Type.Boolean()),
  mode: Type.Optional(
    Type.Unsafe<"run" | "session">({
      type: "string",
      enum: ["run", "session"],
    }),
  ),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const WorkflowDefinitionSchema = Type.Object({
  version: Type.Literal(1),
  label: Type.String(),
  ownerAgentId: Type.Optional(Type.String()),
  priority: Type.Optional(WorkflowPrioritySchema),
  dedupeKey: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  steps: Type.Array(WorkflowStepSchema, { minItems: 1 }),
});

export const WorkflowSubmitParamsSchema = Type.Object({
  workflow: WorkflowDefinitionSchema,
  startAt: Type.Optional(Type.String()),
});

export const WorkflowStatusParamsSchema = Type.Object({
  workflowId: Type.String(),
  includeSteps: Type.Optional(Type.Boolean()),
});

export const WorkflowCancelParamsSchema = Type.Object({
  workflowId: Type.String(),
  reason: Type.Optional(Type.String()),
});

export const WorkflowListParamsSchema = Type.Object({
  status: Type.Optional(WorkflowStatusSchema),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
});

export const WorkflowMemoryContextParamsSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  agentId: Type.Optional(Type.String()),
});

export type WorkflowPriority = "low" | "normal" | "high";
export type WorkflowStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "timed_out";
export type StepStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "timed_out";

export type RetryPolicy = {
  maxAttempts?: number;
  backoffSeconds?: number;
};

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];
export type FanOutBranchKind = (typeof FAN_OUT_BRANCH_KINDS)[number];
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export type ConditionSource = (typeof CONDITION_SOURCES)[number];
export type ConditionFalseAction = (typeof CONDITION_FALSE_ACTIONS)[number];

export type AgentRunStep = {
  id: string;
  kind: "agent_run";
  agentId: string;
  task: string;
  dependsOn?: string[];
  label?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  retry?: RetryPolicy;
  thread?: boolean;
  mode?: "run" | "session";
  metadata?: Record<string, unknown>;
};

export type SessionMessageStep = {
  id: string;
  kind: "session_message";
  sessionRef: string;
  task: string;
  dependsOn?: string[];
  retry?: RetryPolicy;
  metadata?: Record<string, unknown>;
};

export type AgentMessageStep = {
  id: string;
  kind: "agent_message";
  targetStepId: string;
  task: string;
  dependsOn?: string[];
  retry?: RetryPolicy;
  metadata?: Record<string, unknown>;
};

export type WaitStep = {
  id: string;
  kind: "wait";
  delaySeconds: number;
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
};

export type ToolCallStep = {
  id: string;
  kind: "tool_call";
  agentId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  task?: string;
  dependsOn?: string[];
  label?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  retry?: RetryPolicy;
  metadata?: Record<string, unknown>;
};

export type FanOutBranch =
  | {
      id: string;
      kind: "agent_run";
      agentId: string;
      task: string;
      label?: string;
      thinking?: string;
      runTimeoutSeconds?: number;
      retry?: RetryPolicy;
      metadata?: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "tool_call";
      agentId: string;
      toolName: string;
      arguments?: Record<string, unknown>;
      task?: string;
      label?: string;
      thinking?: string;
      runTimeoutSeconds?: number;
      retry?: RetryPolicy;
      metadata?: Record<string, unknown>;
    };

export type FanOutStep = {
  id: string;
  kind: "fan_out";
  branches: FanOutBranch[];
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
};

export type ConditionStep = {
  id: string;
  kind: "condition";
  dependsOn?: string[];
  source?: ConditionSource;
  operator: ConditionOperator;
  value?: string;
  caseSensitive?: boolean;
  onFalse?: ConditionFalseAction;
  metadata?: Record<string, unknown>;
};

export type WorkflowStep =
  | AgentRunStep
  | SessionMessageStep
  | AgentMessageStep
  | WaitStep
  | ToolCallStep
  | ConditionStep
  | FanOutStep;

export type WorkflowDefinition = {
  version: 1;
  label: string;
  ownerAgentId?: string;
  priority?: WorkflowPriority;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
  steps: WorkflowStep[];
};

export type WorkflowRecord = {
  workflowId: string;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  requesterAgentId?: string;
  requesterSessionKey?: string;
};

export type WorkflowStepRecord = {
  workflowId: string;
  stepId: string;
  status: StepStatus;
  attempt: number;
  targetAgentId?: string;
  targetSessionKey?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  outputSummary?: string;
};

export type WorkflowSubmitParams = {
  workflow: WorkflowDefinition;
  startAt?: string;
};

export type WorkflowStatusParams = {
  workflowId: string;
  includeSteps?: boolean;
};

export type WorkflowCancelParams = {
  workflowId: string;
  reason?: string;
};

export type WorkflowListParams = {
  status?: WorkflowStatus;
  limit?: number;
};

export type WorkflowMemoryContextParams = {
  query: string;
  limit?: number;
  agentId?: string;
};
