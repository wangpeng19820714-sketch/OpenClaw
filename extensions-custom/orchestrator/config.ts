import { Type } from "@sinclair/typebox";
import type { OrchestratorMemoryConfig } from "./memory.js";
import {
  WORKFLOW_STEP_KINDS,
  WorkflowStepKindSchema,
  type WorkflowStepKind,
} from "./workflow-schema.js";

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function parseInteger(value: unknown, fallback: number, label: string, min: number, max: number) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return normalized;
}

function parseStringArray(value: unknown, label: string): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label} must contain non-empty strings`);
    }
    return entry.trim();
  });
}

function parseStepKinds(value: unknown, label: string): WorkflowStepKind[] | undefined {
  const values = parseStringArray(value, label);
  if (!values) {
    return undefined;
  }
  return values.map((entry) => {
    if (!WORKFLOW_STEP_KINDS.includes(entry as WorkflowStepKind)) {
      throw new Error(`${label} contains unsupported step kind: ${entry}`);
    }
    return entry as WorkflowStepKind;
  });
}

export const orchestratorConfigSchema = {
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pollIntervalMs: { type: "number", minimum: 1000, maximum: 600000 },
      leaseTtlMs: { type: "number", minimum: 5000, maximum: 3600000 },
      maxConcurrentWorkflows: { type: "number", minimum: 1, maximum: 64 },
      maxConcurrentSteps: { type: "number", minimum: 1, maximum: 128 },
      defaultRunTimeoutSeconds: { type: "number", minimum: 0, maximum: 86400 },
      defaultRetryLimit: { type: "number", minimum: 0, maximum: 10 },
      allowedTargetAgents: { type: "array", items: { type: "string" } },
      allowedSubmitterAgents: { type: "array", items: { type: "string" } },
      workerOnlyAgents: { type: "array", items: { type: "string" } },
      allowedStepKinds: {
        type: "array",
        items: { type: "string", enum: [...WORKFLOW_STEP_KINDS] },
      },
      submitterPolicies: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            allowedStepKinds: {
              type: "array",
              items: { type: "string", enum: [...WORKFLOW_STEP_KINDS] },
            },
            allowedTargetAgents: { type: "array", items: { type: "string" } },
          },
        },
      },
      memory: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          baseUrl: { type: "string" },
          requestTimeoutMs: { type: "number", minimum: 1000, maximum: 300000 },
          planningTopK: { type: "number", minimum: 1, maximum: 20 },
          writeCompletedSummaries: { type: "boolean" },
          writeFailureMemories: { type: "boolean" },
        },
      },
      cleanupCompletedAfterHours: { type: "number", minimum: 1, maximum: 8760 },
    },
  },
  parse(value: unknown): OrchestratorConfig {
    const cfg = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const root = cfg as Record<string, unknown>;
    assertAllowedKeys(
      root,
      [
        "pollIntervalMs",
        "leaseTtlMs",
        "maxConcurrentWorkflows",
        "maxConcurrentSteps",
        "defaultRunTimeoutSeconds",
        "defaultRetryLimit",
        "allowedTargetAgents",
        "allowedSubmitterAgents",
        "workerOnlyAgents",
        "allowedStepKinds",
        "submitterPolicies",
        "memory",
        "cleanupCompletedAfterHours",
      ],
      "orchestrator config",
    );
    const allowedTargetAgents = parseStringArray(root.allowedTargetAgents, "allowedTargetAgents");
    const allowedSubmitterAgents = parseStringArray(
      root.allowedSubmitterAgents,
      "allowedSubmitterAgents",
    );
    const workerOnlyAgents = parseStringArray(root.workerOnlyAgents, "workerOnlyAgents");
    const allowedStepKinds = parseStepKinds(root.allowedStepKinds, "allowedStepKinds");
    const submitterPolicies = parseSubmitterPolicies(root.submitterPolicies);
    const memory = parseMemoryConfig(root.memory);

    return {
      pollIntervalMs: parseInteger(root.pollIntervalMs, 5000, "pollIntervalMs", 1000, 600000),
      leaseTtlMs: parseInteger(root.leaseTtlMs, 60000, "leaseTtlMs", 5000, 3600000),
      maxConcurrentWorkflows: parseInteger(
        root.maxConcurrentWorkflows,
        4,
        "maxConcurrentWorkflows",
        1,
        64,
      ),
      maxConcurrentSteps: parseInteger(root.maxConcurrentSteps, 8, "maxConcurrentSteps", 1, 128),
      defaultRunTimeoutSeconds: parseInteger(
        root.defaultRunTimeoutSeconds,
        900,
        "defaultRunTimeoutSeconds",
        0,
        86400,
      ),
      defaultRetryLimit: parseInteger(root.defaultRetryLimit, 1, "defaultRetryLimit", 0, 10),
      allowedTargetAgents,
      allowedSubmitterAgents,
      workerOnlyAgents,
      allowedStepKinds,
      submitterPolicies,
      memory,
      cleanupCompletedAfterHours: parseInteger(
        root.cleanupCompletedAfterHours,
        168,
        "cleanupCompletedAfterHours",
        1,
        8760,
      ),
    };
  },
};

export const OrchestratorConfigSchema = Type.Object({
  pollIntervalMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 600000 })),
  leaseTtlMs: Type.Optional(Type.Number({ minimum: 5000, maximum: 3600000 })),
  maxConcurrentWorkflows: Type.Optional(Type.Number({ minimum: 1, maximum: 64 })),
  maxConcurrentSteps: Type.Optional(Type.Number({ minimum: 1, maximum: 128 })),
  defaultRunTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })),
  defaultRetryLimit: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  allowedTargetAgents: Type.Optional(Type.Array(Type.String())),
  allowedSubmitterAgents: Type.Optional(Type.Array(Type.String())),
  workerOnlyAgents: Type.Optional(Type.Array(Type.String())),
  allowedStepKinds: Type.Optional(Type.Array(WorkflowStepKindSchema)),
  submitterPolicies: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        allowedStepKinds: Type.Optional(Type.Array(WorkflowStepKindSchema)),
        allowedTargetAgents: Type.Optional(Type.Array(Type.String())),
      }),
    ),
  ),
  memory: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      baseUrl: Type.Optional(Type.String()),
      requestTimeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 300000 })),
      planningTopK: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      writeCompletedSummaries: Type.Optional(Type.Boolean()),
      writeFailureMemories: Type.Optional(Type.Boolean()),
    }),
  ),
  cleanupCompletedAfterHours: Type.Optional(Type.Number({ minimum: 1, maximum: 8760 })),
});

export type OrchestratorSubmitterPolicy = {
  allowedStepKinds?: WorkflowStepKind[];
  allowedTargetAgents?: string[];
};

export type OrchestratorConfig = {
  pollIntervalMs: number;
  leaseTtlMs: number;
  maxConcurrentWorkflows: number;
  maxConcurrentSteps: number;
  defaultRunTimeoutSeconds: number;
  defaultRetryLimit: number;
  allowedTargetAgents?: string[];
  allowedSubmitterAgents?: string[];
  workerOnlyAgents?: string[];
  allowedStepKinds?: WorkflowStepKind[];
  submitterPolicies?: Record<string, OrchestratorSubmitterPolicy>;
  memory?: OrchestratorMemoryConfig;
  cleanupCompletedAfterHours: number;
};

function parseSubmitterPolicies(
  value: unknown,
): Record<string, OrchestratorSubmitterPolicy> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return undefined;
  }
  const parsed = Object.fromEntries(
    entries.map(([agentId, rawPolicy]) => {
      if (!agentId.trim()) {
        throw new Error("submitterPolicies contains an empty agent id");
      }
      if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
        throw new Error(`submitterPolicies.${agentId} must be an object`);
      }
      const policy = rawPolicy as Record<string, unknown>;
      assertAllowedKeys(
        policy,
        ["allowedStepKinds", "allowedTargetAgents"],
        `submitterPolicies.${agentId}`,
      );
      return [
        agentId.trim(),
        {
          allowedStepKinds: parseStepKinds(
            policy.allowedStepKinds,
            `submitterPolicies.${agentId}.allowedStepKinds`,
          ),
          allowedTargetAgents: parseStringArray(
            policy.allowedTargetAgents,
            `submitterPolicies.${agentId}.allowedTargetAgents`,
          ),
        } satisfies OrchestratorSubmitterPolicy,
      ];
    }),
  );
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseMemoryConfig(value: unknown): OrchestratorMemoryConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const root = value as Record<string, unknown>;
  assertAllowedKeys(
    root,
    [
      "enabled",
      "baseUrl",
      "requestTimeoutMs",
      "planningTopK",
      "writeCompletedSummaries",
      "writeFailureMemories",
    ],
    "orchestrator memory config",
  );
  const enabled = root.enabled === undefined ? true : root.enabled === true;
  if (!enabled) {
    return {
      enabled: false,
      baseUrl: "http://127.0.0.1:8888",
      requestTimeoutMs: 120000,
      planningTopK: 5,
      writeCompletedSummaries: false,
      writeFailureMemories: false,
    };
  }
  if (typeof root.baseUrl !== "string" || !root.baseUrl.trim()) {
    throw new Error("orchestrator memory config.baseUrl is required when memory is enabled");
  }
  return {
    enabled: true,
    baseUrl: root.baseUrl.trim(),
    requestTimeoutMs: parseInteger(
      root.requestTimeoutMs,
      120000,
      "orchestrator memory config.requestTimeoutMs",
      1000,
      300000,
    ),
    planningTopK: parseInteger(
      root.planningTopK,
      5,
      "orchestrator memory config.planningTopK",
      1,
      20,
    ),
    writeCompletedSummaries:
      root.writeCompletedSummaries === undefined ? true : root.writeCompletedSummaries === true,
    writeFailureMemories:
      root.writeFailureMemories === undefined ? true : root.writeFailureMemories === true,
  };
}

export function resolveOrchestratorConfig(value: unknown): OrchestratorConfig {
  return orchestratorConfigSchema.parse(value);
}
