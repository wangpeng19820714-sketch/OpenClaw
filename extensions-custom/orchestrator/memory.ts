import { Mem0Client } from "../mem0-openclaw/client.js";
import type { Mem0Memory } from "../mem0-openclaw/client.js";
import type { StoredWorkflowRecord } from "./store.js";

export type { Mem0Memory } from "../mem0-openclaw/client.js";

export type OrchestratorMemoryConfig = {
  enabled: boolean;
  baseUrl: string;
  requestTimeoutMs: number;
  planningTopK: number;
  writeCompletedSummaries: boolean;
  writeFailureMemories: boolean;
};

export type PlanningMemoryContext = {
  query: string;
  userId: string;
  memories: Mem0Memory[];
};

export type OrchestratorMemoryIntegration = {
  getPlanningContext(params: {
    requesterAgentId?: string;
    ownerAgentId?: string;
    query: string;
    limit?: number;
  }): Promise<PlanningMemoryContext | null>;
  writeWorkflowCompletionMemory(workflow: StoredWorkflowRecord): Promise<string | null>;
  writeWorkflowFailureMemory(workflow: StoredWorkflowRecord): Promise<string | null>;
};

function trimText(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveWorkflowMemoryUserId(params: {
  requesterAgentId?: string;
  ownerAgentId?: string;
}): string | undefined {
  const agentId = params.requesterAgentId?.trim() || params.ownerAgentId?.trim();
  return agentId ? `openclaw:${agentId}` : undefined;
}

function buildWorkflowPlanningQuery(workflow: StoredWorkflowRecord): string {
  const taskSummary = workflow.definition.steps
    .map((step) => {
      if (
        step.kind === "agent_run" ||
        step.kind === "session_message" ||
        step.kind === "tool_call"
      ) {
        return trimText(step.task);
      }
      return undefined;
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 3)
    .join(" | ");
  return [workflow.definition.label, taskSummary].filter(Boolean).join(" | ");
}

function buildCompletionMemoryText(workflow: StoredWorkflowRecord): string | null {
  const summary = trimText(workflow.resultSummary);
  if (!summary) {
    return null;
  }
  return [
    `Workflow completion`,
    `Label: ${workflow.definition.label}`,
    workflow.requesterAgentId ? `Requester agent: ${workflow.requesterAgentId}` : undefined,
    `Summary: ${summary}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFailureMemoryText(workflow: StoredWorkflowRecord): string | null {
  const failingSteps = workflow.steps
    .filter((step) => step.status === "failed" || step.status === "timed_out")
    .map((step) => {
      const detail = trimText(step.lastError) || trimText(step.outputSummary);
      return detail ? `${step.stepId}: ${detail}` : step.stepId;
    });
  if (failingSteps.length === 0) {
    return null;
  }
  return [
    `Workflow failure lesson`,
    `Label: ${workflow.definition.label}`,
    workflow.requesterAgentId ? `Requester agent: ${workflow.requesterAgentId}` : undefined,
    `Failures: ${failingSteps.join(" | ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class OrchestratorMem0Integration implements OrchestratorMemoryIntegration {
  private readonly client: Mem0Client;
  private readonly config: OrchestratorMemoryConfig;

  constructor(config: OrchestratorMemoryConfig) {
    this.config = config;
    this.client = new Mem0Client({
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
    });
  }

  async getPlanningContext(params: {
    requesterAgentId?: string;
    ownerAgentId?: string;
    query: string;
    limit?: number;
  }): Promise<PlanningMemoryContext | null> {
    const userId = resolveWorkflowMemoryUserId(params);
    const query = trimText(params.query);
    if (!this.config.enabled || !userId || !query) {
      return null;
    }
    const memories = await this.client.search({
      query,
      userId,
      limit: params.limit ?? this.config.planningTopK,
    });
    return {
      query,
      userId,
      memories,
    };
  }

  async writeWorkflowCompletionMemory(workflow: StoredWorkflowRecord): Promise<string | null> {
    if (!this.config.enabled || !this.config.writeCompletedSummaries) {
      return null;
    }
    const userId = resolveWorkflowMemoryUserId({
      requesterAgentId: workflow.requesterAgentId,
      ownerAgentId: workflow.definition.ownerAgentId,
    });
    const text = buildCompletionMemoryText(workflow);
    if (!userId || !text) {
      return null;
    }
    await this.client.addMessages({
      messages: [{ role: "user", content: text }],
      userId,
      infer: false,
    });
    return text;
  }

  async writeWorkflowFailureMemory(workflow: StoredWorkflowRecord): Promise<string | null> {
    if (!this.config.enabled || !this.config.writeFailureMemories) {
      return null;
    }
    const userId = resolveWorkflowMemoryUserId({
      requesterAgentId: workflow.requesterAgentId,
      ownerAgentId: workflow.definition.ownerAgentId,
    });
    const text = buildFailureMemoryText(workflow);
    if (!userId || !text) {
      return null;
    }
    await this.client.addMessages({
      messages: [{ role: "user", content: text }],
      userId,
      infer: false,
    });
    return text;
  }
}

export function derivePlanningQueryFromWorkflow(workflow: StoredWorkflowRecord): string {
  return buildWorkflowPlanningQuery(workflow);
}
