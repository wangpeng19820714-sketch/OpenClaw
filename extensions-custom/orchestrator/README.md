# Orchestrator v1

This directory contains a minimal runnable v1 of a 24x7 multi-agent orchestrator that runs on top of OpenClaw's built-in session and subagent primitives.

## Goal

Use an `agent-defined workflow, orchestrator-executed` model:

- planner agents define the workflow
- the orchestrator validates, schedules, retries, and tracks it
- worker agents execute the actual steps

This keeps business planning inside agents while moving durability and recovery into infrastructure.

## Why this is not a skill

A skill can teach an agent how to plan or execute work, but it cannot provide:

- a background loop
- durable queueing
- retries
- lease recovery
- concurrency control
- 24x7 execution

The orchestrator therefore needs to be a plugin/service, not just a skill.

## Execution substrate

The runtime should build on OpenClaw's existing internal coordination tools:

- `sessions_spawn`
- `sessions_send`
- `subagents`

That means the orchestrator does not replace OpenClaw's multi-agent system. It wraps it with durable workflow execution.

## v1 scope

v1 keeps the workflow model intentionally small:

- asynchronous workflows only
- explicit DAG-style step dependencies
- lightweight branching via `condition`
- no human approval gates yet
- seven step kinds:
  - `agent_run`
  - `session_message`
  - `agent_message`
  - `wait`
  - `tool_call`
  - `condition`
  - `fan_out`

## Proposed plugin config

Defined in `config.ts` and `openclaw.plugin.json`.

Key fields:

- `pollIntervalMs`
- `leaseTtlMs`
- `maxConcurrentWorkflows`
- `maxConcurrentSteps`
- `defaultRunTimeoutSeconds`
- `defaultRetryLimit`
- `allowedTargetAgents`
- `allowedSubmitterAgents`
- `workerOnlyAgents`
- `allowedStepKinds`
- `submitterPolicies`
- `memory`
- `cleanupCompletedAfterHours`

## Proposed workflow schema

Defined in `workflow-schema.ts`.

Top-level workflow:

```json
{
  "version": 1,
  "label": "Plan and execute a release",
  "ownerAgentId": "ba",
  "priority": "normal",
  "dedupeKey": "release:2026-03-08",
  "steps": [
    {
      "id": "plan",
      "kind": "agent_run",
      "agentId": "pm",
      "task": "Draft the execution plan."
    },
    {
      "id": "implement",
      "kind": "agent_run",
      "agentId": "server",
      "task": "Implement the approved changes.",
      "dependsOn": ["plan"]
    },
    {
      "id": "report",
      "kind": "agent_run",
      "agentId": "ba",
      "task": "Summarize the final result to the requester.",
      "dependsOn": ["implement"]
    }
  ]
}
```

`agent_message` is an ergonomic alias for sending a follow-up back into a previously created
agent session. It resolves `targetStepId` to the earlier step's session and expands to an
internal `session_message` step.

Example explicit round-trip:

```json
{
  "version": 1,
  "label": "PM and BA round trip",
  "steps": [
    {
      "id": "pm_draft",
      "kind": "agent_run",
      "agentId": "pm",
      "task": "Write the draft."
    },
    {
      "id": "ba_review",
      "kind": "agent_run",
      "agentId": "ba",
      "dependsOn": ["pm_draft"],
      "task": "Review the PM draft."
    },
    {
      "id": "pm_followup",
      "kind": "agent_message",
      "targetStepId": "pm_draft",
      "dependsOn": ["ba_review"],
      "task": "Send the BA review back to PM and ask for an updated reply."
    }
  ]
}
```

`fan_out` expands one logical step into multiple parallel branches. Any downstream step that
depends on the `fan_out` step id automatically fans in on all expanded branch ids.

Example fan-out and fan-in:

