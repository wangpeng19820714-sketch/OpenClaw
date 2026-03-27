import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockServerResponse } from "../../src/test-utils/mock-http-response.js";
import { resolveLobsterReleaseConfig } from "./config.js";
import { createLobsterReleaseHttpHandler } from "./http.js";
import { LobsterReleaseRuntime } from "./runtime.js";
import { LobsterReleaseStore } from "./store.js";

const tempDirs: string[] = [];

async function createHarness(configOverrides: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-release-http-"));
  tempDirs.push(dir);
  const config = resolveLobsterReleaseConfig({
    defaultProjectKey: "gamexpert",
    publicBaseUrl: "https://release.example.com",
    ciRoutePrefix: "/api/ci/v1",
    routePrefix: "/plugins/lobster-release/api",
    callbackToken: "callback-secret",
    ...configOverrides,
  });
  const runtime = new LobsterReleaseRuntime(
    new LobsterReleaseStore(path.join(dir, "lobster.sqlite")),
    config,
    {
      info() {},
      warn() {},
      error() {},
    },
    dir,
  );
  await runtime.start();
  const handler = createLobsterReleaseHttpHandler({
    runtime,
    config,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });
  return { runtime, config, handler };
}

function createRequest(params: {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
  };
  req.method = params.method;
  req.url = params.url;
  req.headers = params.headers ?? {};
  req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
  req.destroy = (() => req) as IncomingMessage["destroy"];
  if (typeof params.body === "string") {
    void Promise.resolve().then(() => {
      req.emit("data", Buffer.from(params.body, "utf8"));
      req.emit("end");
    });
  }
  return req;
}

function signCallback(body: string, nonce: string, token: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", token)
    .update(`${timestamp}\n${nonce}\n${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": `sha256=${signature}`,
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("lobster-release http handler", () => {
  it("serves project catalog and gray plan endpoints", async () => {
    const { handler } = await createHarness({
      projects: {
        projectb: {
          defaultEnvironment: "production",
          defaultChannel: "release",
          environments: ["staging", "production"],
          channels: ["beta", "release"],
          regions: ["cn"],
          audiences: ["internal"],
          grayRelease: {
            enabled: true,
            rolloutPercentages: [10, 50, 100],
            stickiness: "account",
          },
          smokeWorkflows: ["install-smoke"],
        },
      },
    });

    const catalogRes = createMockServerResponse();
    await handler(
      createRequest({ method: "GET", url: "/plugins/lobster-release/api/projects" }),
      catalogRes,
    );
    expect(catalogRes.statusCode).toBe(200);
    expect(String(catalogRes.body)).toContain('"projectKey": "projectb"');

    const grayRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "GET",
        url: "/plugins/lobster-release/api/projects/projectb/channels/release/gray-plan?environment=production&region=cn&audience=internal",
      }),
      grayRes,
    );
    expect(grayRes.statusCode).toBe(200);
    expect(String(grayRes.body)).toContain('"enabled": true');
    expect(String(grayRes.body)).toContain('"stickiness": "account"');
  });

  it("creates releases through the API and serves release graph", async () => {
    const { handler, runtime } = await createHarness();
    const createRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: "/plugins/lobster-release/api/projects/gamexpert/releases",
        body: JSON.stringify({
          environment: "staging",
          channel: "beta",
          version: "1.0.0",
          targets: { androidApk: true },
        }),
        headers: { "content-type": "application/json" },
      }),
      createRes,
    );
    expect(createRes.statusCode).toBe(200);

    const releaseOne = runtime.listStableReleases({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
    });
    expect(releaseOne).toHaveLength(0);

    const created = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.0.1",
      targets: { androidApk: true, androidAab: false, macosApp: false, patch: false },
      triggerBuild: false,
      createdBy: "test",
    });
    const graphRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "GET",
        url: `/plugins/lobster-release/api/projects/gamexpert/releases/${created.release.releaseId}/graph`,
      }),
      graphRes,
    );
    expect(graphRes.statusCode).toBe(200);
    expect(String(graphRes.body)).toContain('"nodes"');
    expect(String(graphRes.body)).toContain('"edges"');
  });

  it("rejects replayed signed callback nonces and supports maintenance endpoints", async () => {
    const { handler, runtime, config } = await createHarness();
    const created = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.3",
      targets: { androidApk: true, androidAab: false, macosApp: false, patch: false },
      triggerBuild: true,
      createdBy: "test",
    });
    const buildId = created.build?.buildId;
    expect(buildId).toBeTruthy();

    const body = JSON.stringify({
      jenkinsJob: "GameXpert_Godot_CI",
      jenkinsBuildNumber: 42,
      idempotencyKey: "signed-start-1",
    });
    const nonce = "nonce-1";
    const signedHeaders = signCallback(body, nonce, config.callbackToken ?? "");

    const firstRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: `/plugins/lobster-release/api/projects/gamexpert/builds/${buildId}/start`,
        body,
        headers: signedHeaders,
      }),
      firstRes,
    );
    expect(firstRes.statusCode).toBe(200);

    const secondRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: `/plugins/lobster-release/api/projects/gamexpert/builds/${buildId}/start`,
        body: JSON.stringify({
          jenkinsJob: "GameXpert_Godot_CI",
          jenkinsBuildNumber: 42,
          idempotencyKey: "signed-start-2",
        }),
        headers: signCallback(
          JSON.stringify({
            jenkinsJob: "GameXpert_Godot_CI",
            jenkinsBuildNumber: 42,
            idempotencyKey: "signed-start-2",
          }),
          nonce,
          config.callbackToken ?? "",
        ),
      }),
      secondRes,
    );
    expect(secondRes.statusCode).toBe(409);
    expect(String(secondRes.body)).toContain("replayed nonce");

    const storeRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "GET",
        url: "/plugins/lobster-release/api/projects/gamexpert/store/status",
      }),
      storeRes,
    );
    expect(storeRes.statusCode).toBe(200);
    expect(String(storeRes.body)).toContain('"schemaVersion": 1');

    const maintenanceRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: "/plugins/lobster-release/api/projects/gamexpert/maintenance/run",
        body: JSON.stringify({ dryRun: true }),
        headers: { "content-type": "application/json" },
      }),
      maintenanceRes,
    );
    expect(maintenanceRes.statusCode).toBe(200);
    expect(String(maintenanceRes.body)).toContain('"dryRun": true');
  });
});
