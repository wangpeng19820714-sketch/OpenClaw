import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import type { Mem0Memory } from "./client.js";
import { Mem0Client } from "./client.js";
import { mem0ConfigSchema } from "./config.js";

type Scope = "session" | "long-term" | "all";
type StoreMode = "raw" | "smart";

function parseAgentSessionKey(sessionKey?: string): { agentId?: string } {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return {};
  }
  const match = /^agent:([^:]+)/.exec(trimmed);
  return match ? { agentId: match[1] } : {};
}

function resolveUserId(
  configUserId: string | undefined,
  params: {
    agentId?: string;
    sessionKey?: string;
  },
): string {
  if (configUserId) {
    return configUserId;
  }
  const agentId = params.agentId?.trim() || parseAgentSessionKey(params.sessionKey).agentId;
  return `openclaw:${agentId || "default"}`;
}

function resolveRunId(params: {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): string {
  if (params.sessionKey?.trim()) {
    return params.sessionKey.trim();
  }
  if (params.sessionId?.trim()) {
    return params.sessionId.trim();
  }
  return `session:${params.agentId?.trim() || "default"}`;
}

function formatMemoryLine(memory: Mem0Memory): string {
  const id = memory.id?.trim() ? memory.id : "unknown";
  const score = typeof memory.score === "number" ? ` score=${memory.score.toFixed(3)}` : "";
  return `- [${id}] ${memory.text}${score}`;
}

function getScopeIds(
  scope: Scope,
  params: {
    userId: string;
    runId: string;
  },
) {
  return {
    userId: scope === "session" ? undefined : params.userId,
    runId: scope === "long-term" ? undefined : params.runId,
  };
}

async function storeMemory(
  input: {
    client: Mem0Client;
    userId: string;
    runId: string;
  },
  params: {
    text: string;
    scope?: "session" | "long-term";
    mode?: StoreMode;
  },
) {
  const scope = params.scope ?? "long-term";
  const text = params.text.trim();
  if (!text) {
    return {
      content: [{ type: "text", text: "Memory text is empty." }],
      isError: true,
    };
  }

  const mode = params.mode ?? "raw";
  await input.client.addMessages({
    messages: [{ role: "user", content: text }],
    userId: scope === "long-term" ? input.userId : undefined,
    runId: scope === "session" ? input.runId : undefined,
    infer: mode === "smart",
  });

  return {
    content: [
      {
        type: "text",
        text: `Stored memory in ${scope} scope using ${mode === "smart" ? "upstream smart extraction" : "raw direct"} mode.`,
      },
    ],
    details: { stored: true, scope, mode },
  };
}

function createMemoryTools(input: {
  client: Mem0Client;
  userId: string;
  runId: string;
  topK: number;
}) {
  return [
    {
      name: "memory_search",
      label: "Mem0 Search",
      description: "Search upstream Mem0 memories from session scope, long-term scope, or both.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        scope: Type.Optional(
          Type.Unsafe<Scope>({
            type: "string",
            enum: ["session", "long-term", "all"],
          }),
        ),
        limit: Type.Optional(Type.Number({ description: "Maximum results per scope" })),
      }),
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as { query: string; scope?: Scope; limit?: number };
        const scope = params.scope ?? "all";
        const limit =
          typeof params.limit === "number" && Number.isFinite(params.limit)
            ? Math.max(1, Math.floor(params.limit))
            : input.topK;

        const ids = getScopeIds(scope, input);
        const [longTerm, session] = await Promise.all([
          ids.userId
            ? input.client.search({ query: params.query, userId: ids.userId, limit })
            : Promise.resolve([]),
          ids.runId
            ? input.client.search({ query: params.query, runId: ids.runId, limit })
            : Promise.resolve([]),
        ]);

        const merged = [...longTerm, ...session];
        if (merged.length === 0) {
          return {
            content: [{ type: "text", text: "No Mem0 memories found." }],
            details: { count: 0, scope },
          };
        }

        const text = [
          ...(longTerm.length > 0 ? ["Long-term:", ...longTerm.map(formatMemoryLine)] : []),
          ...(session.length > 0 ? ["Session:", ...session.map(formatMemoryLine)] : []),
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: { count: merged.length, scope, longTerm, session },
        };
      },
    },
    {
      name: "memory_store",
      label: "Mem0 Store",
      description:
        "Store one fact in upstream Mem0. Defaults to raw direct write for guaranteed persistence, or set mode=smart to use upstream extraction/dedup.",
      parameters: Type.Object({
        text: Type.String({ description: "Memory content" }),
        scope: Type.Optional(
          Type.Unsafe<Exclude<Scope, "all">>({
            type: "string",
            enum: ["session", "long-term"],
          }),
        ),
        mode: Type.Optional(
          Type.Unsafe<StoreMode>({
            type: "string",
            enum: ["raw", "smart"],
          }),
        ),
      }),
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as {
          text: string;
          scope?: "session" | "long-term";
          mode?: StoreMode;
        };
        return storeMemory(input, params);
      },
    },
    {
      name: "memory_store_smart",
      label: "Mem0 Store Smart",
      description:
        "Store memory through upstream Mem0 smart extraction, deduplication, and merge logic.",
      parameters: Type.Object({
        text: Type.String({ description: "Memory content" }),
        scope: Type.Optional(
          Type.Unsafe<Exclude<Scope, "all">>({
            type: "string",
            enum: ["session", "long-term"],
          }),
        ),
      }),
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as { text: string; scope?: "session" | "long-term" };
        return storeMemory(input, {
          ...params,
          mode: "smart",
        });
      },
    },
    {
      name: "memory_list",
      label: "Mem0 List",
      description: "List upstream Mem0 memories from session scope, long-term scope, or both.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.Unsafe<Scope>({
            type: "string",
            enum: ["session", "long-term", "all"],
          }),
        ),
        limit: Type.Optional(Type.Number({ description: "Maximum results per scope" })),
      }),
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as { scope?: Scope; limit?: number };
        const scope = params.scope ?? "all";
        const limit =
          typeof params.limit === "number" && Number.isFinite(params.limit)
            ? Math.max(1, Math.floor(params.limit))
            : input.topK;

        const ids = getScopeIds(scope, input);
        const [longTerm, session] = await Promise.all([
          ids.userId ? input.client.list({ userId: ids.userId, limit }) : Promise.resolve([]),
          ids.runId ? input.client.list({ runId: ids.runId, limit }) : Promise.resolve([]),
        ]);

        const merged = [...longTerm, ...session];
        if (merged.length === 0) {
          return {
            content: [{ type: "text", text: "No Mem0 memories found." }],
            details: { count: 0, scope },
          };
        }

        const text = [
          ...(longTerm.length > 0 ? ["Long-term:", ...longTerm.map(formatMemoryLine)] : []),
          ...(session.length > 0 ? ["Session:", ...session.map(formatMemoryLine)] : []),
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: { count: merged.length, scope, longTerm, session },
        };
      },
    },
  ];
}

const memoryPlugin = {
  id: "mem0",
  name: "Mem0",
  description: "Thin OpenClaw bridge for an external upstream Mem0 server.",
  kind: "memory" as const,
  configSchema: mem0ConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = mem0ConfigSchema.parse(api.pluginConfig);
    const client = new Mem0Client({
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
    });

    api.logger.info(`mem0: plugin registered (baseUrl: ${config.baseUrl})`);

    api.registerTool(
      (toolCtx) => {
        const userId = resolveUserId(config.userId, toolCtx);
        const runId = resolveRunId(toolCtx);
        return createMemoryTools({
          client,
          userId,
          runId,
          topK: config.topK,
        });
      },
      { names: ["memory_search", "memory_store", "memory_store_smart", "memory_list"] },
    );
  },
};

export default memoryPlugin;
