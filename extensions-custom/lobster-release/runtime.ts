import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk/lobster";
import type { LobsterReleaseConfig } from "./config.js";
import { LobsterReleaseStore } from "./store.js";
import type {
  ArtifactRecord,
  BaselineRecord,
  CiBuildRequest,
  CiFinishRequest,
  CiPublishArtifact,
  CiPublishRequest,
  BuildProvenanceRecord,
  BuildRecord,
  BuildTargets,
  ChannelStateRecord,
  CreateReleaseInput,
  EventLogRecord,
  ProjectRecord,
  ReleaseChannel,
  ReleaseEnvironment,
  ReleaseManifest,
  ReleaseRecord,
  ReleaseRelationRecord,
  RollbackInput,
  RollbackOperationRecord,
  TriggerReleaseInput,
} from "./types.js";
import { compareVersions, inferBumpType, parseVersion, toCommitShort } from "./versioning.js";

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export class LobsterReleaseRuntime {
  private readonly manifestsDir: string;

  constructor(
    private readonly store: LobsterReleaseStore,
    private readonly config: LobsterReleaseConfig,
    private readonly logger: PluginLogger,
    private readonly stateDir: string,
  ) {
    this.manifestsDir = path.join(this.stateDir, "plugins", "lobster-release", "manifests");
  }

  async start(): Promise<void> {
    await this.store.load();
    await fs.mkdir(this.manifestsDir, { recursive: true, mode: 0o700 });
  }

  stop(): void {
    this.store.close();
  }

  private ensureProject(projectKey: string): ProjectRecord {
    const existing = this.store.getProject(projectKey);
    if (existing) {
      return existing;
    }
    const now = nowIso();
    const project: ProjectRecord = {
      projectId: createId("prj"),
      projectKey,
      name: projectKey,
      engine: "godot",
      defaultChannel: "dev",
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertProject(project);
    return project;
  }

  private channelLockKey(projectKey: string, environment: string, channel: string): string {
    return `${projectKey}:${environment}:channel:${channel}`;
  }

  private acquireChannelLock(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    owner: string;
    reason: string;
  }): void {
    this.store.purgeExpiredLocks();
    const lock = this.store.acquireLock({
      lockId: createId("lock"),
      projectId: params.projectKey,
      projectKey: params.projectKey,
      environment: params.environment,
      lockScope: "channel",
      lockKey: this.channelLockKey(params.projectKey, params.environment, params.channel),
      owner: params.owner,
      reason: params.reason,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (!lock.ok) {
      throw new Error(
        `channel lock conflict: ${params.projectKey}/${params.environment}/${params.channel}`,
      );
    }
  }

  private releaseChannelLock(projectKey: string, environment: string, channel: string): void {
    this.store.releaseLock(this.channelLockKey(projectKey, environment, channel));
  }

  private recordEvent(params: Omit<EventLogRecord, "eventId" | "createdAt">): void {
    this.store.insertEvent({
      ...params,
      eventId: createId("evt"),
      createdAt: nowIso(),
    });
  }

  private normalizeCiChannel(raw?: string): ReleaseChannel {
    const value = raw?.trim().toLowerCase();
    if (!value || value === "default") {
      return this.config.defaultChannel;
    }
    if (value === "dev") {
      return "dev";
    }
    if (value === "release" || value === "stable" || value === "prod" || value === "production") {
      return "release";
    }
    return "beta";
  }

  private parseCiBuildNumber(raw: string | number | undefined): number | undefined {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw !== "string" || !raw.trim()) {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private buildTargetsFromCi(request: Pick<CiBuildRequest, "targets" | "target">): BuildTargets {
    const values = new Set(
      [...(request.targets ?? []), request.target ?? ""]
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    );
    return {
      androidApk: values.has("android_apk"),
      androidAab: values.has("android_aab"),
      macosApp: values.has("macos_app"),
      patch: values.has("patch"),
    };
  }

  private versionFromCi(request: CiBuildRequest): string {
    const targets = this.buildTargetsFromCi(request);
    const candidate = targets.patch
      ? request.app?.resourceVersion?.trim() || request.app?.appVersion?.trim()
      : request.app?.appVersion?.trim() || request.app?.resourceVersion?.trim();
    if (!candidate) {
      throw new Error("ci request missing appVersion/resourceVersion");
    }
    return candidate;
  }

  private platformFromCi(
    request: Pick<CiBuildRequest, "app" | "targets" | "target">,
    targets?: BuildTargets,
  ): string {
    const explicit = request.app?.platform?.trim();
    if (explicit) {
      return explicit;
    }
    const resolved = targets ?? this.buildTargetsFromCi(request);
    if (resolved.macosApp && !resolved.androidApk && !resolved.androidAab) {
      return "macos";
    }
    return "android";
  }

  private findReleaseByVersion(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    version: string;
  }): ReleaseRecord | null {
    return (
      this.store
        .listReleases({
          projectKey: params.projectKey,
          environment: params.environment,
          channel: params.channel,
        })
        .find((release) => release.version === params.version) ?? null
    );
  }

  private findBuildForCi(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    releaseId?: string;
    jobName?: string;
    buildNumber?: number;
    commit?: string;
  }): BuildRecord | null {
    const candidates = params.releaseId
      ? this.store.listBuildsForRelease(params.releaseId)
      : this.store.listBuilds({
          projectKey: params.projectKey,
          environment: params.environment,
          channel: params.channel,
        });
    return (
      candidates.find(
        (build) =>
          build.jenkinsJob === params.jobName && build.jenkinsBuildNumber === params.buildNumber,
      ) ??
      candidates.find(
        (build) =>
          build.jenkinsJob === params.jobName &&
          build.sourceGitCommit === params.commit &&
          (build.status === "triggering" ||
            build.status === "queued" ||
            build.status === "building"),
      ) ??
      candidates.find(
        (build) =>
          build.sourceGitCommit === params.commit &&
          (build.status === "triggering" ||
            build.status === "queued" ||
            build.status === "building"),
      ) ??
      (() => {
        const active = candidates.filter(
          (build) =>
            (build.status === "triggering" ||
              build.status === "queued" ||
              build.status === "building") &&
            (!params.jobName || build.jenkinsJob === params.jobName),
        );
        return active.length === 1 ? active[0] : null;
      })() ??
      (() => {
        const active = candidates.filter(
          (build) =>
            build.status === "triggering" ||
            build.status === "queued" ||
            build.status === "building",
        );
        return active.length === 1 ? active[0] : null;
      })() ??
      null
    );
  }

  private mergeCiBuildMetadata(build: BuildRecord, request: CiBuildRequest): BuildRecord {
    const buildNumber = this.parseCiBuildNumber(request.buildNumber);
    const jobName = request.jobName?.trim() || this.config.jenkinsJob;
    const baselineVersion = request.baseline?.baselineVersion?.trim() || build.baselineVersion;
    const baselineManifestUrl =
      request.baseline?.baselineManifestUrl?.trim() || build.baselineManifestUrl;
    return {
      ...build,
      sourceGitUrl: request.git?.url ?? build.sourceGitUrl,
      sourceGitBranch: request.git?.branch ?? build.sourceGitBranch,
      sourceGitCommit: request.git?.commit ?? build.sourceGitCommit,
      sourceGitCommitShort:
        request.git?.shortCommit ??
        toCommitShort(request.git?.commit) ??
        build.sourceGitCommitShort,
      jenkinsJob: jobName ?? build.jenkinsJob,
      jenkinsBuildNumber: buildNumber ?? build.jenkinsBuildNumber,
      baselineVersion,
      baselineManifestUrl,
      reports: request.pipelineUrl
        ? {
            ...build.reports,
            pipelineUrl: request.pipelineUrl,
          }
        : build.reports,
      updatedAt: nowIso(),
    };
  }

  private ensureCiRelease(request: CiBuildRequest): ReleaseRecord {
    const projectKey = this.config.defaultProjectKey;
    const environment = this.config.defaultEnvironment;
    const channel = this.normalizeCiChannel(request.app?.channel);
    const version = this.versionFromCi(request);
    const existing = this.findReleaseByVersion({
      projectKey,
      environment,
      channel,
      version,
    });
    if (existing) {
      return existing;
    }
    const project = this.ensureProject(projectKey);
    const currentState = this.getChannelState(projectKey, environment, channel);
    const currentRelease = currentState?.currentReleaseId
      ? this.store.getRelease(currentState.currentReleaseId)
      : null;
    const parsed = parseVersion(version);
    const now = nowIso();
    const release: ReleaseRecord = {
      releaseId: createId("rel"),
      projectId: project.projectId,
      projectKey,
      environment,
      channel,
      version: parsed.raw,
      displayVersion: parsed.raw,
      versionScheme: "semver3",
      versionMajor: parsed.major,
      versionMinor: parsed.minor,
      versionPatch: parsed.patch,
      versionBumpType: inferBumpType(currentRelease?.version, parsed),
      versionSource: "manual",
      status: "building",
      stable: false,
      frozen: false,
      git: {
        url: request.git?.url,
        branch: request.git?.branch,
        commit: request.git?.commit,
        commitShort: request.git?.shortCommit ?? toCommitShort(request.git?.commit),
      },
      createdBy: "jenkins-ci",
      createdAt: now,
      updatedAt: now,
      metadata: {
        targets: this.buildTargetsFromCi(request),
        source: "jenkins-ci",
      },
    };
    this.store.upsertRelease(release);
    if (currentRelease) {
      this.store.insertReleaseRelation({
        relationId: createId("reln"),
        projectId: project.projectId,
        projectKey,
        fromReleaseId: currentRelease.releaseId,
        toReleaseId: release.releaseId,
        relationType: "derived_from",
        context: { channel, environment, source: "jenkins-ci" },
        createdBy: "jenkins-ci",
        createdAt: now,
      });
    }
    return release;
  }

  private ensureCiBuild(request: CiBuildRequest): { release: ReleaseRecord; build: BuildRecord } {
    const release = this.ensureCiRelease(request);
    const buildNumber = this.parseCiBuildNumber(request.buildNumber);
    const jobName = request.jobName?.trim() || this.config.jenkinsJob;
    const existingBuild = this.findBuildForCi({
      projectKey: release.projectKey,
      environment: release.environment,
      channel: release.channel,
      releaseId: release.releaseId,
      jobName,
      buildNumber,
      commit: request.git?.commit,
    });
    if (existingBuild) {
      const nextBuild = this.mergeCiBuildMetadata(existingBuild, request);
      this.store.upsertBuild(nextBuild);
      this.store.upsertRelease({
        ...release,
        currentBuildId: nextBuild.buildId,
        updatedAt: nowIso(),
      });
      const currentProvenance =
        this.store.getBuildProvenance(nextBuild.buildId) ?? this.createProvenance(nextBuild);
      const parameters = {
        ...currentProvenance.parameters,
        requestId: request.requestId,
        pipelineUrl: request.pipelineUrl,
        targets: request.targets ?? [],
        baselineVersion: nextBuild.baselineVersion,
        baselineManifestUrl: nextBuild.baselineManifestUrl,
      };
      this.store.upsertBuildProvenance({
        ...currentProvenance,
        sourceGitUrl: nextBuild.sourceGitUrl,
        sourceGitBranch: nextBuild.sourceGitBranch,
        sourceGitCommit: nextBuild.sourceGitCommit,
        sourceGitCommitShort: nextBuild.sourceGitCommitShort,
        jenkinsJob: nextBuild.jenkinsJob,
        jenkinsBuildNumber: nextBuild.jenkinsBuildNumber,
        baselineVersion: nextBuild.baselineVersion,
        baselineManifestUrl: nextBuild.baselineManifestUrl,
        parameters,
        capturedAt: nowIso(),
        provenanceHash: sha256Text(JSON.stringify(parameters)),
      });
      return { release, build: nextBuild };
    }
    const now = nowIso();
    const targets = this.buildTargetsFromCi(request);
    const build: BuildRecord = {
      buildId: createId("bld"),
      releaseId: release.releaseId,
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      channel: release.channel,
      status: "queued",
      triggeredBy: "jenkins-ci",
      triggerSource: "api",
      sourceGitUrl: request.git?.url,
      sourceGitBranch: request.git?.branch,
      sourceGitCommit: request.git?.commit,
      sourceGitCommitShort: request.git?.shortCommit ?? toCommitShort(request.git?.commit),
      jenkinsJob: jobName,
      jenkinsBuildNumber: buildNumber,
      baselineVersion: request.baseline?.baselineVersion,
      baselineManifestUrl: request.baseline?.baselineManifestUrl,
      idempotencyKey: request.requestId,
      createdAt: now,
      updatedAt: now,
      targets,
      reports: request.pipelineUrl ? { pipelineUrl: request.pipelineUrl } : undefined,
    };
    this.store.upsertBuild(build);
    this.store.upsertRelease({
      ...release,
      currentBuildId: build.buildId,
      status: "building",
      updatedAt: now,
    });
    this.store.upsertBuildProvenance(
      this.createProvenance(build, {
        parameters: {
          requestId: request.requestId,
          pipelineUrl: request.pipelineUrl,
          targets: request.targets ?? [],
        },
      }),
    );
    return { release, build };
  }

  private baselinePackageForRelease(release: ReleaseRecord): ArtifactRecord | null {
    for (const build of this.store.listBuildsForRelease(release.releaseId)) {
      const artifact = this.selectPatchBundleArtifact(
        this.store.listArtifactsForBuild(build.buildId),
      );
      if (artifact) {
        return artifact;
      }
    }
    return null;
  }

  getChannelState(
    projectKey: string,
    environment: ReleaseEnvironment,
    channel: ReleaseChannel,
  ): ChannelStateRecord | null {
    return this.store.getChannelState(projectKey, environment, channel);
  }

  getRelease(releaseId: string): ReleaseRecord | null {
    return this.store.getRelease(releaseId);
  }

  getBuild(buildId: string): BuildRecord | null {
    return this.store.getBuild(buildId);
  }

  getRollback(rollbackId: string): RollbackOperationRecord | null {
    return this.store.getRollback(rollbackId);
  }

  async createRelease(input: CreateReleaseInput): Promise<{
    release: ReleaseRecord;
    currentChannelReleaseId?: string;
    versionBumpType: ReleaseRecord["versionBumpType"];
    build?: Awaited<ReturnType<LobsterReleaseRuntime["triggerRelease"]>>;
  }> {
    const project = this.ensureProject(input.projectKey);
    const currentState = this.getChannelState(input.projectKey, input.environment, input.channel);
    const currentRelease = currentState?.currentReleaseId
      ? this.store.getRelease(currentState.currentReleaseId)
      : null;
    const nextParsed = parseVersion(input.version);
    const bumpType = inferBumpType(currentRelease?.version, nextParsed);
    const now = nowIso();
    const release: ReleaseRecord = {
      releaseId: createId("rel"),
      projectId: project.projectId,
      projectKey: input.projectKey,
      environment: input.environment,
      channel: input.channel,
      version: nextParsed.raw,
      displayVersion: nextParsed.raw,
      versionScheme: "semver3",
      versionMajor: nextParsed.major,
      versionMinor: nextParsed.minor,
      versionPatch: nextParsed.patch,
      versionBumpType: bumpType,
      versionSource: "manual",
      status: "draft",
      stable: false,
      frozen: false,
      git: {
        url: input.git?.url,
        branch: input.git?.branch,
        commit: input.git?.commit,
        commitShort: toCommitShort(input.git?.commit),
        tag: input.git?.tag,
      },
      notes: input.notes,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      metadata: {
        targets: input.targets,
      },
    };
    this.store.upsertRelease(release);
    if (currentRelease) {
      this.store.insertReleaseRelation({
        relationId: createId("reln"),
        projectId: project.projectId,
        projectKey: project.projectKey,
        fromReleaseId: currentRelease.releaseId,
        toReleaseId: release.releaseId,
        relationType: "derived_from",
        context: { channel: input.channel, environment: input.environment },
        createdBy: input.createdBy,
        createdAt: now,
      });
    }
    this.recordEvent({
      projectId: project.projectId,
      projectKey: project.projectKey,
      environment: input.environment,
      objectType: "release",
      objectId: release.releaseId,
      eventType: "release.created",
      payload: {
        version: release.version,
        channel: release.channel,
        environment: release.environment,
      },
      createdBy: input.createdBy,
    });
    const result: {
      release: ReleaseRecord;
      currentChannelReleaseId?: string;
      versionBumpType: ReleaseRecord["versionBumpType"];
      build?: Awaited<ReturnType<LobsterReleaseRuntime["triggerRelease"]>>;
    } = {
      release,
      currentChannelReleaseId: currentRelease?.releaseId,
      versionBumpType: bumpType,
    };
    if (input.triggerBuild) {
      result.build = await this.triggerRelease({
        projectKey: input.projectKey,
        releaseId: release.releaseId,
        operator: input.createdBy,
      });
    }
    return result;
  }

  resolveBaseline(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    targetVersion: string;
    platform: string;
  }): BaselineRecord | null {
    const baselineRelease = this.store
      .listReleases({
        projectKey: params.projectKey,
        environment: params.environment,
        channel: params.channel,
      })
      .filter(
        (release) => release.stable && compareVersions(release.version, params.targetVersion) < 0,
      )
      .toSorted((a, b) => compareVersions(b.version, a.version))[0];
    const baselineManifestUrl = baselineRelease
      ? this.canonicalManifestUrlForRelease(baselineRelease)
      : undefined;
    if (!baselineRelease || !baselineManifestUrl) {
      return null;
    }
    const existing = this.store
      .listBaselines({
        projectKey: params.projectKey,
        environment: params.environment,
        channel: params.channel,
        platform: params.platform,
      })
      .map((item) => this.repairBaselineManifestUrl(item))
      .find(
        (item) =>
          item.fromReleaseId === baselineRelease.releaseId &&
          item.fromVersion === baselineRelease.version &&
          item.toVersion === params.targetVersion &&
          item.status === "active",
      );
    if (existing) {
      return existing;
    }
    const baseline: BaselineRecord = {
      baselineId: createId("base"),
      projectId: baselineRelease.projectId,
      projectKey: baselineRelease.projectKey,
      environment: baselineRelease.environment,
      channel: baselineRelease.channel,
      platform: params.platform,
      fromReleaseId: baselineRelease.releaseId,
      toReleaseId: undefined,
      fromVersion: baselineRelease.version,
      toVersion: params.targetVersion,
      baselineManifestUrl,
      compatibilityRule:
        parseVersion(params.targetVersion).major !== parseVersion(baselineRelease.version).major
          ? "reset"
          : "reuse",
      status: "active",
      createdAt: nowIso(),
    };
    this.store.upsertBaseline(baseline);
    return baseline;
  }

  private repairBaselineManifestUrl(baseline: BaselineRecord): BaselineRecord {
    if (!baseline.fromReleaseId) {
      return baseline;
    }
    const release = this.store.getRelease(baseline.fromReleaseId);
    const canonicalUrl = release ? this.canonicalManifestUrlForRelease(release) : undefined;
    if (!canonicalUrl || canonicalUrl === baseline.baselineManifestUrl) {
      return baseline;
    }
    const next = {
      ...baseline,
      baselineManifestUrl: canonicalUrl,
    };
    this.store.upsertBaseline(next);
    return next;
  }

  private selectPatchBundleArtifact(artifacts: ArtifactRecord[]): ArtifactRecord | null {
    return (
      artifacts.find(
        (item) =>
          item.artifactType === "patch_bundle" && item.fileName.toLowerCase().endsWith(".zip"),
      ) ??
      artifacts.find((item) => item.artifactType === "patch_bundle") ??
      null
    );
  }

  async triggerRelease(input: TriggerReleaseInput): Promise<{
    releaseId: string;
    buildId: string;
    status: BuildRecord["status"];
    jenkinsJob?: string;
    jenkinsQueueId?: string;
  }> {
    const release = this.store.getRelease(input.releaseId);
    if (!release || release.projectKey !== input.projectKey) {
      throw new Error(`release not found: ${input.releaseId}`);
    }
    const baseline =
      release.metadata && (release.metadata.targets as BuildTargets | undefined)?.patch
        ? this.resolveBaseline({
            projectKey: release.projectKey,
            environment: release.environment,
            channel: release.channel,
            targetVersion: release.version,
            platform: "patch",
          })
        : null;
    const buildId = createId("bld");
    const now = nowIso();
    const targets = (release.metadata?.targets as BuildTargets | undefined) ?? {
      androidApk: false,
      androidAab: false,
      macosApp: false,
      patch: false,
    };
    const build: BuildRecord = {
      buildId,
      releaseId: release.releaseId,
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      channel: release.channel,
      status: "triggering",
      triggeredBy: input.operator,
      triggerSource: "manual",
      sourceGitUrl: release.git.url,
      sourceGitBranch: release.git.branch,
      sourceGitCommit: release.git.commit,
      sourceGitCommitShort: release.git.commitShort,
      jenkinsJob: this.config.jenkinsJob,
      baselineVersion: baseline?.fromVersion,
      baselineManifestUrl: baseline?.baselineManifestUrl,
      createdAt: now,
      updatedAt: now,
      targets,
    };
    this.store.upsertBuild(build);
    this.store.upsertRelease({
      ...release,
      status: "building",
      currentBuildId: buildId,
      updatedAt: now,
    });
    const provenance = this.createProvenance(build, {
      parameters: {
        releaseId: release.releaseId,
        buildId,
        targets,
        baselineVersion: baseline?.fromVersion,
      },
    });
    this.store.upsertBuildProvenance(provenance);
    let queueId: string | undefined;
    if (this.config.jenkinsBaseUrl && this.config.jenkinsJob) {
      queueId = await this.triggerJenkinsBuild(release, build, baseline);
      build.jenkinsQueueId = queueId;
      build.status = "queued";
      build.updatedAt = nowIso();
      this.store.upsertBuild(build);
    } else {
      build.status = "queued";
      build.updatedAt = nowIso();
      this.store.upsertBuild(build);
    }
    this.recordEvent({
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      objectType: "build",
      objectId: buildId,
      eventType: "build.triggered",
      payload: { releaseId: release.releaseId, jenkinsQueueId: queueId ?? null },
      createdBy: input.operator,
    });
    return {
      releaseId: release.releaseId,
      buildId,
      status: build.status,
      jenkinsJob: build.jenkinsJob,
      jenkinsQueueId: queueId,
    };
  }

  private async triggerJenkinsBuild(
    release: ReleaseRecord,
    build: BuildRecord,
    _baseline: BaselineRecord | null,
  ): Promise<string | undefined> {
    if (!this.config.jenkinsBaseUrl || !this.config.jenkinsJob) {
      return undefined;
    }
    if (!this.config.publicBaseUrl) {
      throw new Error("publicBaseUrl is required for Jenkins lobster callbacks");
    }
    const url = `${this.config.jenkinsBaseUrl}/job/${encodeURIComponent(this.config.jenkinsJob)}/buildWithParameters`;
    const ciBaseUrl = this.config.publicBaseUrl ?? "";
    const ciRoutePrefix = this.config.ciRoutePrefix;
    const buildTargets = [
      build.targets.androidApk ? "android_apk" : "",
      build.targets.androidAab ? "android_aab" : "",
      build.targets.macosApp ? "macos_app" : "",
      build.targets.patch ? "patch" : "",
    ]
      .filter(Boolean)
      .join(",");
    const lobsterPlatform =
      build.targets.macosApp && !build.targets.androidApk && !build.targets.androidAab
        ? "macos"
        : "android";
    const params = new URLSearchParams({
      GIT_URL: release.git.url ?? "",
      GIT_BRANCH: release.git.branch ?? "main",
      GIT_COMMIT: release.git.commit ?? "",
      BUILD_ANDROID_APK: String(build.targets.androidApk),
      BUILD_ANDROID_AAB: String(build.targets.androidAab),
      BUILD_MACOS_APP: String(build.targets.macosApp),
      BUILD_PATCH: String(build.targets.patch),
      BUILD_TARGETS: buildTargets,
      APP_VERSION: release.version,
      RESOURCE_VERSION: release.version,
      LOBSTER_RESOLVE_BASELINE: String(build.targets.patch),
      LOBSTER_NOTIFY_BUILD_START: "true",
      LOBSTER_NOTIFY_PUBLISH: "true",
      LOBSTER_NOTIFY_BUILD_FINISH: "true",
      LOBSTER_API_BASE_URL: ciBaseUrl,
      LOBSTER_CHANNEL: release.channel,
      LOBSTER_PLATFORM: lobsterPlatform,
      LOBSTER_TIMEOUT_SECONDS: "15",
      LOBSTER_ENDPOINT_RESOLVE_BASELINE: `${ciRoutePrefix}/builds/resolve-baseline`,
      LOBSTER_ENDPOINT_BUILD_START: `${ciRoutePrefix}/builds/start`,
      LOBSTER_ENDPOINT_PUBLISH: `${ciRoutePrefix}/builds/publish`,
      LOBSTER_ENDPOINT_FINISH: `${ciRoutePrefix}/builds/finish`,
      UPLOAD_ARTIFACTS: "true",
      RELEASE_ID: release.releaseId,
      BUILD_ID: build.buildId,
    });
    if (this.config.jenkinsLobsterApiKeyCredentialsId) {
      params.set("LOBSTER_API_KEY_CREDENTIALS_ID", this.config.jenkinsLobsterApiKeyCredentialsId);
    }
    if (this.config.jenkinsLobsterApiSecretCredentialsId) {
      params.set(
        "LOBSTER_API_SECRET_CREDENTIALS_ID",
        this.config.jenkinsLobsterApiSecretCredentialsId,
      );
    }
    if (this.config.jenkinsAndroidKeystoreBase64CredentialsId) {
      params.set(
        "ANDROID_KEYSTORE_BASE64_CREDENTIALS_ID",
        this.config.jenkinsAndroidKeystoreBase64CredentialsId,
      );
    }
    if (this.config.jenkinsAndroidKeystoreAliasCredentialsId) {
      params.set(
        "ANDROID_KEYSTORE_ALIAS_CREDENTIALS_ID",
        this.config.jenkinsAndroidKeystoreAliasCredentialsId,
      );
    }
    if (this.config.jenkinsAndroidKeystorePasswordCredentialsId) {
      params.set(
        "ANDROID_KEYSTORE_PASSWORD_CREDENTIALS_ID",
        this.config.jenkinsAndroidKeystorePasswordCredentialsId,
      );
    }
    if (this.config.uploadDestinationDir) {
      params.set("UPLOAD_DESTINATION_DIR", this.config.uploadDestinationDir);
    }
    if (this.config.uploadBaseUrl) {
      params.set("UPLOAD_BASE_URL", this.config.uploadBaseUrl);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (this.config.jenkinsUser && this.config.jenkinsApiToken) {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.config.jenkinsUser}:${this.config.jenkinsApiToken}`,
      ).toString("base64")}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: params.toString(),
      redirect: "manual",
    });
    if (!(response.ok || (response.status >= 300 && response.status < 400))) {
      throw new Error(`jenkins trigger failed with status ${response.status}`);
    }
    const location = response.headers.get("location") ?? undefined;
    if (!location) {
      return undefined;
    }
    const queueMatch = /\/queue\/item\/(\d+)\/?$/i.exec(location);
    return queueMatch?.[1];
  }

  private createProvenance(
    build: BuildRecord,
    overrides?: Partial<
      Omit<
        BuildProvenanceRecord,
        | "provenanceId"
        | "buildId"
        | "releaseId"
        | "projectId"
        | "projectKey"
        | "capturedAt"
        | "provenanceHash"
      >
    >,
  ): BuildProvenanceRecord {
    const payload = {
      commit: build.sourceGitCommit,
      branch: build.sourceGitBranch,
      targets: build.targets,
      baselineVersion: build.baselineVersion,
      baselineManifestUrl: build.baselineManifestUrl,
      jenkinsJob: build.jenkinsJob,
      jenkinsBuildNumber: build.jenkinsBuildNumber,
    };
    const capturedAt = nowIso();
    return {
      provenanceId: createId("prov"),
      buildId: build.buildId,
      releaseId: build.releaseId,
      projectId: build.projectId,
      projectKey: build.projectKey,
      sourceGitUrl: build.sourceGitUrl,
      sourceGitBranch: build.sourceGitBranch,
      sourceGitCommit: build.sourceGitCommit,
      sourceGitCommitShort: build.sourceGitCommitShort,
      jenkinsJob: build.jenkinsJob,
      jenkinsBuildNumber: build.jenkinsBuildNumber,
      jenkinsQueueId: build.jenkinsQueueId,
      exportPresets: [],
      buildTargets: Object.entries(build.targets)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key),
      baselineVersion: build.baselineVersion,
      baselineManifestUrl: build.baselineManifestUrl,
      envSnapshot: {},
      parameters: payload,
      provenanceHash: sha256Text(JSON.stringify(payload)),
      capturedAt,
      ...overrides,
    };
  }

  recordBuildStart(
    buildId: string,
    payload: {
      jenkinsJob?: string;
      jenkinsBuildNumber?: number;
      jenkinsQueueId?: string;
      executorNode?: string;
      executorLabel?: string;
      startedAt?: string;
    },
  ): BuildRecord {
    const build = this.store.getBuild(buildId);
    if (!build) {
      throw new Error(`build not found: ${buildId}`);
    }
    const next: BuildRecord = {
      ...build,
      status: "building",
      jenkinsJob: payload.jenkinsJob ?? build.jenkinsJob,
      jenkinsBuildNumber: payload.jenkinsBuildNumber ?? build.jenkinsBuildNumber,
      jenkinsQueueId: payload.jenkinsQueueId ?? build.jenkinsQueueId,
      startedAt: payload.startedAt ?? build.startedAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    this.store.upsertBuild(next);
    const currentProvenance = this.store.getBuildProvenance(buildId) ?? this.createProvenance(next);
    this.store.upsertBuildProvenance({
      ...currentProvenance,
      jenkinsJob: next.jenkinsJob,
      jenkinsBuildNumber: next.jenkinsBuildNumber,
      jenkinsQueueId: next.jenkinsQueueId,
      executorNode: payload.executorNode,
      executorLabel: payload.executorLabel,
      capturedAt: nowIso(),
      provenanceHash: sha256Text(
        JSON.stringify({
          ...currentProvenance.parameters,
          executorNode: payload.executorNode,
          executorLabel: payload.executorLabel,
          jenkinsBuildNumber: next.jenkinsBuildNumber,
        }),
      ),
    });
    return next;
  }

  async recordBuildPublish(
    buildId: string,
    payload: {
      environment?: ReleaseEnvironment;
      channel?: ReleaseChannel;
      artifacts: Array<{
        artifactType?: string;
        type?: string;
        platform: string;
        fileName: string;
        fileSizeBytes?: number;
        sha256: string;
        storageProvider: string;
        storageBucket?: string;
        storagePath: string;
        downloadUrl?: string;
        manifestRole?: string;
      }>;
    },
  ): Promise<{ build: BuildRecord; manifest: ReleaseManifest }> {
    const build = this.store.getBuild(buildId);
    if (!build) {
      throw new Error(`build not found: ${buildId}`);
    }
    const release = this.store.getRelease(build.releaseId);
    if (!release) {
      throw new Error(`release not found: ${build.releaseId}`);
    }
    const artifacts = payload.artifacts.filter((artifact) =>
      this.belongsToCurrentBuild(release, build, artifact),
    );
    for (const artifact of artifacts) {
      const downloadUrl =
        artifact.downloadUrl ??
        this.buildArtifactUrl(release, artifact.platform, artifact.fileName);
      const record: ArtifactRecord = {
        artifactId: createId("art"),
        buildId: build.buildId,
        releaseId: release.releaseId,
        projectId: release.projectId,
        projectKey: release.projectKey,
        environment: payload.environment ?? release.environment,
        channel: payload.channel ?? release.channel,
        artifactType: (artifact.artifactType ??
          artifact.type ??
          "manifest") as ArtifactRecord["artifactType"],
        platform: artifact.platform,
        fileName: artifact.fileName,
        fileSizeBytes: artifact.fileSizeBytes ?? 0,
        sha256: artifact.sha256,
        storageProvider: artifact.storageProvider,
        storageBucket: artifact.storageBucket,
        storagePath: artifact.storagePath,
        downloadUrl,
        manifestRole: artifact.manifestRole,
        immutable: true,
        createdAt: nowIso(),
      };
      this.store.insertArtifact(record);
    }
    const skippedArtifacts = payload.artifacts.length - artifacts.length;
    if (skippedArtifacts > 0) {
      this.logger.warn(
        `[lobster-release] filtered ${skippedArtifacts} stale artifact(s) for release ${release.version} build ${build.jenkinsBuildNumber ?? "unknown"}`,
      );
    }
    const updatedBuild: BuildRecord = {
      ...build,
      status: "uploaded",
      updatedAt: nowIso(),
    };
    this.store.upsertBuild(updatedBuild);
    const manifest = await this.generateManifest(release.releaseId, build.buildId);
    return { build: updatedBuild, manifest };
  }

  async recordBuildFinish(
    buildId: string,
    payload: {
      status: "success" | "failed" | "canceled";
      summary?: string;
      durationSeconds?: number;
      reports?: Record<string, unknown>;
      artifactsCount?: number;
      error?: unknown;
    },
  ): Promise<{ build: BuildRecord; release: ReleaseRecord }> {
    const build = this.store.getBuild(buildId);
    if (!build) {
      throw new Error(`build not found: ${buildId}`);
    }
    const release = this.store.getRelease(build.releaseId);
    if (!release) {
      throw new Error(`release not found: ${build.releaseId}`);
    }
    const nextBuild: BuildRecord = {
      ...build,
      status:
        payload.status === "success"
          ? "finished"
          : payload.status === "failed"
            ? "failed"
            : "canceled",
      result: payload.status,
      reports: payload.reports,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.upsertBuild(nextBuild);
    const nextRelease: ReleaseRecord = {
      ...release,
      status:
        payload.status === "success"
          ? release.channel === "dev" && this.config.autoPublishDev
            ? "published"
            : "awaiting_approval"
          : "failed",
      stable: payload.status === "success" && release.channel === "dev",
      updatedAt: nowIso(),
      publishedAt:
        payload.status === "success" && release.channel === "dev" && this.config.autoPublishDev
          ? nowIso()
          : release.publishedAt,
    };
    this.store.upsertRelease(nextRelease);
    if (nextRelease.status === "published") {
      this.publishChannelPointer(nextRelease, "auto-dev");
    }
    this.recordEvent({
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      objectType: "build",
      objectId: buildId,
      eventType: `build.${payload.status}`,
      payload: { summary: payload.summary ?? null, reports: payload.reports ?? null },
    });
    return { build: nextBuild, release: nextRelease };
  }

  async approveRelease(releaseId: string, operator = "system"): Promise<ReleaseRecord> {
    const release = this.store.getRelease(releaseId);
    if (!release) {
      throw new Error(`release not found: ${releaseId}`);
    }
    if (release.frozen) {
      throw new Error(`release is frozen: ${releaseId}`);
    }
    this.acquireChannelLock({
      projectKey: release.projectKey,
      environment: release.environment,
      channel: release.channel,
      owner: operator,
      reason: "approve-release",
    });
    try {
      const next: ReleaseRecord = {
        ...release,
        status: "published",
        stable: true,
        publishedAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.store.upsertRelease(next);
      this.publishChannelPointer(next, operator);
      if (next.currentBuildId) {
        await this.generateManifest(next.releaseId, next.currentBuildId);
      }
      this.recordEvent({
        projectId: release.projectId,
        projectKey: release.projectKey,
        environment: release.environment,
        objectType: "release",
        objectId: releaseId,
        eventType: "release.approved",
        payload: { channel: release.channel },
        createdBy: operator,
      });
      return next;
    } finally {
      this.releaseChannelLock(release.projectKey, release.environment, release.channel);
    }
  }

  private publishChannelPointer(release: ReleaseRecord, operator: string): void {
    const existing = this.getChannelState(release.projectKey, release.environment, release.channel);
    const state: ChannelStateRecord = {
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      channel: release.channel,
      currentReleaseId: release.releaseId,
      previousReleaseId:
        existing?.currentReleaseId && existing.currentReleaseId !== release.releaseId
          ? existing.currentReleaseId
          : existing?.previousReleaseId,
      updatedAt: nowIso(),
      updatedBy: operator,
    };
    this.store.upsertChannelState(state);
    if (existing?.currentReleaseId && existing.currentReleaseId !== release.releaseId) {
      this.store.insertReleaseRelation({
        relationId: createId("reln"),
        projectId: release.projectId,
        projectKey: release.projectKey,
        fromReleaseId: existing.currentReleaseId,
        toReleaseId: release.releaseId,
        relationType: "promoted_from",
        context: { channel: release.channel, environment: release.environment },
        createdBy: operator,
        createdAt: nowIso(),
      });
      this.store.insertReleaseRelation({
        relationId: createId("reln"),
        projectId: release.projectId,
        projectKey: release.projectKey,
        fromReleaseId: existing.currentReleaseId,
        toReleaseId: release.releaseId,
        relationType: "replaced_by",
        context: { channel: release.channel, environment: release.environment },
        createdBy: operator,
        createdAt: nowIso(),
      });
    }
  }

  async createRollback(input: RollbackInput): Promise<RollbackOperationRecord> {
    const channelState = this.getChannelState(input.projectKey, input.environment, input.channel);
    if (!channelState?.currentReleaseId) {
      throw new Error(
        `no current release for ${input.projectKey}/${input.environment}/${input.channel}`,
      );
    }
    const fromRelease = this.store.getRelease(channelState.currentReleaseId);
    const toRelease = this.store.getRelease(input.targetReleaseId);
    if (!fromRelease || !toRelease) {
      throw new Error("rollback target or source release not found");
    }
    if (toRelease.environment !== input.environment || toRelease.projectKey !== input.projectKey) {
      throw new Error("rollback target must belong to same project and environment");
    }
    if (!toRelease.stable) {
      throw new Error("rollback target must be stable");
    }
    const rollback: RollbackOperationRecord = {
      rollbackId: createId("rbk"),
      projectId: fromRelease.projectId,
      projectKey: input.projectKey,
      environment: input.environment,
      channel: input.channel,
      fromReleaseId: fromRelease.releaseId,
      toReleaseId: toRelease.releaseId,
      status: "requested",
      reason: input.reason,
      triggeredBy: input.operator,
      strategy: input.strategy,
      freezeCurrentRelease: input.freezeCurrentRelease,
      manifestAction: {
        comment: input.comment,
      },
      createdAt: nowIso(),
    };
    this.store.upsertRollback(rollback);
    return rollback;
  }

  approveRollback(rollbackId: string, approver: string): RollbackOperationRecord {
    const rollback = this.store.getRollback(rollbackId);
    if (!rollback) {
      throw new Error(`rollback not found: ${rollbackId}`);
    }
    const current = this.store.getRelease(rollback.fromReleaseId);
    const target = this.store.getRelease(rollback.toReleaseId);
    if (!current || !target) {
      throw new Error("rollback release records missing");
    }
    this.acquireChannelLock({
      projectKey: rollback.projectKey,
      environment: rollback.environment,
      channel: rollback.channel,
      owner: approver,
      reason: "rollback",
    });
    try {
      const executing: RollbackOperationRecord = {
        ...rollback,
        status: "executing",
        approvedBy: approver,
      };
      this.store.upsertRollback(executing);
      const state = this.getChannelState(
        rollback.projectKey,
        rollback.environment,
        rollback.channel,
      );
      this.store.upsertChannelState({
        projectId: current.projectId,
        projectKey: rollback.projectKey,
        environment: rollback.environment,
        channel: rollback.channel,
        currentReleaseId: target.releaseId,
        previousReleaseId: state?.currentReleaseId,
        updatedAt: nowIso(),
        updatedBy: approver,
      });
      if (rollback.freezeCurrentRelease) {
        this.store.upsertRelease({
          ...current,
          frozen: true,
          updatedAt: nowIso(),
        });
      }
      this.store.upsertRelease({
        ...target,
        stable: true,
        updatedAt: nowIso(),
      });
      this.store.insertReleaseRelation({
        relationId: createId("reln"),
        projectId: current.projectId,
        projectKey: rollback.projectKey,
        fromReleaseId: current.releaseId,
        toReleaseId: target.releaseId,
        relationType: "rolled_back_to",
        context: { channel: rollback.channel, environment: rollback.environment, rollbackId },
        createdBy: approver,
        createdAt: nowIso(),
      });
      const completed: RollbackOperationRecord = {
        ...executing,
        status: "completed",
        completedAt: nowIso(),
      };
      this.store.upsertRollback(completed);
      this.recordEvent({
        projectId: current.projectId,
        projectKey: rollback.projectKey,
        environment: rollback.environment,
        objectType: "rollback",
        objectId: rollbackId,
        eventType: "rollback.completed",
        payload: { fromReleaseId: current.releaseId, toReleaseId: target.releaseId },
        createdBy: approver,
      });
      return completed;
    } finally {
      this.releaseChannelLock(rollback.projectKey, rollback.environment, rollback.channel);
    }
  }

  cancelRollback(rollbackId: string): RollbackOperationRecord {
    const rollback = this.store.getRollback(rollbackId);
    if (!rollback) {
      throw new Error(`rollback not found: ${rollbackId}`);
    }
    const next: RollbackOperationRecord = {
      ...rollback,
      status: "canceled",
      completedAt: nowIso(),
    };
    this.store.upsertRollback(next);
    return next;
  }

  resolveCiBaseline(request: CiBuildRequest): {
    strategy: "incremental" | "full";
    baselineVersion: string;
    baselineManifestUrl: string;
    baselinePackageUrl: string;
    baselineSha256: string;
  } {
    const targets = this.buildTargetsFromCi(request);
    if (!targets.patch) {
      return {
        strategy: "full",
        baselineVersion: "",
        baselineManifestUrl: "",
        baselinePackageUrl: "",
        baselineSha256: "",
      };
    }
    const baseline = this.resolveBaseline({
      projectKey: this.config.defaultProjectKey,
      environment: this.config.defaultEnvironment,
      channel: this.normalizeCiChannel(request.app?.channel),
      targetVersion: this.versionFromCi(request),
      platform: this.platformFromCi(request, targets),
    });
    if (!baseline || baseline.compatibilityRule !== "reuse") {
      return {
        strategy: "full",
        baselineVersion: "",
        baselineManifestUrl: "",
        baselinePackageUrl: "",
        baselineSha256: "",
      };
    }
    const baselineRelease = baseline.fromReleaseId
      ? this.store.getRelease(baseline.fromReleaseId)
      : null;
    const baselineBundle = baselineRelease ? this.baselinePackageForRelease(baselineRelease) : null;
    return {
      strategy: "incremental",
      baselineVersion: baseline.fromVersion,
      baselineManifestUrl: baseline.baselineManifestUrl,
      baselinePackageUrl: baselineBundle?.downloadUrl ?? "",
      baselineSha256: baselineBundle?.sha256 ?? "",
    };
  }

  recordCiBuildStart(request: CiBuildRequest): BuildRecord {
    const { build, release } = this.ensureCiBuild(request);
    const next = this.recordBuildStart(build.buildId, {
      jenkinsJob: request.jobName?.trim() || build.jenkinsJob,
      jenkinsBuildNumber: this.parseCiBuildNumber(request.buildNumber) ?? build.jenkinsBuildNumber,
      startedAt: nowIso(),
    });
    this.recordEvent({
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      objectType: "build",
      objectId: next.buildId,
      eventType: "ci.build.started",
      requestId: request.requestId,
      payload: {
        jobName: request.jobName,
        buildNumber: request.buildNumber,
        pipelineUrl: request.pipelineUrl,
      },
      createdBy: "jenkins-ci",
    });
    return next;
  }

  async recordCiBuildPublish(
    request: CiPublishRequest,
  ): Promise<{ build: BuildRecord; manifest: ReleaseManifest }> {
    const { build, release } = this.ensureCiBuild(request);
    const result = await this.recordBuildPublish(build.buildId, {
      environment: release.environment,
      channel: release.channel,
      artifacts: (request.artifacts ?? []).map((artifact) =>
        this.mapCiArtifactForBuild(release, request, artifact),
      ),
    });
    const nextBuild: BuildRecord = {
      ...result.build,
      reports: {
        ...result.build.reports,
        ...request.reports,
      },
    };
    this.store.upsertBuild(nextBuild);
    this.recordEvent({
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      objectType: "build",
      objectId: build.buildId,
      eventType: "ci.build.published",
      requestId: request.requestId,
      payload: {
        artifactCount: request.artifacts?.length ?? 0,
      },
      createdBy: "jenkins-ci",
    });
    return { build: nextBuild, manifest: result.manifest };
  }

  async recordCiBuildFinish(
    request: CiFinishRequest,
  ): Promise<{ build: BuildRecord; release: ReleaseRecord }> {
    const { build, release } = this.ensureCiBuild(request);
    const status =
      request.result?.toUpperCase() === "SUCCESS"
        ? "success"
        : request.result?.toUpperCase() === "ABORTED" ||
            request.result?.toUpperCase() === "CANCELED"
          ? "canceled"
          : "failed";
    const result = await this.recordBuildFinish(build.buildId, {
      status,
      summary: request.summary?.message,
      durationSeconds: request.durationSeconds,
      artifactsCount: request.summary?.artifactCount,
      reports: {
        ...build.reports,
        failedStage: request.summary?.failedStage,
        pipelineUrl: request.pipelineUrl,
      },
    });
    this.recordEvent({
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      objectType: "build",
      objectId: build.buildId,
      eventType: "ci.build.finished",
      requestId: request.requestId,
      payload: {
        result: request.result,
        durationSeconds: request.durationSeconds,
        failedStage: request.summary?.failedStage,
      },
      createdBy: "jenkins-ci",
    });
    return result;
  }

  getReleaseGraph(
    projectKey: string,
    releaseId: string,
  ): {
    releaseId: string;
    nodes: ReleaseRecord[];
    edges: ReleaseRelationRecord[];
  } {
    const base = this.store.getRelease(releaseId);
    if (!base || base.projectKey !== projectKey) {
      throw new Error(`release not found: ${releaseId}`);
    }
    const edges = this.store.listReleaseRelations(projectKey, releaseId);
    const nodeIds = new Set<string>([releaseId]);
    for (const edge of edges) {
      nodeIds.add(edge.fromReleaseId);
      nodeIds.add(edge.toReleaseId);
    }
    const nodes = [...nodeIds]
      .map((id) => this.store.getRelease(id))
      .filter((item): item is ReleaseRecord => Boolean(item));
    return {
      releaseId,
      nodes,
      edges,
    };
  }

  getChannelGraph(projectKey: string, environment: ReleaseEnvironment, channel: ReleaseChannel) {
    const releases = this.store.listReleases({ projectKey, environment, channel });
    const ids = new Set(releases.map((release) => release.releaseId));
    const edges = releases
      .flatMap((release) => this.store.listReleaseRelations(projectKey, release.releaseId))
      .filter((edge, index, all) => {
        return all.findIndex((item) => item.relationId === edge.relationId) === index;
      })
      .filter((edge) => ids.has(edge.fromReleaseId) || ids.has(edge.toReleaseId));
    return { nodes: releases, edges };
  }

  getBuildProvenance(buildId: string) {
    const record = this.store.getBuildProvenance(buildId);
    if (!record) {
      throw new Error(`provenance not found for build: ${buildId}`);
    }
    return record;
  }

  getReleaseProvenance(releaseId: string, mode: "latest" | "all" = "latest") {
    const records = this.store.listReleaseProvenance(releaseId);
    return mode === "latest" ? (records[0] ?? null) : records;
  }

  private mapCiArtifactForBuild(
    release: ReleaseRecord,
    request: CiPublishRequest,
    artifact: CiPublishArtifact,
  ): {
    artifactType?: string;
    type?: string;
    platform: string;
    fileName: string;
    fileSizeBytes?: number;
    sha256: string;
    storageProvider: string;
    storagePath: string;
    downloadUrl?: string;
    manifestRole?: string;
  } {
    const target = artifact.target?.trim().toLowerCase() ?? "unknown";
    const fileName = artifact.name?.trim() || path.basename(artifact.relativePath?.trim() || "");
    const relativePath = artifact.relativePath?.trim() || fileName;
    const platform =
      target === "macos_app"
        ? "macos"
        : target === "android_apk" || target === "android_aab" || target === "patch"
          ? "android"
          : this.platformFromCi(request);
    const nameLower = fileName.toLowerCase();
    const artifactType =
      target === "android_apk"
        ? "android_apk"
        : target === "android_aab"
          ? "android_aab"
          : target === "macos_app"
            ? "macos_zip"
            : nameLower === "manifest.json"
              ? "patch_manifest"
              : nameLower === "patch_list.json"
                ? "patch_list"
                : nameLower === "build_report.json"
                  ? "build_report"
                  : nameLower === "bundle_layout.json"
                    ? "bundle_layout"
                    : nameLower === "release_manifest.json"
                      ? "manifest"
                      : target === "patch"
                        ? "patch_bundle"
                        : "manifest";
    const manifestRole =
      nameLower === "manifest.json"
        ? "patch_manifest"
        : nameLower === "patch_list.json"
          ? "patch_list"
          : undefined;
    return {
      artifactType,
      type: artifactType,
      platform,
      fileName,
      fileSizeBytes: artifact.sizeBytes ?? 0,
      sha256: artifact.sha256 ?? "",
      storageProvider: artifact.downloadUrl ? "cdn" : artifact.uploadedPath ? "local" : "unknown",
      storagePath: artifact.uploadedPath?.trim() || relativePath,
      downloadUrl:
        artifact.downloadUrl?.trim() || this.buildArtifactUrl(release, platform, fileName),
      manifestRole,
    };
  }

  private buildArtifactUrl(release: ReleaseRecord, platform: string, fileName: string): string {
    const base = this.config.publicBaseUrl ?? "";
    return `${base}/${release.projectKey}/${release.environment}/${release.channel}/${release.version}/${platform}/${fileName}`.replace(
      /(?<!:)\/{2,}/g,
      "/",
    );
  }

  private belongsToCurrentBuild(
    release: ReleaseRecord,
    build: BuildRecord,
    artifact: {
      artifactType?: string;
      fileName: string;
    },
  ): boolean {
    const artifactType = artifact.artifactType ?? "manifest";
    const scopedByRelease =
      artifactType === "android_apk" ||
      artifactType === "android_aab" ||
      artifactType === "macos_zip" ||
      (artifactType === "patch_bundle" && artifact.fileName.toLowerCase().endsWith(".zip"));
    if (!scopedByRelease) {
      return true;
    }
    const versionToken = release.version.toLowerCase();
    const fileName = artifact.fileName.toLowerCase();
    if (!fileName.includes(versionToken)) {
      return false;
    }
    if (!build.jenkinsBuildNumber) {
      return true;
    }
    return new RegExp(`(^|[._-])${build.jenkinsBuildNumber}([._-]|$)`).test(fileName);
  }

  private manifestFilePath(release: ReleaseRecord): string {
    return path.join(
      this.manifestsDir,
      release.projectKey,
      release.environment,
      release.channel,
      release.version,
      "release_manifest.json",
    );
  }

  getManifestFilePath(
    projectKey: string,
    environment: ReleaseEnvironment,
    channel: ReleaseChannel,
    version: string,
  ): string {
    return path.join(
      this.manifestsDir,
      projectKey,
      environment,
      channel,
      version,
      "release_manifest.json",
    );
  }

  private manifestPublicUrl(release: ReleaseRecord): string | undefined {
    if (!this.config.publicBaseUrl) {
      return undefined;
    }
    return `${this.config.publicBaseUrl}${this.config.routePrefix}/manifests/${release.projectKey}/${release.environment}/${release.channel}/${release.version}/release_manifest.json`;
  }

  private canonicalManifestUrlForRelease(release: ReleaseRecord): string | undefined {
    return this.manifestPublicUrl(release) ?? release.manifestUrl;
  }

  async generateManifest(releaseId: string, buildId: string): Promise<ReleaseManifest> {
    const release = this.store.getRelease(releaseId);
    const build = this.store.getBuild(buildId);
    const provenance = this.store.getBuildProvenance(buildId);
    if (!release || !build || !provenance) {
      throw new Error("missing release, build, or provenance for manifest generation");
    }
    const artifacts = this.store
      .listArtifactsForBuild(buildId)
      .filter((artifact) => this.belongsToCurrentBuild(release, build, artifact));
    const baseline =
      build.baselineVersion || build.baselineManifestUrl
        ? {
            version: build.baselineVersion,
            manifestUrl: build.baselineManifestUrl,
            strategy:
              release.versionBumpType === "major"
                ? ("reset" as const)
                : release.versionBumpType === "minor"
                  ? ("validate" as const)
                  : ("reuse" as const),
          }
        : undefined;
    const patchBundle = this.selectPatchBundleArtifact(artifacts);
    const patchManifest = artifacts.find((artifact) => artifact.artifactType === "patch_manifest");
    const manifest: ReleaseManifest = {
      manifestVersion: 1,
      project: release.projectKey,
      environment: release.environment,
      channel: release.channel,
      releaseId: release.releaseId,
      buildId: build.buildId,
      version: release.version,
      displayVersion: release.displayVersion,
      status: "published",
      stable: release.stable,
      frozen: release.frozen,
      rollbackTarget: this.getChannelState(release.projectKey, release.environment, release.channel)
        ?.previousReleaseId,
      publishedAt: release.publishedAt,
      git: {
        branch: release.git.branch,
        commit: release.git.commit,
        commitShort: release.git.commitShort,
        tag: release.git.tag,
      },
      provenance: {
        hash: provenance.provenanceHash,
        jenkinsJob: build.jenkinsJob,
        jenkinsBuildNumber: build.jenkinsBuildNumber,
      },
      compatibility: {
        minClientVersion: `${release.versionMajor}.${release.versionMinor}.0`,
        resourceProtocolVersion: release.versionBumpType === "major" ? 2 : 1,
        minManifestVersion: 1,
      },
      baseline,
      artifacts: artifacts.map((artifact) => ({
        type: artifact.artifactType,
        platform: artifact.platform,
        fileName: artifact.fileName,
        downloadUrl: artifact.downloadUrl,
        sha256: artifact.sha256,
        sizeBytes: artifact.fileSizeBytes,
        manifestRole: artifact.manifestRole,
      })),
      patch: build.targets.patch
        ? {
            enabled: true,
            manifestUrl: patchManifest?.downloadUrl,
            bundleUrl: patchBundle?.downloadUrl,
            riskLevel:
              release.versionBumpType === "major"
                ? "high"
                : release.versionBumpType === "minor"
                  ? "medium"
                  : "low",
          }
        : undefined,
      metadata: {
        notes: release.notes,
      },
    };
    const filePath = this.manifestFilePath(release);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const manifestUrl = this.manifestPublicUrl(release);
    this.store.upsertRelease({
      ...release,
      manifestPath: filePath,
      manifestUrl,
      updatedAt: nowIso(),
    });
    return manifest;
  }
}
