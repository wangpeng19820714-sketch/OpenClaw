import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveOrchestratorConfig, orchestratorConfigSchema } from "./config.js";
import { OrchestratorMem0Integration } from "./memory.js";
import { OrchestratorRuntime } from "./runtime.js";
import { OrchestratorStore } from "./store.js";
import {
  WorkflowCancelParamsSchema,
  WorkflowDefinitionSchema,
  WorkflowListParamsSchema,
  WorkflowMemoryContextParamsSchema,
  WorkflowStatusParamsSchema,
  WorkflowSubmitParamsSchema,
} from "./workflow-schema.js";

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function createOrchestratorTools(params: {
  runtime: OrchestratorRuntime;
  memory?: OrchestratorMem0Integration;
  requesterAgentId?: string;
  requesterSessionKey?: string;
}) {
  const tools: AnyAgentTool[] = [
    {
      name: "workflow_submit",
      label: "Workflow Submit",
      description: "Submit an agent-defined workflow for asynchronous orchestration.",
      parameters: WorkflowSubmitParamsSchema,
      async execute(_toolCallId, rawParams) {
        const typed = rawParams as { workflow: typeof rawParams; startAt?: string };
        const result = await params.runtime.submitWorkflow({
          workflow: typed.workflow as never,
          startAt:
            typeof typed.startAt === "string" ? typed.startAt.trim() || undefined : undefined,
          requesterAgentId: params.requesterAgentId,
          requesterSessionKey: params.requesterSessionKey,
        });
        return jsonToolResult(result);
      },
    },
    {
      name: "workflow_memory_context",
      label: "Workflow Memory Context",
      description:
        "Search long-term memories relevant to planning a workflow before you submit it.",
      parameters: WorkflowMemoryContextParamsSchema,
      async execute(_toolCallId, rawParams) {
        const typed = rawParams as { query: string; limit?: number; agentId?: string };
        if (!params.memory) {
          return jsonToolResult({
            enabled: false,
            query: typed.query?.trim() ?? "",
            memories: [],
          });
        }
        const result = await params.memory.getPlanningContext({
          requesterAgentId:
            typeof typed.agentId === "string" && typed.agentId.trim()
              ? typed.agentId.trim()
              : params.requesterAgentId,
          query: typed.query.trim(),
          limit: typeof typed.limit === "number" ? typed.limit : undefined,
        });
        return jsonToolResult({
          enabled: true,
          query: result?.query ?? typed.query.trim(),
          userId: result?.userId,
          memories: result?.memories ?? [],
        });
      },
    },
    {
      name: "workflow_status",
      label: "Workflow Status",
      description: "Check workflow status and optionally its steps.",
      parameters: WorkflowStatusParamsSchema,
      async execute(_toolCallId, rawParams) {
        const typed = rawParams as { workflowId: string; includeSteps?: boolean };
        const result = await params.runtime.getWorkflowStatus(
          typed.workflowId.trim(),
          typed.includeSteps === true,
        );
        return jsonToolResult(
          result ?? {
            found: false,
            workflowId: typed.workflowId.trim(),
          },
        );
      },
    },
    {
      name: "workflow_list",
      label: "Workflow List",
      description: "List recent workflows.",
      parameters: WorkflowListParamsSchema,
      async execute(_toolCallId, rawParams) {
        const typed = rawParams as { status?: string; limit?: number };
        const result = await params.runtime.listWorkflows({
          status: typeof typed.status === "string" ? (typed.status as never) : undefined,
          limit: typeof typed.limit === "number" ? typed.limit : undefined,
        });
        return jsonToolResult({ workflows: result });
      },
    },
    {
      name: "workflow_cancel",
      label: "Workflow Cancel",
      description: "Cancel a pending or running workflow.",
      parameters: WorkflowCancelParamsSchema,
      async execute(_toolCallId, rawParams) {
        const typed = rawParams as { workflowId: string; reason?: string };
        const result = await params.runtime.cancelWorkflow(
          typed.workflowId.trim(),
          typeof typed.reason === "string" ? typed.reason.trim() : undefined,
        );
        return jsonToolResult(
          result ?? {
            found: false,
            workflowId: typed.workflowId.trim(),
          },
        );
      },
    },
    {
      name: "workflow_validate",
      label: "Workflow Validate",
      description:
        "Validate a workflow definition against the orchestrator schema and submitter policy.",
      parameters: Type.Object({ workflow: WorkflowDefinitionSchema }),
      async execute(_toolCallId, rawParams) {
        const typed = rawParams as { workflow: typeof rawParams };
        const result = await params.runtime.validateWorkflow(
          typed.workflow as never,
          params.requesterAgentId,
        );
        return jsonToolResult(result);
      },
    },
  ];
  return tools;
}

const orchestratorPlugin = {
  id: "orchestrator",
  name: "Orchestrator",
  description: "Agent-defined workflow orchestration on top of OpenClaw sessions and agents.",
  configSchema: orchestratorConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = resolveOrchestratorConfig(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir();
    const store = new OrchestratorStore(
      path.join(stateDir, "plugins", "orchestrator", "workflows.sqlite"),
      path.join(stateDir, "plugins", "orchestrator", "workflows.json"),
    );
    const memory = cfg.memory?.enabled ? new OrchestratorMem0Integration(cfg.memory) : undefined;
    const runtime = new OrchestratorRuntime(store, cfg, api.logger, memory);

    api.logger.info("orchestrator: plugin registered");

    api.registerTool(
      (toolCtx) =>
        createOrchestratorTools({
          runtime,
          memory,
          requesterAgentId: toolCtx.agentId,
          requesterSessionKey: toolCtx.sessionKey,
        }),
      {
        names: [
          "workflow_submit",
          "workflow_memory_context",
          "workflow_status",
          "workflow_list",
          "workflow_cancel",
          "workflow_validate",
        ],
      },
    );

    api.registerService({
      id: "orchestrator",
      start: async () => {
        await store.load();
        runtime.start();
      },
      stop: async () => {
        runtime.stop();
        store.close();
      },
    });
  },
};

export default orchestratorPlugin;