```json
{
  "version": 1,
  "label": "Parallel analysis then synthesis",
  "steps": [
    {
      "id": "parallel_analysis",
      "kind": "fan_out",
      "branches": [
        {
          "id": "pm_track",
          "kind": "agent_run",
          "agentId": "pm",
          "task": "Analyze the project plan."
        },
        {
          "id": "ba_track",
          "kind": "agent_run",
          "agentId": "ba",
          "task": "Analyze the business constraints."
        }
      ]
    },
    {
      "id": "synthesize",
      "kind": "agent_run",
      "agentId": "server",
      "dependsOn": ["parallel_analysis"],
      "task": "Merge both branch outputs into one final response."
    }
  ]
}
```

## Proposed external tool interface

v1 exposes these tools to planner agents:

- `workflow_memory_context`
- `workflow_submit`
- `workflow_status`
- `workflow_cancel`
- `workflow_list`
- `workflow_validate`

These tools are scaffolded in `index.ts` today and should eventually become the planner-facing contract.

## Proposed internal interfaces

The runtime implementation should split into these pieces:

### `OrchestratorStore`

Responsible for durable workflow state.

Suggested methods:

```ts
type OrchestratorStore = {
  createWorkflow(record: WorkflowRecord, steps: WorkflowStepRecord[]): Promise<void>;
  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>;
  listWorkflows(params: { status?: WorkflowStatus; limit: number }): Promise<WorkflowRecord[]>;
  claimRunnableSteps(params: {
    now: string;
    leaseOwner: string;
    leaseTtlMs: number;
    maxCount: number;
  }): Promise<WorkflowStepRecord[]>;
  markStepRunning(input: {
    workflowId: string;
    stepId: string;
    attempt: number;
    targetSessionKey?: string;
    targetAgentId?: string;
  }): Promise<void>;
  markStepCompleted(input: {
    workflowId: string;
    stepId: string;
    outputSummary?: string;
  }): Promise<void>;
  markStepFailed(input: { workflowId: string; stepId: string; lastError: string }): Promise<void>;
  requestWorkflowCancel(input: { workflowId: string; reason?: string }): Promise<void>;
};
```

### `OrchestratorExecutionAdapter`

Responsible for turning workflow steps into OpenClaw actions.

Suggested methods:

```ts
type OrchestratorExecutionAdapter = {
  spawnAgentRun(step: AgentRunStep): Promise<{
    targetSessionKey: string;
    targetAgentId: string;
  }>;
  sendSessionMessage(step: SessionMessageStep): Promise<void>;
};
```

### `OrchestratorLoop`

Responsible for background execution.

Core responsibilities:

- poll store
- claim runnable steps
- dispatch work
- recover expired leases
- fan in child results
- update workflow and step state

## Result handling

v1 should treat step completion as a state transition, not a chat side effect.

Recommended behavior:

- child agent may still announce in its own normal channel flow
- orchestrator records the structured result separately
- workflow completion produces one final synthesized result for the requester

## Recommended next implementation order

1. add a JSON-backed `OrchestratorStore`
2. add `workflow_validate`
3. add `workflow_submit`
4. add a service loop with claim/lease/retry
5. map `agent_run` to `sessions_spawn`
6. map `session_message` to `sessions_send`
7. add workflow completion fan-in and reporting

## Current status

This directory now includes a minimal runnable v1.

Implemented:

- SQLite-backed workflow store with legacy JSON import
- planner-facing tools:
  - `workflow_memory_context`
  - `workflow_submit`
  - `workflow_status`
  - `workflow_list`
  - `workflow_cancel`
  - `workflow_validate`
- background service loop
- executable step kinds:
  - `agent_run`
  - `session_message`
  - `wait`
- Mem0 planner lookup before workflow submission
- Mem0 write-back for completed workflow summaries
- Mem0 write-back for failed workflow lessons

Current limitations:

- cancellation is cooperative only; running agent steps are not force-aborted yet
- step `model` is accepted in schema but not applied yet
- retry backoff is not persisted yet
- timed out agent steps are retried through the normal retry policy, but there is no separate lease-based stuck-run recovery yet
- `tool_call` is executed as a constrained agent step that must call the named tool before replying; it is not a direct gateway RPC tool executor
- `fan_out` is implemented by expansion into branch steps; the stored workflow status shows the expanded branch step ids such as `parallel_analysis.pm_track`
- approval, cron trigger, subworkflow, and workflow templates are still future work
