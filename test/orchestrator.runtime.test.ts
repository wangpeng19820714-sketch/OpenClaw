import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OrchestratorConfig } from "../extensions-custom/orchestrator/config.js";
import type { OrchestratorMemoryIntegration } from "../extensions-custom/orchestrator/memory.js";
import { OrchestratorRuntime } from "../extensions-custom/orchestrator/runtime.js";
import { OrchestratorStore } from "../extensions-custom/orchestrator/store.js";
import { validateWorkflowDefinition } from "../extensions-custom/orchestrator/validate.js";
import type { WorkflowDefinition } from "../extensions-custom/orchestrator/workflow-schema.js";
import { readLatestAssistantReply } from "../src/agents/tools/agent-step.js";
import { resolveAnnounceTarget } from "../src/agents/tools/sessions-announce-target.js";
import { callGateway } from "../src/gateway/call.js";

vi.mock("../src/gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("../src/agents/tools/agent-step.js", () => ({
  readLatestAssistantReply: vi.fn(),
}));

vi.mock("../src/agents/tools/sessions-announce-target.js", () => ({
  resolveAnnounceTarget: vi.fn(),
}));

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMemoryIntegrationMock(): OrchestratorMemoryIntegration & {
  getPlanningContext: ReturnType<typeof vi.fn>;
  writeWorkflowCompletionMemory: ReturnType<typeof vi.fn>;
  writeWorkflowFailureMemory: ReturnType<typeof vi.fn>;
} {
  return {
    getPlanningContext: vi.fn(),
    writeWorkflowCompletionMemory: vi.fn(),
    writeWorkflowFailureMemory: vi.fn(),
  };
}

