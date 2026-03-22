import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/lobster";
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

function createTools(runtime: LobsterReleaseRuntime, defaultProjectKey: string): AnyAgentTool[] {
  return [
    {
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
          notes: typeof params.notes === "string" ? params.notes : undefined,
          triggerBuild: params.triggerBuild === true,
          createdBy: "agent",
        });
        return jsonToolResult(result);
      },
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
        return jsonToolResult(rollback);
      },
    },
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

    api.registerTool(() => createTools(runtime, config.defaultProjectKey), {
      names: [
        "release_create",
        "release_status",
        "release_graph",
        "release_provenance",
        "release_approve",
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
