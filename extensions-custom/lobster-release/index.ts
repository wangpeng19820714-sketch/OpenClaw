import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/lobster";
import { createGatewaySubagentRuntime } from "../../src/plugins/runtime/gateway-subagent-runtime.js";
import { resolveLobsterReleaseConfig } from "./config.js";
import { createLobsterReleaseHttpHandler } from "./http.js";
import { LobsterReleaseRuntime } from "./runtime.js";
import { LobsterReleaseStore } from "./store.js";
import type { BuildTargets, ReleaseChannel, ReleaseEnvironment } from "./types.js";

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const TargetsSchema = Type.Object(
  {
    androidApk: Type.Optional(Type.Boolean()),
    androidAab: Type.Optional(Type.Boolean()),
    macosApp: Type.Optional(Type.Boolean()),
    patch: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

function normalizeTargets(raw: unknown): BuildTargets {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    androidApk: input.androidApk === true,
    androidAab: input.androidAab === true,
    macosApp: input.macosApp === true,
    patch: input.patch === true,
  };
}

const DEFAULT_NOTIFIER_SESSION_KEY = "agent:lobster-release:notifier";
const DEFAULT_NOTIFIER_MESSAGE =
  "Process pending lobster release notifications. Pull pending items from lobster-release, send the needed Feishu notifications, and acknowledge or fail each item.";
const SUBAGENT_GATEWAY_REQUEST_ERROR =
  "Plugin runtime subagent methods are only available during a gateway request.";
function buildNotifierSystemPrompt(config: ReturnType<typeof resolveLobsterReleaseConfig>) {
  const lines = [
    "You are the Lobster Release Notifier.",
    "Only handle notifications that come from lobster-release notification tools.",
    "Use release_notifications_pull first, then use release_notifications_render for each notification before sending.",
    "If release_notifications_render returns mode=explicit_target, prefer the rendered deliveryPlan and use the message tool with those rendered args.",
    "If release_notifications_render returns mode=session_bound, prefer sending by replying from the bound notifier session unless the rendered plan includes an explicit target.",
    "Do not invent targets, rewrite the message body, or switch delivery channels unless the rendered plan explicitly tells you to.",
    "Only call release_notifications_ack after the notification message is actually sent on the delivery surface.",
    "If the required delivery primitive is unavailable or send confirmation is ambiguous, call release_notifications_fail with the concrete reason instead of acknowledging.",
    "Do not call release_notifications_requeue unless a human operator explicitly asks for manual recovery.",
    "You may inspect release_status or release_provenance for context, but never create, approve, publish, or rollback a release.",
    "Avoid duplicate sends and keep messages concise and operational.",
  ];
  if (config.notifierChannel && config.notifierTarget) {
    lines.push(
      `Default delivery target: channel=${config.notifierChannel}, target=${config.notifierTarget}${config.notifierAccountId ? `, accountId=${config.notifierAccountId}` : ""}.`,
    );
    lines.push("Prefer the deliveryPlan returned by release_notifications_render.");
  } else if (config.notifierSessionKey) {
    lines.push(
      `Use the notifier session ${config.notifierSessionKey} as the bound delivery surface. When release_notifications_render returns mode=session_bound, do not add an explicit target unless the rendered plan includes one.`,
    );
  } else {
    lines.push(
      "No notifier delivery route is configured. If release_notifications_render says deliveryPlan.configured=false, do not guess a target.",
    );
  }
  return lines.join("\n");
}

export const __testing = {
  buildNotifierSystemPrompt,
} as const;

function createTools(
  runtime: LobsterReleaseRuntime,
  defaultProjectKey: string,
  pluginRuntime: OpenClawPluginApi["runtime"],
  config: ReturnType<typeof resolveLobsterReleaseConfig>,
): AnyAgentTool[] {
  let readyPromise: Promise<void> | null = null;
  const ensureReady = async () => {
    if (!readyPromise) {
      readyPromise = runtime.start().catch((error) => {
        readyPromise = null;
        throw error;
      });
    }
    await readyPromise;
  };
  const withRuntimeReady = (tool: AnyAgentTool): AnyAgentTool => {
    if (!tool.execute) {
      return tool;
    }
    return {
      ...tool,
      execute: async (toolCallId, rawParams) => {
        await ensureReady();
        return tool.execute!(toolCallId, rawParams);
      },
    };
  };
  const runNotifierSubagent = async (params: Parameters<typeof pluginRuntime.subagent.run>[0]) => {
    try {
      return await pluginRuntime.subagent.run(params);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(SUBAGENT_GATEWAY_REQUEST_ERROR)) {
        throw error;
      }
      return createGatewaySubagentRuntime().run(params);
    }
  };
  const waitForNotifierRun = async (
    params: Parameters<typeof pluginRuntime.subagent.waitForRun>[0],
  ) => {
    try {
      return await pluginRuntime.subagent.waitForRun(params);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(SUBAGENT_GATEWAY_REQUEST_ERROR)) {
        throw error;
      }
      return createGatewaySubagentRuntime().waitForRun(params);
    }
  };
  return [
    withRuntimeReady({
      name: "release_project_catalog",
      label: "Release Project Catalog",
      description:
        "Inspect configured lobster-release projects, environments, channels, and gray rollout defaults.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return jsonToolResult(runtime.getProjectCatalog());
      },
    }),
    withRuntimeReady({
      name: "release_gray_plan",
      label: "Release Gray Plan",
      description:
        "Inspect gray rollout pre-configuration, supported region/audience dimensions, and smoke workflows for a project channel.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          region: Type.Optional(Type.String({ minLength: 1 })),
          audience: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.getGrayReleasePlan({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment:
              typeof params.environment === "string"
                ? (params.environment as ReleaseEnvironment)
                : undefined,
            channel:
              typeof params.channel === "string" ? (params.channel as ReleaseChannel) : undefined,
            region: typeof params.region === "string" ? params.region : undefined,
            audience: typeof params.audience === "string" ? params.audience : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollout_list",
      label: "Release Rollout List",
      description: "List rollout records for a project/environment/channel.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          releaseId: Type.Optional(Type.String({ minLength: 1 })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.listRollouts({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment:
              typeof params.environment === "string"
                ? (params.environment as ReleaseEnvironment)
                : undefined,
            channel:
              typeof params.channel === "string" ? (params.channel as ReleaseChannel) : undefined,
            releaseId: typeof params.releaseId === "string" ? params.releaseId : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollout_create",
      label: "Release Rollout Create",
      description:
        "Create a channel rollout for a built release using gray-release scope and traffic controls.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          releaseId: Type.String({ minLength: 1 }),
          trafficPercent: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
          scope: Type.Optional(
            Type.Object(
              {
                region: Type.Optional(Type.String({ minLength: 1 })),
                audience: Type.Optional(Type.String({ minLength: 1 })),
              },
              { additionalProperties: false },
            ),
          ),
          notes: Type.Optional(Type.String()),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        const scope =
          params.scope && typeof params.scope === "object"
            ? (params.scope as Record<string, unknown>)
            : undefined;
        return jsonToolResult(
          await runtime.createRollout({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment:
              typeof params.environment === "string"
                ? (params.environment as ReleaseEnvironment)
                : defaultEnvironment,
            channel:
              typeof params.channel === "string"
                ? (params.channel as ReleaseChannel)
                : defaultChannel,
            releaseId: String(params.releaseId),
            trafficPercent:
              typeof params.trafficPercent === "number" ? params.trafficPercent : undefined,
            scope: scope
              ? {
                  region: typeof scope.region === "string" ? scope.region : undefined,
                  audience: typeof scope.audience === "string" ? scope.audience : undefined,
                }
              : undefined,
            notes: typeof params.notes === "string" ? params.notes : undefined,
            operator: typeof params.operator === "string" ? params.operator : "agent",
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollout_advance",
      label: "Release Rollout Advance",
      description:
        "Advance a rollout traffic percentage, optionally complete it, and optionally publish the rollout release.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          rolloutId: Type.String({ minLength: 1 }),
          trafficPercent: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
          complete: Type.Optional(Type.Boolean()),
          publishRelease: Type.Optional(Type.Boolean()),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          await runtime.advanceRollout({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            rolloutId: String(params.rolloutId),
            trafficPercent: typeof params.trafficPercent === "number" ? params.trafficPercent : 100,
            complete: params.complete === true,
            publishRelease: params.publishRelease === true,
            operator: typeof params.operator === "string" ? params.operator : "agent",
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollout_cancel",
      label: "Release Rollout Cancel",
      description: "Cancel an active rollout without mutating the stable channel pointer.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          rolloutId: Type.String({ minLength: 1 }),
          reason: Type.Optional(Type.String()),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.cancelRollout({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            rolloutId: String(params.rolloutId),
            reason: typeof params.reason === "string" ? params.reason : undefined,
            operator: typeof params.operator === "string" ? params.operator : "agent",
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollout_status",
      label: "Release Rollout Status",
      description:
        "Inspect rollout health, aggregated observations, thresholds, and the next auto-action.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          rolloutId: Type.String({ minLength: 1 }),
          publishRelease: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.getRolloutStatus({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            rolloutId: String(params.rolloutId),
            publishRelease: params.publishRelease !== false,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollout_observe",
      label: "Release Rollout Observe",
      description:
        "Record rollout monitoring counters such as sample size, success, error, and crash counts.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          rolloutId: Type.String({ minLength: 1 }),
          sampleSize: Type.Optional(Type.Number({ minimum: 1 })),
          successCount: Type.Optional(Type.Number({ minimum: 0 })),
          errorCount: Type.Optional(Type.Number({ minimum: 0 })),
          crashCount: Type.Optional(Type.Number({ minimum: 0 })),
          latencyP95Ms: Type.Optional(Type.Number({ minimum: 0 })),
          source: Type.Optional(Type.String({ minLength: 1 })),
          notes: Type.Optional(Type.String()),
          observedAt: Type.Optional(Type.String({ minLength: 1 })),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.recordRolloutObservation({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            rolloutId: String(params.rolloutId),
            sampleSize: typeof params.sampleSize === "number" ? params.sampleSize : undefined,
            successCount: typeof params.successCount === "number" ? params.successCount : undefined,
            errorCount: typeof params.errorCount === "number" ? params.errorCount : undefined,
            crashCount: typeof params.crashCount === "number" ? params.crashCount : undefined,
            latencyP95Ms: typeof params.latencyP95Ms === "number" ? params.latencyP95Ms : undefined,
            source: typeof params.source === "string" ? params.source : undefined,
            notes: typeof params.notes === "string" ? params.notes : undefined,
            observedAt: typeof params.observedAt === "string" ? params.observedAt : undefined,
            operator: typeof params.operator === "string" ? params.operator : "agent",
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollout_evaluate",
      label: "Release Rollout Evaluate",
      description:
        "Evaluate rollout health and optionally auto-apply the configured advance or circuit-breaker action.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          rolloutId: Type.String({ minLength: 1 }),
          autoApply: Type.Optional(Type.Boolean()),
          publishRelease: Type.Optional(Type.Boolean()),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          await runtime.evaluateRollout({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            rolloutId: String(params.rolloutId),
            autoApply: params.autoApply === true,
            publishRelease: params.publishRelease !== false,
            operator: typeof params.operator === "string" ? params.operator : "agent",
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_route_resolve",
      label: "Release Route Resolve",
      description:
        "Resolve whether a request should use the stable channel pointer or an active rollout release.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          region: Type.Optional(Type.String({ minLength: 1 })),
          audience: Type.Optional(Type.String({ minLength: 1 })),
          bucketValue: Type.Optional(Type.Number({ minimum: 0, maximum: 99 })),
          subjectKey: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.resolveChannelRoute({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment:
              typeof params.environment === "string"
                ? (params.environment as ReleaseEnvironment)
                : undefined,
            channel:
              typeof params.channel === "string" ? (params.channel as ReleaseChannel) : undefined,
            region: typeof params.region === "string" ? params.region : undefined,
            audience: typeof params.audience === "string" ? params.audience : undefined,
            bucketValue: typeof params.bucketValue === "number" ? params.bucketValue : undefined,
            subjectKey: typeof params.subjectKey === "string" ? params.subjectKey : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_notifications_drain",
      label: "Release Notifications Drain",
      description: "Start the dedicated lobster notifier agent to process queued notifications.",
      parameters: Type.Object(
        {
          sessionKey: Type.Optional(Type.String({ minLength: 1 })),
          message: Type.Optional(Type.String({ minLength: 1 })),
          waitForCompletion: Type.Optional(Type.Boolean()),
          timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 300000 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        const sessionKey =
          (typeof params.sessionKey === "string" && params.sessionKey.trim()) ||
          config.notifierSessionKey ||
          DEFAULT_NOTIFIER_SESSION_KEY;
        const message =
          (typeof params.message === "string" && params.message.trim()) || DEFAULT_NOTIFIER_MESSAGE;
        const run = await runNotifierSubagent({
          sessionKey,
          message,
          extraSystemPrompt: buildNotifierSystemPrompt(config),
          lane: "subagent",
          deliver: false,
          idempotencyKey: `lobster-notifier:${sessionKey}:${Date.now()}`,
        });
        if (params.waitForCompletion === true) {
          const wait = await waitForNotifierRun({
            runId: run.runId,
            timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000,
          });
          return jsonToolResult({
            sessionKey,
            runId: run.runId,
            wait,
          });
        }
        return jsonToolResult({
          sessionKey,
          runId: run.runId,
        });
      },
    }),
    withRuntimeReady({
      name: "release_notifications_render",
      label: "Release Notifications Render",
      description: "Render a queued lobster release notification into a delivery plan.",
      parameters: Type.Object(
        {
          notificationId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(runtime.renderNotification(String(params.notificationId)));
      },
    }),
    withRuntimeReady({
      name: "release_notifications_pull",
      label: "Release Notifications Pull",
      description: "Claim pending lobster release notifications for delivery.",
      parameters: Type.Object(
        {
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
          includeFailed: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.pullNotifications({
            limit: typeof params.limit === "number" ? params.limit : 10,
            includeFailed: params.includeFailed === true,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_notifications_ack",
      label: "Release Notifications Ack",
      description: "Mark a lobster release notification as delivered.",
      parameters: Type.Object(
        {
          notificationId: Type.String({ minLength: 1 }),
          deliveryNote: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.markNotificationSent(String(params.notificationId), {
            deliveryNote: typeof params.deliveryNote === "string" ? params.deliveryNote : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_notifications_fail",
      label: "Release Notifications Fail",
      description: "Mark a lobster release notification as failed with an error.",
      parameters: Type.Object(
        {
          notificationId: Type.String({ minLength: 1 }),
          error: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.markNotificationFailed(String(params.notificationId), String(params.error)),
        );
      },
    }),
    withRuntimeReady({
      name: "release_notifications_requeue",
      label: "Release Notifications Requeue",
      description:
        "Manually requeue a lobster release notification after operator review or delivery recovery.",
      parameters: Type.Object(
        {
          notificationId: Type.String({ minLength: 1 }),
          reason: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.requeueNotification(String(params.notificationId), {
            reason: typeof params.reason === "string" ? params.reason : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_create",
      label: "Release Create",
      description: "Create a release and optionally trigger Jenkins build.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          version: Type.String({ minLength: 1 }),
          versionSource: Type.Optional(
            Type.Unsafe<"manual" | "suggested" | "enforced">({
              type: "string",
              enum: ["manual", "suggested", "enforced"],
            }),
          ),
          git: Type.Optional(
            Type.Object(
              {
                url: Type.Optional(Type.String()),
                branch: Type.Optional(Type.String()),
                commit: Type.Optional(Type.String()),
                tag: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
          targets: Type.Optional(TargetsSchema),
          scope: Type.Optional(
            Type.Object(
              {
                region: Type.Optional(Type.String({ minLength: 1 })),
                audience: Type.Optional(Type.String({ minLength: 1 })),
              },
              { additionalProperties: false },
            ),
          ),
          notes: Type.Optional(Type.String()),
          triggerBuild: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        const version = typeof params.version === "string" ? params.version : "";
        const result = await runtime.createRelease({
          projectKey: typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
          environment: (typeof params.environment === "string"
            ? params.environment
            : "staging") as ReleaseEnvironment,
          channel: (typeof params.channel === "string" ? params.channel : "beta") as ReleaseChannel,
          version,
          git:
            params.git && typeof params.git === "object"
              ? (params.git as { url?: string; branch?: string; commit?: string; tag?: string })
              : undefined,
          targets: normalizeTargets(params.targets),
          scope:
            params.scope && typeof params.scope === "object"
              ? {
                  region:
                    typeof (params.scope as Record<string, unknown>).region === "string"
                      ? ((params.scope as Record<string, unknown>).region as string)
                      : undefined,
                  audience:
                    typeof (params.scope as Record<string, unknown>).audience === "string"
                      ? ((params.scope as Record<string, unknown>).audience as string)
                      : undefined,
                }
              : undefined,
          notes: typeof params.notes === "string" ? params.notes : undefined,
          versionSource:
            typeof params.versionSource === "string"
              ? (params.versionSource as "manual" | "suggested" | "enforced")
              : undefined,
          triggerBuild: params.triggerBuild === true,
          createdBy: "agent",
        });
        return jsonToolResult(result);
      },
    }),
    withRuntimeReady({
      name: "release_trigger",
      label: "Release Trigger",
      description: "Manually trigger or retrigger a build for an existing release.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          releaseId: Type.String({ minLength: 1 }),
          rebuild: Type.Optional(Type.Boolean()),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          await runtime.triggerRelease({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            releaseId: String(params.releaseId),
            rebuild: params.rebuild === true,
            operator: typeof params.operator === "string" ? params.operator : "agent",
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_version_suggest",
      label: "Release Version Suggest",
      description: "Suggest the next version for a channel based on bump type.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          bumpType: Type.Unsafe<"patch" | "minor" | "major">({
            type: "string",
            enum: ["patch", "minor", "major"],
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.suggestVersion({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment: (typeof params.environment === "string"
              ? params.environment
              : "staging") as ReleaseEnvironment,
            channel: (typeof params.channel === "string"
              ? params.channel
              : "beta") as ReleaseChannel,
            bumpType: params.bumpType as "patch" | "minor" | "major",
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_store_status",
      label: "Release Store Status",
      description: "Inspect lobster-release schema version, counts, and retention settings.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.getStoreStatus(
            typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
          ),
        );
      },
    }),
    withRuntimeReady({
      name: "release_maintenance_run",
      label: "Release Maintenance Run",
      description:
        "Preview or execute lobster-release retention cleanup for artifacts, manifests, and audit records.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          dryRun: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          await runtime.runMaintenance({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            dryRun: params.dryRun !== false,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_build_status",
      label: "Release Build Status",
      description: "Inspect a build with its artifacts and provenance.",
      parameters: Type.Object(
        {
          buildId: Type.String({ minLength: 1 }),
          refreshJenkins: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        const buildId = String(params.buildId);
        return jsonToolResult({
          ...runtime.getBuildStatus(buildId),
          jenkinsStatus:
            params.refreshJenkins === true ? await runtime.pollJenkinsBuildStatus(buildId) : null,
        });
      },
    }),
    withRuntimeReady({
      name: "release_preflight",
      label: "Release Preflight",
      description: "Run a publish-readiness check for a release and its current build.",
      parameters: Type.Object(
        {
          releaseId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(runtime.runReleasePreflight(String(params.releaseId)));
      },
    }),
    withRuntimeReady({
      name: "release_status",
      label: "Release Status",
      description: "Get release details or current channel state.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          releaseId: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        if (typeof params.releaseId === "string") {
          return jsonToolResult(runtime.getRelease(params.releaseId));
        }
        const state = runtime.getChannelState(
          typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
          (typeof params.environment === "string"
            ? params.environment
            : "staging") as ReleaseEnvironment,
          (typeof params.channel === "string" ? params.channel : "beta") as ReleaseChannel,
        );
        return jsonToolResult(state);
      },
    }),
    withRuntimeReady({
      name: "release_generate_notes",
      label: "Release Generate Notes",
      description: "Generate archived or live release notes for a release.",
      parameters: Type.Object(
        {
          releaseId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(runtime.generateReleaseNotes(String(params.releaseId)));
      },
    }),
    withRuntimeReady({
      name: "release_stable_list",
      label: "Release Stable List",
      description: "List stable releases for a channel.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.listStableReleases({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment: (typeof params.environment === "string"
              ? params.environment
              : "staging") as ReleaseEnvironment,
            channel: (typeof params.channel === "string"
              ? params.channel
              : "beta") as ReleaseChannel,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_graph",
      label: "Release Graph",
      description: "Inspect release graph relations for a release or channel.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          releaseId: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        if (typeof params.releaseId === "string") {
          return jsonToolResult(
            runtime.getReleaseGraph(
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
              params.releaseId,
            ),
          );
        }
        return jsonToolResult(
          runtime.getChannelGraph(
            typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            (typeof params.environment === "string"
              ? params.environment
              : "staging") as ReleaseEnvironment,
            (typeof params.channel === "string" ? params.channel : "beta") as ReleaseChannel,
          ),
        );
      },
    }),
    withRuntimeReady({
      name: "release_channel_history",
      label: "Release Channel History",
      description: "Inspect release history and relation edges for a channel.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.getChannelHistory({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment: (typeof params.environment === "string"
              ? params.environment
              : "staging") as ReleaseEnvironment,
            channel: (typeof params.channel === "string"
              ? params.channel
              : "beta") as ReleaseChannel,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_provenance",
      label: "Release Provenance",
      description: "Inspect build provenance by build or release.",
      parameters: Type.Object(
        {
          buildId: Type.Optional(Type.String({ minLength: 1 })),
          releaseId: Type.Optional(Type.String({ minLength: 1 })),
          mode: Type.Optional(
            Type.Unsafe<"latest" | "all">({ type: "string", enum: ["latest", "all"] }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        if (typeof params.buildId === "string") {
          return jsonToolResult(runtime.getBuildProvenance(params.buildId));
        }
        if (typeof params.releaseId === "string") {
          return jsonToolResult(
            runtime.getReleaseProvenance(
              params.releaseId,
              params.mode === "all" ? "all" : "latest",
            ),
          );
        }
        throw new Error("buildId or releaseId is required");
      },
    }),
    withRuntimeReady({
      name: "release_baselines",
      label: "Release Baselines",
      description: "List resolved baselines for a channel and platform.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          platform: Type.Optional(Type.String({ minLength: 1 })),
          targetVersion: Type.Optional(Type.String({ minLength: 1 })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.listBaselines({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment: (typeof params.environment === "string"
              ? params.environment
              : "staging") as ReleaseEnvironment,
            channel: (typeof params.channel === "string"
              ? params.channel
              : "beta") as ReleaseChannel,
            platform: typeof params.platform === "string" ? params.platform : "patch",
            targetVersion:
              typeof params.targetVersion === "string" ? params.targetVersion : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_baseline_lineage",
      label: "Release Baseline Lineage",
      description: "Trace baseline inheritance for a version or release.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          platform: Type.Optional(Type.String({ minLength: 1 })),
          releaseId: Type.Optional(Type.String({ minLength: 1 })),
          version: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.getBaselineLineage({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment: (typeof params.environment === "string"
              ? params.environment
              : "staging") as ReleaseEnvironment,
            channel: (typeof params.channel === "string"
              ? params.channel
              : "beta") as ReleaseChannel,
            platform: typeof params.platform === "string" ? params.platform : "patch",
            releaseId: typeof params.releaseId === "string" ? params.releaseId : undefined,
            version: typeof params.version === "string" ? params.version : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_approve",
      label: "Release Approve",
      description: "Approve a built release for publish.",
      parameters: Type.Object(
        {
          releaseId: Type.String({ minLength: 1 }),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          await runtime.approveRelease(
            String(params.releaseId),
            typeof params.operator === "string" ? params.operator : "agent",
          ),
        );
      },
    }),
    withRuntimeReady({
      name: "release_promote",
      label: "Release Promote",
      description:
        "Promote a stable release into another environment/channel and publish it there.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          sourceReleaseId: Type.String({ minLength: 1 }),
          targetEnvironment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          targetChannel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          notes: Type.Optional(Type.String()),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          await runtime.promoteRelease({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            sourceReleaseId: String(params.sourceReleaseId),
            targetEnvironment: (typeof params.targetEnvironment === "string"
              ? params.targetEnvironment
              : "staging") as ReleaseEnvironment,
            targetChannel: (typeof params.targetChannel === "string"
              ? params.targetChannel
              : "release") as ReleaseChannel,
            notes: typeof params.notes === "string" ? params.notes : undefined,
            operator: typeof params.operator === "string" ? params.operator : "agent",
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_promote_history",
      label: "Release Promote History",
      description: "Inspect promote relations for a release or channel.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          releaseId: Type.Optional(Type.String({ minLength: 1 })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.getPromotionHistory({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment:
              typeof params.environment === "string"
                ? (params.environment as ReleaseEnvironment)
                : undefined,
            channel:
              typeof params.channel === "string" ? (params.channel as ReleaseChannel) : undefined,
            releaseId: typeof params.releaseId === "string" ? params.releaseId : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollback_audit",
      label: "Release Rollback Audit",
      description: "Inspect recorded rollback audit details for a project/environment/channel.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.getRollbackAudit({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment:
              typeof params.environment === "string"
                ? (params.environment as ReleaseEnvironment)
                : undefined,
            channel:
              typeof params.channel === "string" ? (params.channel as ReleaseChannel) : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollback_assist",
      label: "Release Rollback Assist",
      description: "Preview rollback candidates, compatibility, and the recommended target.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        return jsonToolResult(
          runtime.getRollbackPlan({
            projectKey:
              typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
            environment: (typeof params.environment === "string"
              ? params.environment
              : "staging") as ReleaseEnvironment,
            channel: (typeof params.channel === "string"
              ? params.channel
              : "beta") as ReleaseChannel,
          }),
        );
      },
    }),
    withRuntimeReady({
      name: "release_rollback",
      label: "Release Rollback",
      description: "Create and approve a rollback request for a channel.",
      parameters: Type.Object(
        {
          projectKey: Type.Optional(Type.String({ minLength: 1 })),
          environment: Type.Optional(
            Type.Unsafe<ReleaseEnvironment>({
              type: "string",
              enum: ["test", "staging", "production"],
            }),
          ),
          channel: Type.Optional(
            Type.Unsafe<ReleaseChannel>({ type: "string", enum: ["dev", "beta", "release"] }),
          ),
          targetReleaseId: Type.String({ minLength: 1 }),
          reason: Type.String({ minLength: 1 }),
          strategy: Type.Optional(
            Type.Unsafe<"pointer_switch" | "manifest_republish" | "rebuild_and_publish">({
              type: "string",
              enum: ["pointer_switch", "manifest_republish", "rebuild_and_publish"],
            }),
          ),
          freezeCurrentRelease: Type.Optional(Type.Boolean()),
          autoApprove: Type.Optional(Type.Boolean()),
          operator: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Record<string, unknown>;
        const rollback = await runtime.createRollback({
          projectKey: typeof params.projectKey === "string" ? params.projectKey : defaultProjectKey,
          environment: (typeof params.environment === "string"
            ? params.environment
            : "staging") as ReleaseEnvironment,
          channel: (typeof params.channel === "string" ? params.channel : "beta") as ReleaseChannel,
          targetReleaseId: String(params.targetReleaseId),
          reason: String(params.reason),
          strategy: (typeof params.strategy === "string" ? params.strategy : "pointer_switch") as
            | "pointer_switch"
            | "manifest_republish"
            | "rebuild_and_publish",
          freezeCurrentRelease: params.freezeCurrentRelease !== false,
          operator: typeof params.operator === "string" ? params.operator : "agent",
        });
        if (params.autoApprove === false) {
          return jsonToolResult({ requested: rollback, completed: null });
        }
        const completed = await runtime.approveRollback(
          rollback.rollbackId,
          typeof params.operator === "string" ? params.operator : "agent",
        );
        return jsonToolResult({ requested: rollback, completed });
      },
    }),
  ];
}

const plugin = {
  id: "lobster-release",
  name: "Lobster Release",
  description: "Release center for Godot build, patch, rollback, and approval workflows.",
  register(api: OpenClawPluginApi) {
    const config = resolveLobsterReleaseConfig(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir();
    const store = new LobsterReleaseStore(
      path.join(stateDir, "plugins", "lobster-release", "lobster-release.sqlite"),
    );
    const runtime = new LobsterReleaseRuntime(store, config, api.logger, stateDir);

    api.registerTool(() => createTools(runtime, config.defaultProjectKey, api.runtime, config), {
      names: [
        "release_project_catalog",
        "release_gray_plan",
        "release_rollout_list",
        "release_rollout_create",
        "release_rollout_advance",
        "release_rollout_cancel",
        "release_rollout_status",
        "release_rollout_observe",
        "release_rollout_evaluate",
        "release_route_resolve",
        "release_notifications_drain",
        "release_notifications_render",
        "release_notifications_pull",
        "release_notifications_ack",
        "release_notifications_fail",
        "release_notifications_requeue",
        "release_build_status",
        "release_preflight",
        "release_create",
        "release_trigger",
        "release_version_suggest",
        "release_store_status",
        "release_maintenance_run",
        "release_status",
        "release_generate_notes",
        "release_stable_list",
        "release_graph",
        "release_channel_history",
        "release_provenance",
        "release_baselines",
        "release_baseline_lineage",
        "release_approve",
        "release_promote",
        "release_promote_history",
        "release_rollback_audit",
        "release_rollback_assist",
        "release_rollback",
      ],
    });

    api.registerHttpRoute({
      path: config.routePrefix,
      auth: "plugin",
      match: "prefix",
      handler: createLobsterReleaseHttpHandler({
        runtime,
        config,
        logger: api.logger,
      }),
    });

    api.registerHttpRoute({
      path: config.ciRoutePrefix,
      auth: "plugin",
      match: "prefix",
      handler: createLobsterReleaseHttpHandler({
        runtime,
        config,
        logger: api.logger,
      }),
    });

    api.registerService({
      id: "lobster-release",
      start: async () => {
        await runtime.start();
        api.logger.info("lobster-release: service started");
      },
      stop: async () => {
        runtime.stop();
      },
    });
  },
};

export default plugin;