describe("OrchestratorRuntime", () => {
  const callGatewayMock = vi.mocked(callGateway);
  const readLatestAssistantReplyMock = vi.mocked(readLatestAssistantReply);
  const resolveAnnounceTargetMock = vi.mocked(resolveAnnounceTarget);

  beforeEach(() => {
    callGatewayMock.mockReset();
    readLatestAssistantReplyMock.mockReset();
    resolveAnnounceTargetMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes agent_run and dependent session_message steps to completion", async () => {
    const logger = createLogger();
    const store = new OrchestratorStore(
      path.join(tmpdir(), `openclaw-orchestrator-${randomUUID()}.sqlite`),
    );
    const config: OrchestratorConfig = {
      pollIntervalMs: 10,
      leaseTtlMs: 60_000,
      maxConcurrentWorkflows: 2,
      maxConcurrentSteps: 2,
      defaultRunTimeoutSeconds: 60,
      defaultRetryLimit: 1,
      allowedTargetAgents: ["pm", "ba"],
      cleanupCompletedAfterHours: 168,
    };
    const runtime = new OrchestratorRuntime(store, config, logger as never);
    const workflow: WorkflowDefinition = {
      version: 1,
      label: "Plan then follow up",
      ownerAgentId: "ba",
      steps: [
        {
          id: "plan",
          kind: "agent_run",
          agentId: "pm",
          task: "Draft a plan.",
        },
        {
          id: "followup",
          kind: "session_message",
          sessionRef: "plan",
          task: "Refine the plan.",
          dependsOn: ["plan"],
        },
      ],
    };

    let runCounter = 0;
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "agent") {
        runCounter += 1;
        return { runId: `run-${runCounter}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "send") {
        return { ok: true };
      }
      throw new Error(`Unexpected gateway method: ${String(request.method)}`);
    });
    readLatestAssistantReplyMock.mockResolvedValue("step complete");
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "feishu",
      to: "user:ou_requester",
      accountId: "bot_ba",
    });

    await store.load();
    const submitted = await runtime.submitWorkflow({
      workflow,
      requesterAgentId: "ba",
      requesterSessionKey: "agent:ba:requester",
    });
    runtime.start();

    await vi.waitFor(
      async () => {
        const status = await runtime.getWorkflowStatus(submitted.workflowId, true);
        expect(status?.status).toBe("completed");
        expect(status?.steps?.map((step) => step.status)).toEqual(["completed", "completed"]);
        const stored = await store.getWorkflow(submitted.workflowId);
        expect(stored?.completionNoticeState).toBe("sent");
      },
      { timeout: 1500, interval: 20 },
    );

    runtime.stop();

    const agentCalls = callGatewayMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "agent");
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0]?.params).toMatchObject({
      agentId: "pm",
      message: "Draft a plan.",
    });
    expect(agentCalls[1]?.params).toMatchObject({
      sessionKey: expect.stringContaining("agent:pm:workflow:"),
      message: expect.stringContaining("Current step task:\nRefine the plan."),
    });
    expect(String(agentCalls[1]?.params?.message)).toContain("Completed dependency outputs:");
    expect(String(agentCalls[1]?.params?.message)).toContain("step complete");

    const sendCalls = callGatewayMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "send");
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.params).toMatchObject({
      channel: "feishu",
      to: "user:ou_requester",
      accountId: "bot_ba",
    });
    expect(String(sendCalls[0]?.params?.message)).toContain(
      'Workflow "Plan then follow up" completed.',
    );
  });

  it("supports explicit back-and-forth communication between workflow agents", async () => {
    const logger = createLogger();
    const store = new OrchestratorStore(
      path.join(tmpdir(), `openclaw-orchestrator-${randomUUID()}.sqlite`),
    );
    const config: OrchestratorConfig = {
      pollIntervalMs: 10,
      leaseTtlMs: 60_000,
      maxConcurrentWorkflows: 2,
      maxConcurrentSteps: 3,
      defaultRunTimeoutSeconds: 60,
      defaultRetryLimit: 1,
      allowedTargetAgents: ["pm", "ba"],
      cleanupCompletedAfterHours: 168,
    };
    const runtime = new OrchestratorRuntime(store, config, logger as never);
    const workflow: WorkflowDefinition = {
      version: 1,
      label: "PM and BA explicit round trip",
      ownerAgentId: "ba",
      steps: [
        {
          id: "pm_draft",
          kind: "agent_run",
          agentId: "pm",
          task: "先输出一句“PM 初稿已完成”。",
        },
        {
          id: "ba_review",
          kind: "agent_run",
          agentId: "ba",
          dependsOn: ["pm_draft"],
          task: "基于 PM 初稿，输出一句“BA 已审阅并提出修订意见”。",
        },
        {
          id: "pm_followup",
          kind: "agent_message",
          targetStepId: "pm_draft",
          dependsOn: ["ba_review"],
          task: "把 BA 的审阅意见发回 PM，请 PM 回复一句“PM 已根据 BA 意见完成更新”。",
        },
      ],
    };

    let runCounter = 0;
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "agent") {
        runCounter += 1;
        return { runId: `run-${runCounter}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      throw new Error(`Unexpected gateway method: ${String(request.method)}`);
    });
    readLatestAssistantReplyMock
      .mockResolvedValueOnce("PM 初稿已完成。")
      .mockResolvedValueOnce("BA 已审阅并提出修订意见。")
      .mockResolvedValueOnce("PM 已根据 BA 意见完成更新。");

    await store.load();
    const submitted = await runtime.submitWorkflow({ workflow, requesterAgentId: "ba" });
    runtime.start();

    await vi.waitFor(
      async () => {
        const status = await runtime.getWorkflowStatus(submitted.workflowId, true);
        expect(status?.status).toBe("completed");
        expect(status?.steps?.map((step) => step.status)).toEqual([
          "completed",
          "completed",
          "completed",
        ]);
      },
      { timeout: 1500, interval: 20 },
    );

    runtime.stop();

    const agentCalls = callGatewayMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "agent");
    expect(agentCalls).toHaveLength(3);
    const pmDraftSessionKey = String(agentCalls[0]?.params?.sessionKey);
    expect(agentCalls[0]?.params).toMatchObject({ agentId: "pm" });
    expect(agentCalls[1]?.params).toMatchObject({ agentId: "ba" });
    expect(agentCalls[2]?.params).toMatchObject({ sessionKey: pmDraftSessionKey });
    expect(String(agentCalls[2]?.params?.message)).toContain("BA 已审阅并提出修订意见");
    expect(String(agentCalls[2]?.params?.message)).toContain("Current step task:");
  });

  it("supports fan-out branches and fan-in aggregation in downstream steps", async () => {
    const logger = createLogger();
    const store = new OrchestratorStore(
      path.join(tmpdir(), `openclaw-orchestrator-${randomUUID()}.sqlite`),
    );
    const config: OrchestratorConfig = {
      pollIntervalMs: 10,
      leaseTtlMs: 60_000,
      maxConcurrentWorkflows: 2,
      maxConcurrentSteps: 4,
      defaultRunTimeoutSeconds: 60,
      defaultRetryLimit: 1,
      allowedTargetAgents: ["pm", "ba", "server"],
      cleanupCompletedAfterHours: 168,
    };
    const runtime = new OrchestratorRuntime(store, config, logger as never);
    const workflow: WorkflowDefinition = {
      version: 1,
      label: "Parallel analysis then synthesis",
      ownerAgentId: "ba",
      steps: [
        {
          id: "parallel_analysis",
          kind: "fan_out",
          branches: [
            {
              id: "pm_track",
              kind: "agent_run",
              agentId: "pm",
              task: "输出一句“PM 并行分析完成”。",
            },
            {
              id: "ba_track",
              kind: "agent_run",
              agentId: "ba",
              task: "输出一句“BA 并行分析完成”。",
            },
          ],
        },
        {
          id: "synthesize",
          kind: "agent_run",
          agentId: "server",
          dependsOn: ["parallel_analysis"],
          task: "整合两个并行分支的结果，并输出一句“并行结果已整合”。",
        },
      ],
    };

    let runCounter = 0;
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "agent") {
        runCounter += 1;
        return { runId: `run-${runCounter}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      throw new Error(`Unexpected gateway method: ${String(request.method)}`);
    });
    readLatestAssistantReplyMock
      .mockResolvedValueOnce("PM 并行分析完成。")
      .mockResolvedValueOnce("BA 并行分析完成。")
      .mockResolvedValueOnce("并行结果已整合。");

    await store.load();
    const submitted = await runtime.submitWorkflow({ workflow, requesterAgentId: "ba" });
    runtime.start();

    await vi.waitFor(
      async () => {
        const status = await runtime.getWorkflowStatus(submitted.workflowId, true);
        expect(status?.status).toBe("completed");
        expect(status?.steps?.map((step) => step.status)).toEqual([
          "completed",
          "completed",
          "completed",
        ]);
      },
      { timeout: 1500, interval: 20 },
    );

    runtime.stop();

    const agentCalls = callGatewayMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "agent");
    expect(agentCalls).toHaveLength(3);
    expect(agentCalls[0]?.params).toMatchObject({ agentId: "pm" });
    expect(agentCalls[1]?.params).toMatchObject({ agentId: "ba" });
    expect(agentCalls[2]?.params).toMatchObject({ agentId: "server" });
    expect(String(agentCalls[2]?.params?.message)).toContain("PM 并行分析完成");
    expect(String(agentCalls[2]?.params?.message)).toContain("BA 并行分析完成");
    expect(String(agentCalls[2]?.params?.message)).toContain(
      "Dependency parallel_analysis.pm_track",
    );
    expect(String(agentCalls[2]?.params?.message)).toContain(
      "Dependency parallel_analysis.ba_track",
    );
  });

  it("executes tool_call steps and condition gates before downstream agent steps", async () => {
    const logger = createLogger();
    const store = new OrchestratorStore(
      path.join(tmpdir(), `openclaw-orchestrator-${randomUUID()}.sqlite`),
    );
    const config: OrchestratorConfig = {
      pollIntervalMs: 10,
      leaseTtlMs: 60_000,
      maxConcurrentWorkflows: 2,
      maxConcurrentSteps: 3,
      defaultRunTimeoutSeconds: 60,
      defaultRetryLimit: 1,
      allowedTargetAgents: ["ba", "pm"],
      allowedStepKinds: ["agent_run", "tool_call", "condition", "wait", "session_message"],
      cleanupCompletedAfterHours: 168,
    };
    const runtime = new OrchestratorRuntime(store, config, logger as never);
    const workflow: WorkflowDefinition = {
      version: 1,
      label: "Use tool then branch",
      ownerAgentId: "ba",
      steps: [
        {
          id: "lookup",
          kind: "tool_call",
          agentId: "ba",
          toolName: "memory_search",
          arguments: { query: "我家的猫叫什么" },
          task: "查询长期记忆，确认宠物名字。",
        },
        {
          id: "gate",
          kind: "condition",
          dependsOn: ["lookup"],
          operator: "contains",
          value: "满分",
          onFalse: "skip_dependents",
        },
        {
          id: "report",
          kind: "agent_run",
          agentId: "pm",
          dependsOn: ["lookup", "gate"],
          task: "根据前面结果，输出一句确认结论。",
        },
      ],
    };

    let runCounter = 0;
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "agent") {
        runCounter += 1;
        return { runId: `run-${runCounter}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "send") {
        return { ok: true };
      }
      throw new Error(`Unexpected gateway method: ${String(request.method)}`);
    });
    readLatestAssistantReplyMock
      .mockResolvedValueOnce("长期记忆显示：我家的猫叫满分。")
      .mockResolvedValueOnce("已根据前置结果生成确认结论。");
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "feishu",
      to: "user:ou_requester",
      accountId: "bot_ba",
    });

    await store.load();
    const submitted = await runtime.submitWorkflow({
      workflow,
      requesterAgentId: "ba",
      requesterSessionKey: "agent:ba:requester",
    });
    runtime.start();

    await vi.waitFor(
      async () => {
        const status = await runtime.getWorkflowStatus(submitted.workflowId, true);
        expect(status?.status).toBe("completed");
        expect(status?.steps?.map((step) => step.status)).toEqual([
          "completed",
          "completed",
          "completed",
        ]);
      },
      { timeout: 1500, interval: 20 },
    );

    runtime.stop();

    const agentCalls = callGatewayMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "agent");
    expect(agentCalls).toHaveLength(2);
    expect(String(agentCalls[0]?.params?.extraSystemPrompt)).toContain(
      "You must call the memory_search tool before responding.",
    );
    expect(String(agentCalls[1]?.params?.message)).toContain(
      "Current step task:\n根据前面结果，输出一句确认结论。",
    );
    expect(String(agentCalls[1]?.params?.message)).toContain("Condition passed");
    expect(String(agentCalls[1]?.params?.message)).toContain("满分");
  });

  it("enforces submitter policy for worker-only agents and restricted step kinds", () => {
    const config: OrchestratorConfig = {
      pollIntervalMs: 10,
      leaseTtlMs: 60_000,
      maxConcurrentWorkflows: 2,
      maxConcurrentSteps: 3,
      defaultRunTimeoutSeconds: 60,
      defaultRetryLimit: 1,
      allowedTargetAgents: ["ba", "pm", "server"],
      allowedSubmitterAgents: ["ba", "pm"],
      workerOnlyAgents: ["server"],
      allowedStepKinds: ["agent_run", "tool_call", "condition", "wait", "session_message"],
      submitterPolicies: {
        pm: {
          allowedStepKinds: ["agent_run", "condition"],
          allowedTargetAgents: ["ba"],
        },
      },
      cleanupCompletedAfterHours: 168,
    };
    const workflow: WorkflowDefinition = {
      version: 1,
      label: "Restricted workflow",
      steps: [
        {
          id: "lookup",
          kind: "tool_call",
          agentId: "server",
          toolName: "exec",
          arguments: { command: "echo hi" },
        },
      ],
    };

    const pmResult = validateWorkflowDefinition(workflow, config, "pm");
    expect(pmResult.ok).toBe(false);
    expect(pmResult.errors).toContain(
      "Step lookup uses step kind tool_call, which pm is not allowed to submit",
    );
    expect(pmResult.errors).toContain("Step lookup targets agent server, which pm cannot dispatch");

    const serverResult = validateWorkflowDefinition(workflow, config, "server");
    expect(serverResult.ok).toBe(false);
    expect(serverResult.errors).toContain(
      "Requester agent server is not allowed to submit workflows",
    );
    expect(serverResult.errors).toContain(
      "Requester agent server is worker-only and cannot submit workflows",
    );
  });

  it("loads planning memories on submit and writes completion summaries back to Mem0", async () => {
    const logger = createLogger();
    const store = new OrchestratorStore(
      path.join(tmpdir(), `openclaw-orchestrator-${randomUUID()}.sqlite`),
    );
    const memory = createMemoryIntegrationMock();
    const config: OrchestratorConfig = {
      pollIntervalMs: 10,
      leaseTtlMs: 60_000,
      maxConcurrentWorkflows: 1,
      maxConcurrentSteps: 1,
      defaultRunTimeoutSeconds: 60,
      defaultRetryLimit: 1,
      allowedTargetAgents: ["ba"],
      cleanupCompletedAfterHours: 168,
    };
    const runtime = new OrchestratorRuntime(store, config, logger as never, memory);
    const workflow: WorkflowDefinition = {
      version: 1,
      label: "Remember successful rollout",
      ownerAgentId: "ba",
      steps: [
        {
          id: "pause",
          kind: "wait",
          delaySeconds: 0,
        },
      ],
    };

    memory.getPlanningContext.mockResolvedValue({
      query: "Remember successful rollout",
      userId: "openclaw:ba",
      memories: [{ id: "mem-1", text: "上次发布需要先同步 PM。", score: 0.92, raw: {} }],
    });
    memory.writeWorkflowCompletionMemory.mockResolvedValue("Workflow completion\nSummary: done");
    memory.writeWorkflowFailureMemory.mockResolvedValue(null);

    await store.load();
    const submitted = await runtime.submitWorkflow({
      workflow,
      requesterAgentId: "ba",
    });
    expect(submitted.planningMemoryCount).toBe(1);

    const created = await store.getWorkflow(submitted.workflowId);
    expect(created?.planningMemories).toEqual([
      { id: "mem-1", text: "上次发布需要先同步 PM。", score: 0.92 },
    ]);

    runtime.start();

    await vi.waitFor(
      async () => {
        const record = await store.getWorkflow(submitted.workflowId);
        expect(record?.status).toBe("completed");
        expect(record?.terminalMemoryState).toBe("written");
        expect(record?.terminalMemoryText).toContain("Workflow completion");
      },
      { timeout: 1500, interval: 20 },
    );

    runtime.stop();

    expect(memory.getPlanningContext).toHaveBeenCalledWith({
      requesterAgentId: "ba",
      ownerAgentId: "ba",
      query: "Remember successful rollout",
    });
    expect(memory.writeWorkflowCompletionMemory).toHaveBeenCalledTimes(1);
    expect(memory.writeWorkflowFailureMemory).not.toHaveBeenCalled();
  });

  it("writes failure lessons back to Mem0 when a workflow fails", async () => {
    const logger = createLogger();
    const store = new OrchestratorStore(
      path.join(tmpdir(), `openclaw-orchestrator-${randomUUID()}.sqlite`),
    );
    const memory = createMemoryIntegrationMock();
    const config: OrchestratorConfig = {
      pollIntervalMs: 10,
      leaseTtlMs: 60_000,
      maxConcurrentWorkflows: 1,
      maxConcurrentSteps: 1,
      defaultRunTimeoutSeconds: 60,
      defaultRetryLimit: 1,
      allowedTargetAgents: ["ba"],
      cleanupCompletedAfterHours: 168,
    };
    const runtime = new OrchestratorRuntime(store, config, logger as never, memory);
    const workflow: WorkflowDefinition = {
      version: 1,
      label: "Capture failure lesson",
      ownerAgentId: "ba",
      steps: [
        {
          id: "prepare",
          kind: "wait",
          delaySeconds: 0,
        },
        {
          id: "gate",
          kind: "condition",
          dependsOn: ["prepare"],
          operator: "contains",
          value: "never-happens",
          onFalse: "fail_workflow",
        },
      ],
    };

    memory.getPlanningContext.mockResolvedValue(null);
    memory.writeWorkflowCompletionMemory.mockResolvedValue(null);
    memory.writeWorkflowFailureMemory.mockResolvedValue("Workflow failure lesson\nFailures: gate");

    await store.load();
    const submitted = await runtime.submitWorkflow({
      workflow,
      requesterAgentId: "ba",
    });

    runtime.start();

    await vi.waitFor(
      async () => {
        const record = await store.getWorkflow(submitted.workflowId);
        expect(record?.status).toBe("failed");
        expect(record?.terminalMemoryState).toBe("written");
        expect(record?.terminalMemoryKind).toBe("failed");
        expect(record?.terminalMemoryText).toContain("Workflow failure lesson");
      },
      { timeout: 1500, interval: 20 },
    );

    runtime.stop();

    expect(memory.writeWorkflowFailureMemory).toHaveBeenCalledTimes(1);
    expect(memory.writeWorkflowCompletionMemory).not.toHaveBeenCalled();
  });

  it("retries timed out agent steps and continues the workflow after restart", async () => {
    const logger = createLogger();
    const store = new OrchestratorStore(
      path.join(tmpdir(), `openclaw-orchestrator-${randomUUID()}.sqlite`),
    );
    const config: OrchestratorConfig = {
      pollIntervalMs: 10,
      leaseTtlMs: 60_000,
      maxConcurrentWorkflows: 1,
      maxConcurrentSteps: 1,
      defaultRunTimeoutSeconds: 60,
      defaultRetryLimit: 1,
      allowedTargetAgents: ["pm"],
      cleanupCompletedAfterHours: 168,
    };
    const runtime = new OrchestratorRuntime(store, config, logger as never);
    const workflow: WorkflowDefinition = {
      version: 1,
      label: "Retry timed out worker",
      ownerAgentId: "ba",
      steps: [
        {
          id: "plan",
          kind: "agent_run",
          agentId: "pm",
          task: "如果第一次超时，重启后回复“PM 已恢复并完成”。",
        },
      ],
    };

    let runCounter = 0;
    let waitCounter = 0;
    callGatewayMock.mockImplementation(async (request) => {
      if (request.method === "agent") {
        runCounter += 1;
        return { runId: `run-${runCounter}` };
      }
      if (request.method === "agent.wait") {
        waitCounter += 1;
        if (waitCounter === 1) {
          return { status: "timeout", endedAt: Date.now() };
        }
        return { status: "ok" };
      }
      if (request.method === "send") {
        return { ok: true };
      }
      throw new Error(`Unexpected gateway method: ${String(request.method)}`);
    });
    readLatestAssistantReplyMock.mockResolvedValue("PM 已恢复并完成。");
    resolveAnnounceTargetMock.mockResolvedValue(undefined);

    await store.load();
    const submitted = await runtime.submitWorkflow({
      workflow,
      requesterAgentId: "ba",
    });

    runtime.start();

    await vi.waitFor(
      async () => {
        const record = await store.getWorkflow(submitted.workflowId);
        expect(record?.status).toBe("completed");
        expect(record?.steps[0]?.status).toBe("completed");
        expect(record?.steps[0]?.attempt).toBe(2);
        expect(record?.steps[0]?.lastError).toBe("Agent run timed out");
      },
      { timeout: 1500, interval: 20 },
    );

    runtime.stop();

    const agentCalls = callGatewayMock.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "agent");
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0]?.params).toMatchObject({ agentId: "pm" });
    expect(agentCalls[1]?.params).toMatchObject({ agentId: "pm" });
  });
});
