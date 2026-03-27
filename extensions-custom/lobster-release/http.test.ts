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

  it("manages rollout routes through the API", async () => {
    const { handler, runtime } = await createHarness({
      defaultProjectKey: "projectb",
      projects: {
        projectb: {
          defaultEnvironment: "production",
          defaultChannel: "release",
          environments: ["production"],
          channels: ["release"],
          regions: ["cn"],
          audiences: ["internal"],
          grayRelease: {
            enabled: true,
            rolloutPercentages: [10, 50, 100],
            stickiness: "account",
            monitoring: {
              enabled: true,
              minSampleSize: 100,
              minSuccessRate: 0.9,
              maxErrorRate: 0.08,
              maxCrashRate: 0.02,
              autoAdvance: true,
              autoAdvanceAfterMinutes: 0,
              publishOnComplete: true,
              circuitBreakerAction: "pause",
            },
          },
        },
      },
    });

    const stable = await runtime.createRelease({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      version: "1.0.0",
      targets: { androidApk: false, androidAab: true, macosApp: false, patch: false },
      triggerBuild: true,
      createdBy: "test",
    });
    runtime.recordBuildStart(stable.build!.buildId, {
      jenkinsBuildNumber: 30,
      jenkinsJob: "GameXpert_Godot_CI",
    });
    await runtime.recordBuildPublish(stable.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_aab",
          platform: "android",
          fileName: "ProjectB-android-aab-1.0.0-30.aab",
          fileSizeBytes: 100,
          sha256: "stable",
          storageProvider: "s3",
          storagePath: "releases/1.0.0-30/ProjectB-android-aab-1.0.0-30.aab",
        },
      ],
    });
    await runtime.recordBuildFinish(stable.build!.buildId, { status: "success" });
    await runtime.approveRelease(stable.release.releaseId, "approver");

    const candidate = await runtime.createRelease({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      version: "1.0.1",
      targets: { androidApk: false, androidAab: true, macosApp: false, patch: false },
      triggerBuild: true,
      createdBy: "test",
    });
    runtime.recordBuildStart(candidate.build!.buildId, {
      jenkinsBuildNumber: 31,
      jenkinsJob: "GameXpert_Godot_CI",
    });
    await runtime.recordBuildPublish(candidate.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_aab",
          platform: "android",
          fileName: "ProjectB-android-aab-1.0.1-31.aab",
          fileSizeBytes: 100,
          sha256: "candidate",
          storageProvider: "s3",
          storagePath: "releases/1.0.1-31/ProjectB-android-aab-1.0.1-31.aab",
        },
      ],
    });
    await runtime.recordBuildFinish(candidate.build!.buildId, { status: "success" });

    const createRolloutRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: "/plugins/lobster-release/api/projects/projectb/channels/release/rollouts",
        body: JSON.stringify({
          environment: "production",
          releaseId: candidate.release.releaseId,
          trafficPercent: 10,
          scope: { region: "cn", audience: "internal" },
        }),
        headers: { "content-type": "application/json" },
      }),
      createRolloutRes,
    );
    expect(createRolloutRes.statusCode).toBe(200);
    const rolloutId = JSON.parse(String(createRolloutRes.body)).data.rolloutId as string;

    const listRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "GET",
        url: "/plugins/lobster-release/api/projects/projectb/channels/release/rollouts?environment=production",
      }),
      listRes,
    );
    expect(listRes.statusCode).toBe(200);
    expect(String(listRes.body)).toContain(rolloutId);

    const routeRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "GET",
        url: "/plugins/lobster-release/api/projects/projectb/channels/release/route?environment=production&region=cn&audience=internal&bucket=5",
      }),
      routeRes,
    );
    expect(routeRes.statusCode).toBe(200);
    expect(String(routeRes.body)).toContain('"route": "rollout"');

    const observeRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: `/plugins/lobster-release/api/projects/projectb/rollouts/${rolloutId}/observe`,
        body: JSON.stringify({
          sampleSize: 200,
          successCount: 194,
          errorCount: 6,
          source: "http-test-monitor",
        }),
        headers: { "content-type": "application/json" },
      }),
      observeRes,
    );
    expect(observeRes.statusCode).toBe(200);
    expect(String(observeRes.body)).toContain('"health": "healthy"');

    const statusRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "GET",
        url: `/plugins/lobster-release/api/projects/projectb/rollouts/${rolloutId}/status`,
      }),
      statusRes,
    );
    expect(statusRes.statusCode).toBe(200);
    expect(String(statusRes.body)).toContain('"nextTrafficPercent": 50');

    const evaluateRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: `/plugins/lobster-release/api/projects/projectb/rollouts/${rolloutId}/evaluate`,
        body: JSON.stringify({
          autoApply: true,
        }),
        headers: { "content-type": "application/json" },
      }),
      evaluateRes,
    );
    expect(evaluateRes.statusCode).toBe(200);
    expect(String(evaluateRes.body)).toContain('"type": "advance"');

    const advanceRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: `/plugins/lobster-release/api/projects/projectb/rollouts/${rolloutId}/advance`,
        body: JSON.stringify({
          trafficPercent: 100,
          complete: true,
          publishRelease: true,
        }),
        headers: { "content-type": "application/json" },
      }),
      advanceRes,
    );
    expect(advanceRes.statusCode).toBe(200);
    expect(String(advanceRes.body)).toContain('"status": "completed"');

    const cancelRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: `/plugins/lobster-release/api/projects/projectb/rollouts/${rolloutId}/cancel`,
        body: JSON.stringify({
          reason: "no-op after completion",
        }),
        headers: { "content-type": "application/json" },
      }),
      cancelRes,
    );
    expect(cancelRes.statusCode).toBe(200);
  });

  it("ticks rollout monitoring through the API", async () => {
    const { handler, runtime } = await createHarness({
      defaultProjectKey: "projectb",
      projects: {
        projectb: {
          defaultEnvironment: "production",
          defaultChannel: "release",
          environments: ["production"],
          channels: ["release"],
          grayRelease: {
            enabled: true,
            rolloutPercentages: [10, 50, 100],
            stickiness: "account",
            monitoring: {
              enabled: true,
              minSampleSize: 100,
              minSuccessRate: 0.9,
              maxErrorRate: 0.08,
              maxCrashRate: 0.02,
              autoAdvance: true,
              autoAdvanceAfterMinutes: 0,
              publishOnComplete: true,
              circuitBreakerAction: "pause",
            },
          },
        },
      },
    });

    const stable = await runtime.createRelease({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      version: "2.1.0",
      targets: { androidApk: false, androidAab: true, macosApp: false, patch: false },
      triggerBuild: true,
      createdBy: "test",
    });
    runtime.recordBuildStart(stable.build!.buildId, {
      jenkinsBuildNumber: 70,
      jenkinsJob: "GameXpert_Godot_CI",
    });
    await runtime.recordBuildPublish(stable.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_aab",
          platform: "android",
          fileName: "ProjectB-android-aab-2.1.0-70.aab",
          fileSizeBytes: 100,
          sha256: "stable-api-tick",
          storageProvider: "s3",
          storagePath: "releases/2.1.0-70/ProjectB-android-aab-2.1.0-70.aab",
        },
      ],
    });
    await runtime.recordBuildFinish(stable.build!.buildId, { status: "success" });
    await runtime.approveRelease(stable.release.releaseId, "approver");

    const candidate = await runtime.createRelease({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      version: "2.1.1",
      targets: { androidApk: false, androidAab: true, macosApp: false, patch: false },
      triggerBuild: true,
      createdBy: "test",
    });
    runtime.recordBuildStart(candidate.build!.buildId, {
      jenkinsBuildNumber: 71,
      jenkinsJob: "GameXpert_Godot_CI",
    });
    await runtime.recordBuildPublish(candidate.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_aab",
          platform: "android",
          fileName: "ProjectB-android-aab-2.1.1-71.aab",
          fileSizeBytes: 100,
          sha256: "candidate-api-tick",
          storageProvider: "s3",
          storagePath: "releases/2.1.1-71/ProjectB-android-aab-2.1.1-71.aab",
        },
      ],
    });
    await runtime.recordBuildFinish(candidate.build!.buildId, { status: "success" });
    const rollout = await runtime.createRollout({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      releaseId: candidate.release.releaseId,
      trafficPercent: 10,
      operator: "ops",
    });

    const tickRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: `/plugins/lobster-release/api/projects/projectb/rollouts/${rollout.rolloutId}/tick`,
        body: JSON.stringify({
          autoApply: true,
          observation: {
            sampleSize: 120,
            successCount: 116,
            errorCount: 4,
            source: "api-tick-monitor",
          },
        }),
        headers: { "content-type": "application/json" },
      }),
      tickRes,
    );
    expect(tickRes.statusCode).toBe(200);
    expect(String(tickRes.body)).toContain('"type": "advance"');

    const batchTickRes = createMockServerResponse();
    await handler(
      createRequest({
        method: "POST",
        url: "/plugins/lobster-release/api/projects/projectb/channels/release/rollouts/tick",
        body: JSON.stringify({
          environment: "production",
          autoApply: true,
        }),
        headers: { "content-type": "application/json" },
      }),
      batchTickRes,
    );
    expect(batchTickRes.statusCode).toBe(200);
    expect(String(batchTickRes.body)).toContain('"processed": 1');
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
