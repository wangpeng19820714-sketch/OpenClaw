import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLobsterReleaseConfig } from "./config.js";
import { LobsterReleaseRuntime } from "./runtime.js";
import { LobsterReleaseStore } from "./store.js";

const tempDirs: string[] = [];

async function createRuntime() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-release-"));
  tempDirs.push(dir);
  const store = new LobsterReleaseStore(path.join(dir, "lobster.sqlite"));
  const runtime = new LobsterReleaseRuntime(
    store,
    resolveLobsterReleaseConfig({
      defaultProjectKey: "gamexpert",
      publicBaseUrl: "https://release.example.com",
    }),
    {
      info() {},
      warn() {},
      error() {},
    },
    dir,
  );
  await runtime.start();
  return runtime;
}

async function createRuntimeWithConfig(overrides: Record<string, unknown>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-release-"));
  tempDirs.push(dir);
  const store = new LobsterReleaseStore(path.join(dir, "lobster.sqlite"));
  const runtime = new LobsterReleaseRuntime(
    store,
    resolveLobsterReleaseConfig({
      defaultProjectKey: "gamexpert",
      publicBaseUrl: "https://release.example.com",
      ...overrides,
    }),
    {
      info() {},
      warn() {},
      error() {},
    },
    dir,
  );
  await runtime.start();
  return runtime;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("lobster-release runtime", () => {
  it("creates release, triggers build, finishes, approves, and rolls back", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.3",
      git: {
        branch: "main",
        commit: "8de107b1234567890",
      },
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: true,
      createdBy: "tester",
    });

    expect(created.release.version).toBe("1.2.3");
    expect(created.build?.buildId).toBeTruthy();

    runtime.recordBuildStart(created.build!.buildId, {
      jenkinsBuildNumber: 42,
      jenkinsJob: "GameXpert_Godot_CI",
    });

    const publish = await runtime.recordBuildPublish(created.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_apk",
          platform: "android",
          fileName: "GameXpert-android-apk-1.2.3-42.apk",
          fileSizeBytes: 100,
          sha256: "abc",
          storageProvider: "s3",
          storagePath: "gamexpert/staging/beta/1.2.3/android/GameXpert-android-apk-1.2.3-42.apk",
        },
        {
          artifactType: "patch_manifest",
          manifestRole: "patch_manifest",
          platform: "android",
          fileName: "manifest.json",
          fileSizeBytes: 50,
          sha256: "def",
          storageProvider: "s3",
          storagePath: "gamexpert/staging/beta/1.2.3/patch/manifest.json",
        },
        {
          artifactType: "patch_bundle",
          platform: "android",
          fileName: "GameXpert-patch-bundle-1.2.3-42-8de107b.zip",
          fileSizeBytes: 75,
          sha256: "ghi",
          storageProvider: "s3",
          storagePath:
            "gamexpert/staging/beta/1.2.3/patch/GameXpert-patch-bundle-1.2.3-42-8de107b.zip",
        },
      ],
    });

    expect(publish.manifest.project).toBe("gamexpert");

    const finished = await runtime.recordBuildFinish(created.build!.buildId, {
      status: "success",
    });
    expect(finished.release.status).toBe("awaiting_approval");

    const approved = await runtime.approveRelease(created.release.releaseId, "approver");
    expect(approved.status).toBe("published");
    const approvedManifestPath = runtime.getManifestFilePath(
      "gamexpert",
      "staging",
      "beta",
      "1.2.3",
    );
    const approvedManifest = JSON.parse(await fs.readFile(approvedManifestPath, "utf8")) as {
      stable: boolean;
      publishedAt?: string;
    };
    expect(approvedManifest.stable).toBe(true);
    expect(approvedManifest.publishedAt).toBeTruthy();

    const rollbackCandidate = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.4",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: false,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    const rollbackBuild = await runtime.triggerRelease({
      projectKey: "gamexpert",
      releaseId: rollbackCandidate.release.releaseId,
      operator: "tester",
    });
    await runtime.recordBuildFinish(rollbackBuild.buildId, { status: "success" });
    await runtime.approveRelease(rollbackCandidate.release.releaseId, "approver");

    const rollback = await runtime.createRollback({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      targetReleaseId: created.release.releaseId,
      reason: "incident",
      strategy: "pointer_switch",
      freezeCurrentRelease: true,
      operator: "ops",
    });
    const completed = await runtime.approveRollback(rollback.rollbackId, "ops");
    expect(completed.status).toBe("completed");

    const channelState = runtime.getChannelState("gamexpert", "staging", "beta");
    expect(channelState?.currentReleaseId).toBe(created.release.releaseId);
  });

  it("accepts Jenkins CI callback payloads with the existing lobster contract", async () => {
    const runtime = await createRuntime();

    const baseline = runtime.resolveCiBaseline({
      requestId: "jenkins-GameXpert_Godot_CI-28-resolve-baseline",
      jobName: "GameXpert_Godot_CI",
      buildNumber: 28,
      target: "patch",
      targets: ["patch"],
      git: {
        url: "git@github.com:example/GameXpert_Godot.git",
        branch: "main",
        commit: "0123456789abcdef",
        shortCommit: "0123456",
      },
      app: {
        appVersion: "0.0.1",
        resourceVersion: "0.0.1",
        platform: "android",
        channel: "default",
      },
    });
    expect(baseline.strategy).toBe("full");

    const started = runtime.recordCiBuildStart({
      requestId: "jenkins-GameXpert_Godot_CI-28-start",
      jobName: "GameXpert_Godot_CI",
      buildNumber: 28,
      pipelineUrl: "http://jenkins/job/GameXpert_Godot_CI/28/",
      targets: ["patch", "android_apk"],
      git: {
        url: "git@github.com:example/GameXpert_Godot.git",
        branch: "main",
        commit: "0123456789abcdef",
        shortCommit: "0123456",
      },
      app: {
        appVersion: "0.0.1",
        resourceVersion: "0.0.1",
        platform: "android",
        channel: "default",
      },
      baseline: {
        strategy: baseline.strategy,
        baselineVersion: baseline.baselineVersion,
      },
    });
    expect(started.jenkinsBuildNumber).toBe(28);

    const published = await runtime.recordCiBuildPublish({
      requestId: "jenkins-GameXpert_Godot_CI-28-publish",
      jobName: "GameXpert_Godot_CI",
      buildNumber: 28,
      targets: ["patch", "android_apk"],
      git: {
        url: "git@github.com:example/GameXpert_Godot.git",
        branch: "main",
        commit: "0123456789abcdef",
        shortCommit: "0123456",
      },
      app: {
        appVersion: "0.0.1",
        resourceVersion: "0.0.1",
        platform: "android",
        channel: "default",
      },
      artifacts: [
        {
          target: "android_apk",
          name: "GameXpert-android-apk-0.0.1-28-0123456.apk",
          relativePath: "android/GameXpert-android-apk-0.0.1-28-0123456.apk",
          downloadUrl:
            "https://cdn.example.com/gamexpert/android/GameXpert-android-apk-0.0.1-28-0123456.apk",
          sha256: "apk",
          sizeBytes: 789,
        },
        {
          target: "patch",
          name: "manifest.json",
          relativePath: "patch/manifest.json",
          downloadUrl: "https://cdn.example.com/gamexpert/patch/manifest.json",
          sha256: "def",
          sizeBytes: 123,
        },
        {
          target: "patch",
          name: "GodotSharp.dll",
          relativePath: "patch/GodotSharp.dll",
          downloadUrl: "https://cdn.example.com/gamexpert/patch/GodotSharp.dll",
          sha256: "zzz",
          sizeBytes: 321,
        },
        {
          target: "patch",
          name: "GameXpert-patch-bundle-0.0.1-28-0123456.zip",
          relativePath: "patch/GameXpert-patch-bundle-0.0.1-28-0123456.zip",
          downloadUrl:
            "https://cdn.example.com/gamexpert/patch/GameXpert-patch-bundle-0.0.1-28-0123456.zip",
          sha256: "abc",
          sizeBytes: 456,
        },
      ],
      reports: {
        manifestUrl: "https://cdn.example.com/gamexpert/patch/manifest.json",
      },
    });
    expect(published.manifest.patch?.manifestUrl).toContain("manifest.json");
    expect(published.manifest.patch?.bundleUrl).toContain(
      "GameXpert-patch-bundle-0.0.1-28-0123456.zip",
    );

    const finished = await runtime.recordCiBuildFinish({
      requestId: "jenkins-GameXpert_Godot_CI-28-finish",
      jobName: "GameXpert_Godot_CI",
      buildNumber: 28,
      pipelineUrl: "http://jenkins/job/GameXpert_Godot_CI/28/",
      targets: ["patch", "android_apk"],
      git: {
        url: "git@github.com:example/GameXpert_Godot.git",
        branch: "main",
        commit: "0123456789abcdef",
        shortCommit: "0123456",
      },
      app: {
        appVersion: "0.0.1",
        resourceVersion: "0.0.1",
        platform: "android",
        channel: "default",
      },
      result: "SUCCESS",
      durationSeconds: 120,
      summary: {
        artifactCount: 2,
        failedStage: "",
        message: "build completed",
      },
    });
    expect(finished.release.status).toBe("awaiting_approval");
  });

  it("triggers Jenkins with the current pipeline parameter contract", async () => {
    const runtime = await createRuntimeWithConfig({
      jenkinsBaseUrl: "https://jenkins.example.com",
      jenkinsJob: "GameXpert_Godot_CI",
      jenkinsUser: "lobster",
      jenkinsApiToken: "token",
      jenkinsLobsterApiKeyCredentialsId: "lobster-api-key",
      jenkinsLobsterApiSecretCredentialsId: "lobster-api-secret",
      jenkinsAndroidKeystoreBase64CredentialsId: "gamexpert-android-keystore-base64",
      jenkinsAndroidKeystoreAliasCredentialsId: "gamexpert-android-keystore-alias",
      jenkinsAndroidKeystorePasswordCredentialsId: "gamexpert-android-keystore-password",
      uploadDestinationDir: "/tmp/lobster-artifacts",
      uploadBaseUrl: "file:///tmp/lobster-artifacts",
    });

    const requests: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : "";
      requests.push({
        url,
        body,
      });
      return new Response("", {
        status: 201,
        headers: {
          location: "https://jenkins.example.com/queue/item/88/",
        },
      });
    }) as typeof fetch;

    try {
      const created = await runtime.createRelease({
        projectKey: "gamexpert",
        environment: "staging",
        channel: "beta",
        version: "1.2.3",
        git: {
          url: "git@github.com:example/GameXpert_Godot.git",
          branch: "main",
          commit: "0123456789abcdef",
        },
        targets: {
          androidApk: true,
          androidAab: false,
          macosApp: false,
          patch: true,
        },
        triggerBuild: true,
        createdBy: "tester",
      });

      expect(created.build?.jenkinsQueueId).toBe("88");
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(request.url).toContain("/job/GameXpert_Godot_CI/buildWithParameters");
      const params = new URLSearchParams(request.body);
      expect(params.get("BUILD_TARGETS")).toBe("android_apk,patch");
      expect(params.get("APP_VERSION")).toBe("1.2.3");
      expect(params.get("RESOURCE_VERSION")).toBe("1.2.3");
      expect(params.get("LOBSTER_ENDPOINT_BUILD_START")).toBe("/api/ci/v1/builds/start");
      expect(params.get("LOBSTER_ENDPOINT_PUBLISH")).toBe("/api/ci/v1/builds/publish");
      expect(params.get("LOBSTER_ENDPOINT_FINISH")).toBe("/api/ci/v1/builds/finish");
      expect(params.get("LOBSTER_API_KEY_CREDENTIALS_ID")).toBe("lobster-api-key");
      expect(params.get("LOBSTER_API_SECRET_CREDENTIALS_ID")).toBe("lobster-api-secret");
      expect(params.get("ANDROID_KEYSTORE_BASE64_CREDENTIALS_ID")).toBe(
        "gamexpert-android-keystore-base64",
      );
      expect(params.get("ANDROID_KEYSTORE_ALIAS_CREDENTIALS_ID")).toBe(
        "gamexpert-android-keystore-alias",
      );
      expect(params.get("ANDROID_KEYSTORE_PASSWORD_CREDENTIALS_ID")).toBe(
        "gamexpert-android-keystore-password",
      );
      expect(params.get("UPLOAD_DESTINATION_DIR")).toBe("/tmp/lobster-artifacts");
      expect(params.get("UPLOAD_BASE_URL")).toBe("file:///tmp/lobster-artifacts");
      expect(params.has("PATCH_BASELINE_VERSION")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("filters stale versioned artifacts from publish payloads", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.12",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: true,
      createdBy: "tester",
    });

    runtime.recordBuildStart(created.build!.buildId, {
      jenkinsBuildNumber: 38,
      jenkinsJob: "GameXpert_Godot_CI",
    });

    const publish = await runtime.recordBuildPublish(created.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_apk",
          platform: "android",
          fileName: "GameXpert-android-apk-1.2.12-38-ed990d1.apk",
          fileSizeBytes: 100,
          sha256: "new-apk",
          storageProvider: "local",
          storagePath: "export/android/GameXpert-android-apk-1.2.12-38-ed990d1.apk",
        },
        {
          artifactType: "android_apk",
          platform: "android",
          fileName: "GameXpert-android-apk-1.2.9-35-ed990d1.apk",
          fileSizeBytes: 100,
          sha256: "old-apk",
          storageProvider: "local",
          storagePath: "export/android/GameXpert-android-apk-1.2.9-35-ed990d1.apk",
        },
        {
          artifactType: "patch_bundle",
          platform: "android",
          fileName: "GameXpert-patch-bundle-1.2.12-38-ed990d1.zip",
          fileSizeBytes: 100,
          sha256: "new-patch",
          storageProvider: "local",
          storagePath: "patch/GameXpert-patch-bundle-1.2.12-38-ed990d1.zip",
        },
        {
          artifactType: "patch_bundle",
          platform: "android",
          fileName: "GameXpert-patch-bundle-1.2.9-35-ed990d1.zip",
          fileSizeBytes: 100,
          sha256: "old-patch",
          storageProvider: "local",
          storagePath: "patch/GameXpert-patch-bundle-1.2.9-35-ed990d1.zip",
        },
        {
          artifactType: "patch_manifest",
          platform: "android",
          fileName: "manifest.json",
          fileSizeBytes: 10,
          sha256: "manifest",
          storageProvider: "local",
          storagePath: "patch/content/manifest.json",
        },
      ],
    });

    expect(publish.manifest.artifacts.map((artifact) => artifact.fileName).toSorted()).toEqual([
      "GameXpert-android-apk-1.2.12-38-ed990d1.apk",
      "GameXpert-patch-bundle-1.2.12-38-ed990d1.zip",
      "manifest.json",
    ]);
  });

  it("resolves patch baselines from the latest published release instead of stale baseline rows", async () => {
    const runtime = await createRuntime();

    const release129 = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.9",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(release129.release.releaseId, "approver");

    const staleBaseline = runtime.resolveBaseline({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      targetVersion: "1.2.10",
      platform: "patch",
    });
    expect(staleBaseline?.fromVersion).toBe("1.2.9");

    const release1213 = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.13",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(release1213.release.releaseId, "approver");

    const nextBaseline = runtime.resolveBaseline({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      targetVersion: "1.2.14",
      platform: "patch",
    });

    expect(nextBaseline?.fromVersion).toBe("1.2.13");
    expect(nextBaseline?.fromReleaseId).toBe(release1213.release.releaseId);
    expect(nextBaseline?.baselineManifestUrl).toContain("/1.2.13/release_manifest.json");
  });

  it("keeps the previous channel pointer stable when re-approving the same release", async () => {
    const runtime = await createRuntime();

    const release129 = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.9",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(release129.release.releaseId, "approver");

    const release1213 = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.13",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(release1213.release.releaseId, "approver");
    await runtime.approveRelease(release1213.release.releaseId, "approver");

    const state = runtime.getChannelState("gamexpert", "staging", "beta");
    expect(state?.currentReleaseId).toBe(release1213.release.releaseId);
    expect(state?.previousReleaseId).toBe(release129.release.releaseId);
  });

  it("reuses the trigger-created build for Jenkins callbacks and preserves baseline provenance", async () => {
    const runtime = await createRuntime();

    const release129 = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.9",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(release129.release.releaseId, "approver");

    const created = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.14",
      git: {
        url: "git@github.com:example/GameXpert_Godot.git",
        branch: "main",
      },
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: true,
      createdBy: "tester",
    });

    expect(created.build?.buildId).toBeTruthy();
    expect(runtime.getBuild(created.build!.buildId)?.baselineVersion).toBe("1.2.9");

    const started = runtime.recordCiBuildStart({
      requestId: "jenkins-GameXpert_Godot_CI-40-start",
      jobName: "GameXpert_Godot_CI",
      buildNumber: 40,
      pipelineUrl: "http://jenkins/job/GameXpert_Godot_CI/40/",
      targets: ["android_apk", "patch"],
      git: {
        url: "git@github.com:example/GameXpert_Godot.git",
        branch: "main",
        commit: "0123456789abcdef",
        shortCommit: "0123456",
      },
      app: {
        appVersion: "1.2.14",
        resourceVersion: "1.2.14",
        platform: "android",
        channel: "beta",
      },
      baseline: {
        strategy: "incremental",
        baselineVersion: "1.2.9",
        baselineManifestUrl:
          "https://release.example.com/plugins/lobster-release/api/manifests/gamexpert/staging/beta/1.2.9/release_manifest.json",
      },
    });

    expect(started.buildId).toBe(created.build?.buildId);
    expect(started.sourceGitCommit).toBe("0123456789abcdef");
    expect(started.baselineVersion).toBe("1.2.9");
    expect(started.baselineManifestUrl).toContain("/1.2.9/release_manifest.json");

    const provenance = runtime.getBuildProvenance(started.buildId);
    expect(provenance?.baselineVersion).toBe("1.2.9");
    expect(provenance?.baselineManifestUrl).toContain("/1.2.9/release_manifest.json");
    expect(provenance?.sourceGitCommit).toBe("0123456789abcdef");
  });

  it("does not erase the trigger baseline when Jenkins start sends an empty baselineVersion", async () => {
    const runtime = await createRuntime();

    const release1214 = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.14",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(release1214.release.releaseId, "approver");

    const created = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.15",
      git: {
        url: "git@github.com:example/GameXpert_Godot.git",
        branch: "main",
      },
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: true,
      },
      triggerBuild: true,
      createdBy: "tester",
    });

    expect(runtime.getBuild(created.build!.buildId)?.baselineVersion).toBe("1.2.14");

    const started = runtime.recordCiBuildStart({
      requestId: "jenkins-GameXpert_Godot_CI-41-start",
      jobName: "GameXpert_Godot_CI",
      buildNumber: 41,
      pipelineUrl: "http://jenkins/job/GameXpert_Godot_CI/41/",
      targets: ["android_apk", "patch"],
      git: {
        url: "git@github.com:example/GameXpert_Godot.git",
        branch: "main",
        commit: "7617252d714c33908c39b438d4c69b62a70f4223",
        shortCommit: "7617252",
      },
      app: {
        appVersion: "1.2.15",
        resourceVersion: "1.2.15",
        platform: "android",
        channel: "beta",
      },
      baseline: {
        baselineVersion: "",
        baselineManifestUrl:
          "https://release.example.com/plugins/lobster-release/api/manifests/gamexpert/staging/beta/1.2.14/release_manifest.json",
      },
    });

    expect(started.baselineVersion).toBe("1.2.14");

    const provenance = runtime.getBuildProvenance(started.buildId);
    expect(provenance?.baselineVersion).toBe("1.2.14");
    expect(provenance?.baselineManifestUrl).toContain("/1.2.14/release_manifest.json");
    expect(provenance?.jenkinsBuildNumber).toBe(41);
    expect(provenance?.sourceGitCommit).toBe("7617252d714c33908c39b438d4c69b62a70f4223");
  });

  it("supports per-project policy isolation and gray rollout planning", async () => {
    const runtime = await createRuntimeWithConfig({
      defaultProjectKey: "gamexpert",
      projects: {
        projectb: {
          name: "Project B",
          environments: ["staging", "production"],
          channels: ["beta", "release"],
          defaultEnvironment: "production",
          defaultChannel: "release",
          regions: ["cn", "us"],
          audiences: ["internal", "external"],
          grayRelease: {
            enabled: true,
            rolloutPercentages: [10, 50, 100],
            stickiness: "account",
          },
          smokeWorkflows: ["install-smoke", "boot-smoke"],
        },
      },
    });

    const created = await runtime.createRelease({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      version: "2.0.0",
      scope: {
        region: "cn",
        audience: "internal",
      },
      targets: {
        androidApk: false,
        androidAab: true,
        macosApp: false,
        patch: false,
      },
      triggerBuild: false,
      createdBy: "tester",
    });

    expect(created.release.projectKey).toBe("projectb");
    const createdScope = created.release.metadata?.scope as Record<string, unknown> | undefined;
    expect(createdScope?.region).toBe("cn");

    const catalog = runtime.getProjectCatalog();
    expect(catalog.projects.find((item) => item.projectKey === "projectb")?.defaultChannel).toBe(
      "release",
    );

    const grayPlan = runtime.getGrayReleasePlan({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      region: "cn",
      audience: "internal",
    });
    expect(grayPlan.grayRelease.enabled).toBe(true);
    expect(grayPlan.grayRelease.rolloutPercentages).toEqual([10, 50, 100]);
    expect(grayPlan.smokeWorkflows).toEqual(["install-smoke", "boot-smoke"]);

    await expect(
      runtime.createRelease({
        projectKey: "projectb",
        environment: "production",
        channel: "release",
        version: "2.0.1",
        scope: {
          region: "eu",
        },
        targets: {
          androidApk: false,
          androidAab: true,
          macosApp: false,
          patch: false,
        },
        triggerBuild: false,
        createdBy: "tester",
      }),
    ).rejects.toThrow("project region is not allowed");
  });

  it("creates rollouts, resolves channel routing, and publishes from an active rollout", async () => {
    const runtime = await createRuntimeWithConfig({
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
          },
        },
      },
    });

    const stable = await runtime.createRelease({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      version: "1.0.0",
      targets: {
        androidApk: false,
        androidAab: true,
        macosApp: false,
        patch: false,
      },
      triggerBuild: true,
      createdBy: "tester",
    });
    runtime.recordBuildStart(stable.build!.buildId, {
      jenkinsBuildNumber: 10,
      jenkinsJob: "GameXpert_Godot_CI",
    });
    await runtime.recordBuildPublish(stable.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_aab",
          platform: "android",
          fileName: "ProjectB-android-aab-1.0.0-10.aab",
          fileSizeBytes: 100,
          sha256: "stableaab",
          storageProvider: "s3",
          storagePath: "releases/1.0.0-10/ProjectB-android-aab-1.0.0-10.aab",
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
      targets: {
        androidApk: false,
        androidAab: true,
        macosApp: false,
        patch: false,
      },
      triggerBuild: true,
      createdBy: "tester",
    });
    runtime.recordBuildStart(candidate.build!.buildId, {
      jenkinsBuildNumber: 11,
      jenkinsJob: "GameXpert_Godot_CI",
    });
    await runtime.recordBuildPublish(candidate.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_aab",
          platform: "android",
          fileName: "ProjectB-android-aab-1.0.1-11.aab",
          fileSizeBytes: 100,
          sha256: "candidateaab",
          storageProvider: "s3",
          storagePath: "releases/1.0.1-11/ProjectB-android-aab-1.0.1-11.aab",
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
      scope: {
        region: "cn",
        audience: "internal",
      },
      operator: "ops",
    });
    expect(rollout.status).toBe("active");

    const matchedRoute = runtime.resolveChannelRoute({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      region: "cn",
      audience: "internal",
      bucketValue: 5,
    });
    expect(matchedRoute.route).toBe("rollout");
    expect(matchedRoute.selectedRelease?.releaseId).toBe(candidate.release.releaseId);

    const fallbackRoute = runtime.resolveChannelRoute({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      region: "cn",
      audience: "internal",
      bucketValue: 25,
    });
    expect(fallbackRoute.route).toBe("channel");
    expect(fallbackRoute.selectedRelease?.releaseId).toBe(stable.release.releaseId);

    const completed = await runtime.advanceRollout({
      projectKey: "projectb",
      rolloutId: rollout.rolloutId,
      trafficPercent: 50,
      publishRelease: true,
      operator: "ops",
    });
    expect(completed.status).toBe("active");
    expect(completed.trafficPercent).toBe(50);
    expect(runtime.getChannelState("projectb", "production", "release")?.currentReleaseId).toBe(
      candidate.release.releaseId,
    );
  });

  it("cancels active rollouts when rollback is approved", async () => {
    const runtime = await createRuntimeWithConfig({
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
          },
        },
      },
    });

    const stable = await runtime.createRelease({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      version: "1.0.1",
      targets: {
        androidApk: false,
        androidAab: true,
        macosApp: false,
        patch: false,
      },
      triggerBuild: true,
      createdBy: "tester",
    });
    runtime.recordBuildStart(stable.build!.buildId, {
      jenkinsBuildNumber: 20,
      jenkinsJob: "GameXpert_Godot_CI",
    });
    await runtime.recordBuildPublish(stable.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_aab",
          platform: "android",
          fileName: "ProjectB-android-aab-1.0.1-20.aab",
          fileSizeBytes: 100,
          sha256: "stable-v1",
          storageProvider: "s3",
          storagePath: "releases/1.0.1-20/ProjectB-android-aab-1.0.1-20.aab",
        },
      ],
    });
    await runtime.recordBuildFinish(stable.build!.buildId, { status: "success" });
    await runtime.approveRelease(stable.release.releaseId, "approver");

    const current = await runtime.createRelease({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      version: "1.0.2",
      targets: {
        androidApk: false,
        androidAab: true,
        macosApp: false,
        patch: false,
      },
      triggerBuild: true,
      createdBy: "tester",
    });
    runtime.recordBuildStart(current.build!.buildId, {
      jenkinsBuildNumber: 21,
      jenkinsJob: "GameXpert_Godot_CI",
    });
    await runtime.recordBuildPublish(current.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_aab",
          platform: "android",
          fileName: "ProjectB-android-aab-1.0.2-21.aab",
          fileSizeBytes: 100,
          sha256: "current-v1",
          storageProvider: "s3",
          storagePath: "releases/1.0.2-21/ProjectB-android-aab-1.0.2-21.aab",
        },
      ],
    });
    await runtime.recordBuildFinish(current.build!.buildId, { status: "success" });
    await runtime.approveRelease(current.release.releaseId, "approver");

    const rollout = await runtime.createRollout({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      releaseId: current.release.releaseId,
      trafficPercent: 10,
      operator: "ops",
    });
    expect(rollout.status).toBe("active");

    const rollback = await runtime.createRollback({
      projectKey: "projectb",
      environment: "production",
      channel: "release",
      targetReleaseId: stable.release.releaseId,
      reason: "incident",
      strategy: "pointer_switch",
      freezeCurrentRelease: true,
      operator: "ops",
    });
    await runtime.approveRollback(rollback.rollbackId, "ops");

    expect(runtime.getRollout(rollout.rolloutId)?.status).toBe("canceled");
  });

  it("blocks approve-release while a rollback is still requested", async () => {
    const runtime = await createRuntime();

    const stableOne = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.0.1",
      targets: {
        androidApk: false,
        androidAab: false,
        macosApp: false,
        patch: false,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(stableOne.release.releaseId, "approver");

    const stableTwo = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.0.2",
      targets: {
        androidApk: false,
        androidAab: false,
        macosApp: false,
        patch: false,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(stableTwo.release.releaseId, "approver");

    await runtime.createRollback({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      targetReleaseId: stableOne.release.releaseId,
      reason: "incident",
      strategy: "pointer_switch",
      freezeCurrentRelease: true,
      operator: "ops",
    });

    await expect(runtime.approveRelease(stableTwo.release.releaseId, "approver")).rejects.toThrow(
      "rollback.in_progress",
    );
  });

  it("preserves immutable artifacts and blocks incompatible rollback targets", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "1.2.3",
      targets: {
        androidApk: true,
        androidAab: false,
        macosApp: false,
        patch: false,
      },
      triggerBuild: true,
      createdBy: "tester",
    });

    runtime.recordBuildStart(created.build!.buildId, {
      jenkinsBuildNumber: 42,
      jenkinsJob: "GameXpert_Godot_CI",
    });

    await runtime.recordBuildPublish(created.build!.buildId, {
      artifacts: [
        {
          artifactType: "android_apk",
          platform: "android",
          fileName: "GameXpert-android-apk-1.2.3-42.apk",
          fileSizeBytes: 100,
          sha256: "abc",
          storageProvider: "s3",
          storagePath: "releases/1.2.3-42/GameXpert-android-apk-1.2.3-42.apk",
        },
        {
          artifactType: "android_apk",
          platform: "android",
          fileName: "GameXpert-android-apk-1.2.3-42.apk",
          fileSizeBytes: 100,
          sha256: "abc",
          storageProvider: "s3",
          storagePath: "releases/1.2.3-42/GameXpert-android-apk-1.2.3-42.apk",
        },
      ],
    });

    const artifacts = runtime.getBuildStatus(created.build!.buildId).artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.immutable).toBe(true);
    await runtime.recordBuildFinish(created.build!.buildId, { status: "success" });
    await runtime.approveRelease(created.release.releaseId, "approver");

    const major = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "2.0.0",
      targets: {
        androidApk: false,
        androidAab: false,
        macosApp: false,
        patch: false,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(major.release.releaseId, "approver");

    const patch = await runtime.createRelease({
      projectKey: "gamexpert",
      environment: "staging",
      channel: "beta",
      version: "2.0.1",
      targets: {
        androidApk: false,
        androidAab: false,
        macosApp: false,
        patch: false,
      },
      triggerBuild: false,
      createdBy: "tester",
    });
    await runtime.approveRelease(patch.release.releaseId, "approver");

    await expect(
      runtime.createRollback({
        projectKey: "gamexpert",
        environment: "staging",
        channel: "beta",
        targetReleaseId: created.release.releaseId,
        reason: "bad rollback",
        strategy: "pointer_switch",
        freezeCurrentRelease: true,
        operator: "ops",
      }),
    ).rejects.toThrow("rollback.compatibility_conflict");
  });
});
