import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/lobster";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { __testing } from "./index.js";

const tempDirs: string[] = [];

async function createPluginTools(): Promise<AnyAgentTool[]> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-release-plugin-"));
  tempDirs.push(stateDir);

  let toolFactory: ((ctx: { sessionKey?: string }) => unknown) | null = null;

  const api = {
    id: "lobster-release",
    name: "Lobster Release",
    source: "test",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig: {
      defaultProjectKey: "gamexpert",
      publicBaseUrl: "https://release.example.com",
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      subagent: {
        run: async () => ({ runId: "run_test" }),
        waitForRun: async () => ({ status: "ok" as const }),
        getSessionMessages: async () => ({ messages: [] }),
        getSession: async () => ({ messages: [] }),
        deleteSession: async () => {},
      },
    } as unknown as OpenClawPluginApi["runtime"],
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    registerTool(tool) {
      if (typeof tool === "function") {
        toolFactory = tool;
      }
    },
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
  } as unknown as OpenClawPluginApi;

  plugin.register(api);
  const tools = toolFactory?.({
    sessionKey: "main",
  });
  return Array.isArray(tools)
    ? (tools as AnyAgentTool[])
    : tools
      ? ([tools] as AnyAgentTool[])
      : [];
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("lobster-release plugin tools", () => {
  it("starts runtime lazily before tool execution", async () => {
    const tools = await createPluginTools();
    const tool = tools.find((entry) => entry.name === "release_status");
    expect(tool).toBeTruthy();

    const result = await tool!.execute?.("test-call", {
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
    });

    expect(result).toBeTruthy();
    expect(result?.details).toBeNull();
  });

  it("builds a notifier prompt that distinguishes explicit and session-bound delivery", () => {
    const prompt = __testing.buildNotifierSystemPrompt({
      defaultProjectKey: "gamexpert",
      routePrefix: "/plugins/lobster-release/api",
      ciRoutePrefix: "/api/ci/v1",
      notifierSessionKey: "agent:pm:main",
      autoPublishDev: true,
      defaultEnvironment: "staging",
      defaultChannel: "beta",
    });

    expect(prompt).toContain("mode=explicit_target");
    expect(prompt).toContain("mode=session_bound");
    expect(prompt).toContain(
      "Only call release_notifications_ack after the notification message is actually sent",
    );
    expect(prompt).toContain("If the required delivery primitive is unavailable");
  });
});
