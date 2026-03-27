import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk/lobster";
import type { LobsterReleaseConfig, LobsterReleaseProjectPolicy } from "./config.js";
import { LobsterReleaseStore } from "./store.js";
import type {
  ArtifactRecord,
  BaselineRecord,
  CiBuildRequest,
  CiBuildEnvironmentInfo,
  CiFinishRequest,
  CiPublishArtifact,
  CiPublishRequest,
  BuildProvenanceRecord,
  BuildRecord,
  BuildTargets,
  ChannelStateRecord,
  CreateReleaseInput,
  EventLogRecord,
  NotificationOutboxRecord,
  ProjectRecord,
  ReleaseChannel,
  ReleaseEnvironment,
  ReleaseManifest,
  ReleaseRecord,
  ReleaseRelationRecord,
  RolloutRecord,
  RollbackInput,
  RollbackOperationRecord,
  CreateRolloutInput,
  AdvanceRolloutInput,
  CancelRolloutInput,
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

const NOTIFICATION_SENDING_TIMEOUT_MS = 5 * 60_000;
const NOTIFICATION_RETRY_BASE_MS = 60_000;
const NOTIFICATION_MAX_ATTEMPTS = 5;
const TERMINAL_BUILD_STATUSES = new Set<BuildRecord["status"]>(["finished", "failed", "canceled"]);
const ACTIVE_ROLLOUT_STATUSES = new Set<RolloutRecord["status"]>(["draft", "active", "paused"]);
const PATCH_CONFLICT_PATH_SEPARATOR = "/";
const CALLBACK_NONCE_TTL_MS = 10 * 60_000;

type StoredIdempotencyResponse = {
  statusCode: number;
  responseBody: unknown;
  requestHash: string;
};

function buildStatusRank(status: BuildRecord["status"]): number {
  switch (status) {
    case "triggering":
      return 0;
    case "queued":
      return 1;
    case "building":
      return 2;
    case "uploaded":
      return 3;
    case "finished":
    case "failed":
    case "canceled":
      return 4;
  }
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
    const policy = this.getProjectPolicy(projectKey);
    const now = nowIso();
    const project: ProjectRecord = {
      projectId: createId("prj"),
      projectKey,
      name: policy.name ?? projectKey,
      engine: policy.engine ?? "godot",
      defaultChannel: policy.defaultChannel ?? "dev",
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

  private recordEvent(params: Omit<EventLogRecord, "eventId" | "createdAt">): EventLogRecord {
    const event = {
      ...params,
      eventId: createId("evt"),
      createdAt: nowIso(),
    };
    this.store.insertEvent(event);
    return event;
  }

  private queueNotification(params: {
    event: EventLogRecord;
    dedupeKey: string;
    payload: Record<string, unknown>;
    deliveryChannel?: NotificationOutboxRecord["deliveryChannel"];
  }): NotificationOutboxRecord {
    const deliveryChannel = params.deliveryChannel ?? "feishu";
    const existing = this.store.getNotificationByDedupeKey(deliveryChannel, params.dedupeKey);
    if (existing) {
      return existing;
    }
    const now = nowIso();
    const record: NotificationOutboxRecord = {
      notificationId: createId("ntf"),
      eventId: params.event.eventId,
      projectId: params.event.projectId,
      projectKey: params.event.projectKey,
      environment: params.event.environment,
      channel: (params.payload.channel as ReleaseChannel | undefined) ?? undefined,
      eventType: params.event.eventType,
      deliveryChannel,
      status: "pending",
      dedupeKey: params.dedupeKey,
      payload: params.payload,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertNotification(record);
    return this.store.getNotificationByDedupeKey(deliveryChannel, params.dedupeKey) ?? record;
  }

  getIdempotencyReceipt(scope: string, idempotencyKey: string): StoredIdempotencyResponse | null {
    const record = this.store.getIdempotencyReceipt(scope, idempotencyKey);
    if (!record) {
      return null;
    }
    return {
      statusCode: record.statusCode,
      responseBody: record.responseBody,
      requestHash: record.requestHash,
    };
  }

  recordIdempotencyReceipt(
    scope: string,
    idempotencyKey: string,
    requestHash: string,
    statusCode: number,
    responseBody: unknown,
  ): void {
    const now = nowIso();
    this.store.upsertIdempotencyReceipt({
      receiptKey: `${scope}:${idempotencyKey}`,
      scope,
      idempotencyKey,
      requestHash,
      statusCode,
      responseBody,
      createdAt: now,
      updatedAt: now,
    });
  }

  recordSystemEvent(
    params: Omit<EventLogRecord, "eventId" | "createdAt" | "projectId">,
  ): EventLogRecord {
    const project = this.ensureProject(params.projectKey);
    return this.recordEvent({
      ...params,
      projectId: project.projectId,
    });
  }

  private getProjectPolicy(projectKey: string): LobsterReleaseProjectPolicy {
    return (
      this.config.projects[projectKey] ??
      this.config.projects[this.config.defaultProjectKey] ?? {
        environments: ["test", "staging", "production"],
        channels: ["dev", "beta", "release"],
        requiresApproval: { beta: true, release: true },
        regions: [],
        audiences: [],
        grayRelease: {
          enabled: false,
          rolloutPercentages: [5, 10, 25, 50, 100],
          stickiness: "account",
        },
        scheduledBuilds: [],
        smokeWorkflows: [],
      }
    );
  }

  private resolveProjectEnvironment(projectKey: string, environment?: string): ReleaseEnvironment {
    const policy = this.getProjectPolicy(projectKey);
    const resolved = (
      typeof environment === "string" && environment
        ? environment
        : (policy.defaultEnvironment ?? this.config.defaultEnvironment)
    ) as ReleaseEnvironment;
    if (!policy.environments.includes(resolved)) {
      throw new Error(`project environment is not allowed: ${projectKey}/${resolved}`);
    }
    return resolved;
  }

  private resolveProjectChannel(projectKey: string, channel?: string): ReleaseChannel {
    const policy = this.getProjectPolicy(projectKey);
    const resolved = (
      typeof channel === "string" && channel
        ? channel
        : (policy.defaultChannel ?? this.config.defaultChannel)
    ) as ReleaseChannel;
    if (!policy.channels.includes(resolved)) {
      throw new Error(`project channel is not allowed: ${projectKey}/${resolved}`);
    }
    return resolved;
  }

  private assertProjectScope(
    projectKey: string,
    environment: ReleaseEnvironment,
    channel: ReleaseChannel,
    scope?: {
      region?: string;
      audience?: string;
    },
  ): void {
    const policy = this.getProjectPolicy(projectKey);
    if (!policy.environments.includes(environment)) {
      throw new Error(`project environment is not allowed: ${projectKey}/${environment}`);
    }
    if (!policy.channels.includes(channel)) {
      throw new Error(`project channel is not allowed: ${projectKey}/${channel}`);
    }
    if (scope?.region && policy.regions.length > 0 && !policy.regions.includes(scope.region)) {
      throw new Error(`project region is not allowed: ${projectKey}/${scope.region}`);
    }
    if (
      scope?.audience &&
      policy.audiences.length > 0 &&
      !policy.audiences.includes(scope.audience)
    ) {
      throw new Error(`project audience is not allowed: ${projectKey}/${scope.audience}`);
    }
  }

  private autoPublishDevForProject(projectKey: string): boolean {
    const policy = this.getProjectPolicy(projectKey);
    return typeof policy.autoPublishDev === "boolean"
      ? policy.autoPublishDev
      : this.config.autoPublishDev;
  }

  private requiresApproval(projectKey: string, channel: ReleaseChannel): boolean {
    const policy = this.getProjectPolicy(projectKey);
    const explicit = policy.requiresApproval[channel];
    if (typeof explicit === "boolean") {
      return explicit;
    }
    if (channel === "dev") {
      return !this.autoPublishDevForProject(projectKey);
    }
    return true;
  }

  private normalizeOptionalScopeValue(value?: string): string | undefined {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || undefined;
  }

  private activeRolloutsForChannel(
    projectKey: string,
    environment: ReleaseEnvironment,
    channel: ReleaseChannel,
  ): RolloutRecord[] {
    return this.store
      .listRollouts({
        projectKey,
        environment,
        channel,
        statuses: [...ACTIVE_ROLLOUT_STATUSES],
        limit: 100,
      })
      .filter((rollout) => ACTIVE_ROLLOUT_STATUSES.has(rollout.status));
  }

  private assertNoConflictingRollout(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    region?: string;
    audience?: string;
    releaseId?: string;
  }): void {
    const region = this.normalizeOptionalScopeValue(params.region);
    const audience = this.normalizeOptionalScopeValue(params.audience);
    const conflict = this.activeRolloutsForChannel(
      params.projectKey,
      params.environment,
      params.channel,
    ).find((rollout) => {
      if (params.releaseId && rollout.releaseId === params.releaseId) {
        return false;
      }
      return (
        this.normalizeOptionalScopeValue(rollout.scope.region) === region &&
        this.normalizeOptionalScopeValue(rollout.scope.audience) === audience
      );
    });
    if (conflict) {
      throw new Error(
        `rollout.scope_conflict: ${params.projectKey}/${params.environment}/${params.channel} already has active rollout ${conflict.rolloutId} for scope ${region ?? "*"}:${audience ?? "*"}`,
      );
    }
  }

  private assertNoBlockingRolloutForApproval(release: ReleaseRecord): void {
    const blocking = this.activeRolloutsForChannel(
      release.projectKey,
      release.environment,
      release.channel,
    ).find((rollout) => rollout.releaseId === release.releaseId);
    if (blocking) {
      throw new Error(
        `rollout.in_progress: approve-release blocked by rollout ${blocking.rolloutId}`,
      );
    }
  }

  private trafficPercentFromPolicy(
    projectKey: string,
    requestedPercent?: number,
    complete?: boolean,
  ): number {
    if (complete) {
      return 100;
    }
    if (typeof requestedPercent === "number" && requestedPercent > 0 && requestedPercent <= 100) {
      return Math.trunc(requestedPercent);
    }
    const configured = this.getProjectPolicy(projectKey).grayRelease.rolloutPercentages[0];
    return typeof configured === "number" && configured > 0 && configured <= 100 ? configured : 5;
  }

  private rolloutBucket(subjectKey: string): number {
    const digest = sha256Text(subjectKey);
    return Number.parseInt(digest.slice(0, 8), 16) % 100;
  }

  private rolloutSpecificity(rollout: RolloutRecord): number {
    return Number(Boolean(rollout.scope.region)) + Number(Boolean(rollout.scope.audience));
  }

  private matchingRolloutsForRoute(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    region?: string;
    audience?: string;
  }): RolloutRecord[] {
    const region = this.normalizeOptionalScopeValue(params.region);
    const audience = this.normalizeOptionalScopeValue(params.audience);
    return this.activeRolloutsForChannel(params.projectKey, params.environment, params.channel)
      .filter((rollout) => {
        const rolloutRegion = this.normalizeOptionalScopeValue(rollout.scope.region);
        const rolloutAudience = this.normalizeOptionalScopeValue(rollout.scope.audience);
        if (rolloutRegion && rolloutRegion !== region) {
          return false;
        }
        if (rolloutAudience && rolloutAudience !== audience) {
          return false;
        }
        return true;
      })
      .toSorted((left, right) => {
        const specificityDelta = this.rolloutSpecificity(right) - this.rolloutSpecificity(left);
        if (specificityDelta !== 0) {
          return specificityDelta;
        }
        if (right.trafficPercent !== left.trafficPercent) {
          return right.trafficPercent - left.trafficPercent;
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      });
  }

  private markRolloutsCanceled(
    projectKey: string,
    environment: ReleaseEnvironment,
    channel: ReleaseChannel,
    operator: string,
    reason: string,
  ): RolloutRecord[] {
    const active = this.activeRolloutsForChannel(projectKey, environment, channel);
    const now = nowIso();
    for (const rollout of active) {
      this.store.upsertRollout({
        ...rollout,
        status: "canceled",
        canceledAt: now,
        completedAt: rollout.completedAt ?? now,
        updatedAt: now,
        metadata: {
          ...asRecord(rollout.metadata),
          canceledBy: operator,
          canceledReason: reason,
        },
      });
      this.recordEvent({
        projectId: rollout.projectId,
        projectKey: rollout.projectKey,
        environment: rollout.environment,
        objectType: "rollout",
        objectId: rollout.rolloutId,
        eventType: "rollout.canceled",
        payload: {
          releaseId: rollout.releaseId,
          reason,
        },
        createdBy: operator,
      });
    }
    return active;
  }

  claimCallbackNonce(scope: string, nonce: string, requestHash: string): boolean {
    this.store.purgeExpiredCallbackNonces();
    const now = Date.now();
    return this.store.claimCallbackNonce({
      nonceKey: `${scope}:${nonce}`,
      scope,
      nonce,
      requestHash,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CALLBACK_NONCE_TTL_MS).toISOString(),
    });
  }

  private normalizeCiProjectKey(raw?: string): string {
    const value = raw?.trim();
    return value || this.config.defaultProjectKey;
  }

  private normalizeCiChannel(
    raw?: string,
    projectKey = this.config.defaultProjectKey,
  ): ReleaseChannel {
    const value = raw?.trim().toLowerCase();
    if (!value || value === "default") {
      return this.resolveProjectChannel(projectKey);
    }
    if (value === "dev") {
      return this.resolveProjectChannel(projectKey, "dev");
    }
    if (value === "release" || value === "stable" || value === "prod" || value === "production") {
      return this.resolveProjectChannel(projectKey, "release");
    }
    return this.resolveProjectChannel(projectKey, "beta");
  }

  private normalizeCiEnvironment(
    raw?: string,
    projectKey = this.config.defaultProjectKey,
  ): ReleaseEnvironment {
    const value = raw?.trim().toLowerCase();
    if (!value || value === "default") {
      return this.resolveProjectEnvironment(projectKey);
    }
    if (value === "test") {
      return this.resolveProjectEnvironment(projectKey, "test");
    }
    if (value === "production" || value === "prod" || value === "release") {
      return this.resolveProjectEnvironment(projectKey, "production");
    }
    return this.resolveProjectEnvironment(projectKey, "staging");
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

  suggestVersion(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    bumpType: "patch" | "minor" | "major";
  }): {
    version: string;
    bumpType: "patch" | "minor" | "major";
    source: "suggested";
    baselineStrategy: "reuse" | "validate" | "reset";
  } {
    const channelState = this.getChannelState(
      params.projectKey,
      params.environment,
      params.channel,
    );
    const currentRelease = channelState?.currentReleaseId
      ? this.store.getRelease(channelState.currentReleaseId)
      : (this.store
          .listReleases({
            projectKey: params.projectKey,
            environment: params.environment,
            channel: params.channel,
          })
          .toSorted((left, right) => compareVersions(right.version, left.version))[0] ?? null);
    const current = currentRelease ? parseVersion(currentRelease.version) : null;
    const next =
      params.bumpType === "major"
        ? { major: (current?.major ?? 0) + 1, minor: 0, patch: 0 }
        : params.bumpType === "minor"
          ? { major: current?.major ?? 0, minor: (current?.minor ?? 0) + 1, patch: 0 }
          : {
              major: current?.major ?? 0,
              minor: current?.minor ?? 0,
              patch: (current?.patch ?? 0) + 1,
            };
    return {
      version: `${next.major}.${next.minor}.${next.patch}`,
      bumpType: params.bumpType,
      source: "suggested",
      baselineStrategy:
        params.bumpType === "major" ? "reset" : params.bumpType === "minor" ? "validate" : "reuse",
    };
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

  private buildCiEnvironmentPatch(info: CiBuildEnvironmentInfo | undefined): Omit<
    Partial<BuildProvenanceRecord>,
    "parameters" | "envSnapshot" | "exportPresets"
  > & {
    exportPresets: string[];
    envSnapshot: Record<string, unknown>;
    parameters: Record<string, unknown>;
  } {
    const scriptVersions = asRecord(info?.scriptVersions);
    const extraParameters = asRecord(info?.parameters) ?? {};
    return {
      godotVersion: typeof info?.godotVersion === "string" ? info.godotVersion : undefined,
      godotBin: typeof info?.godotBin === "string" ? info.godotBin : undefined,
      dotnetVersion: typeof info?.dotnetVersion === "string" ? info.dotnetVersion : undefined,
      workspaceRevision:
        typeof info?.workspaceRevision === "string" ? info.workspaceRevision : undefined,
      configFingerprint:
        typeof info?.configFingerprint === "string" ? info.configFingerprint : undefined,
      assetGroupsFingerprint:
        typeof info?.assetGroupsFingerprint === "string" ? info.assetGroupsFingerprint : undefined,
      scriptsFingerprint:
        typeof info?.scriptsFingerprint === "string" ? info.scriptsFingerprint : undefined,
      exportPresets: Array.isArray(info?.exportPresets)
        ? uniqueStrings(
            info.exportPresets.filter((value): value is string => typeof value === "string"),
          )
        : [],
      envSnapshot: {
        ...asRecord(info?.envSnapshot),
        ...(typeof info?.configVersion === "string" ? { configVersion: info.configVersion } : {}),
        ...(scriptVersions ? { scriptVersions } : {}),
      },
      parameters: {
        ...extraParameters,
        ...(typeof info?.configVersion === "string" ? { configVersion: info.configVersion } : {}),
        ...(scriptVersions ? { scriptVersions } : {}),
      },
    };
  }

  private upsertCiProvenance(
    build: BuildRecord,
    request: CiBuildRequest,
    extras?: {
      executorNode?: string;
      executorLabel?: string;
    },
  ): BuildProvenanceRecord {
    const current = this.store.getBuildProvenance(build.buildId) ?? this.createProvenance(build);
    const environmentPatch = this.buildCiEnvironmentPatch(request.environmentInfo);
    const parameters = {
      ...current.parameters,
      requestId: request.requestId,
      pipelineUrl: request.pipelineUrl,
      targets: request.targets ?? [],
      baselineVersion: build.baselineVersion,
      baselineManifestUrl: build.baselineManifestUrl,
      ...environmentPatch.parameters,
      ...(extras?.executorNode ? { executorNode: extras.executorNode } : {}),
      ...(extras?.executorLabel ? { executorLabel: extras.executorLabel } : {}),
    };
    const next: BuildProvenanceRecord = {
      ...current,
      sourceGitUrl: build.sourceGitUrl,
      sourceGitBranch: build.sourceGitBranch,
      sourceGitCommit: build.sourceGitCommit,
      sourceGitCommitShort: build.sourceGitCommitShort,
      jenkinsJob: build.jenkinsJob,
      jenkinsBuildNumber: build.jenkinsBuildNumber,
      jenkinsQueueId: build.jenkinsQueueId,
      baselineVersion: build.baselineVersion,
      baselineManifestUrl: build.baselineManifestUrl,
      ...(environmentPatch.godotVersion ? { godotVersion: environmentPatch.godotVersion } : {}),
      ...(environmentPatch.godotBin ? { godotBin: environmentPatch.godotBin } : {}),
      ...(environmentPatch.dotnetVersion ? { dotnetVersion: environmentPatch.dotnetVersion } : {}),
      ...(environmentPatch.workspaceRevision
        ? { workspaceRevision: environmentPatch.workspaceRevision }
        : {}),
      ...(environmentPatch.configFingerprint
        ? { configFingerprint: environmentPatch.configFingerprint }
        : {}),
      ...(environmentPatch.assetGroupsFingerprint
        ? { assetGroupsFingerprint: environmentPatch.assetGroupsFingerprint }
        : {}),
      ...(environmentPatch.scriptsFingerprint
        ? { scriptsFingerprint: environmentPatch.scriptsFingerprint }
        : {}),
      ...(extras?.executorNode ? { executorNode: extras.executorNode } : {}),
      ...(extras?.executorLabel ? { executorLabel: extras.executorLabel } : {}),
      exportPresets: uniqueStrings([
        ...(current.exportPresets ?? []),
        ...environmentPatch.exportPresets,
      ]),
      envSnapshot: {
        ...current.envSnapshot,
        ...environmentPatch.envSnapshot,
      },
      parameters,
      capturedAt: nowIso(),
      provenanceHash: sha256Text(JSON.stringify(parameters)),
    };
    this.store.upsertBuildProvenance(next);
    return next;
  }

  private ensureCiRelease(request: CiBuildRequest): ReleaseRecord {
    const projectKey = this.normalizeCiProjectKey(request.app?.projectKey);
    const environment = this.normalizeCiEnvironment(request.app?.environment, projectKey);
    const channel = this.normalizeCiChannel(request.app?.channel, projectKey);
    const version = this.versionFromCi(request);
    this.assertProjectScope(projectKey, environment, channel, {
      region: request.app?.region?.trim() || undefined,
      audience: request.app?.audience?.trim() || undefined,
    });
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
        scope: {
          region: request.app?.region?.trim() || undefined,
          audience: request.app?.audience?.trim() || undefined,
        },
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
      this.upsertCiProvenance(nextBuild, request);
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
    this.upsertCiProvenance(build, request);
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

  getBuildStatus(buildId: string): {
    build: BuildRecord;
    release: ReleaseRecord | null;
    artifacts: ArtifactRecord[];
    provenance: BuildProvenanceRecord | null;
  } {
    const build = this.store.getBuild(buildId);
    if (!build) {
      throw new Error(`build not found: ${buildId}`);
    }
    return {
      build,
      release: this.store.getRelease(build.releaseId),
      artifacts: this.store.listArtifactsForBuild(buildId),
      provenance: this.store.getBuildProvenance(buildId),
    };
  }

  async pollJenkinsBuildStatus(buildId: string): Promise<Record<string, unknown> | null> {
    const build = this.store.getBuild(buildId);
    if (!build) {
      throw new Error(`build not found: ${buildId}`);
    }
    if (!this.config.jenkinsBaseUrl || !build.jenkinsJob) {
      return null;
    }
    const headers: Record<string, string> = {};
    if (this.config.jenkinsUser && this.config.jenkinsApiToken) {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.config.jenkinsUser}:${this.config.jenkinsApiToken}`,
      ).toString("base64")}`;
    }
    const polledAt = nowIso();
    if (build.jenkinsBuildNumber) {
      const response = await fetch(
        `${this.config.jenkinsBaseUrl}/job/${encodeURIComponent(build.jenkinsJob)}/${build.jenkinsBuildNumber}/api/json`,
        { headers },
      );
      if (!response.ok) {
        throw new Error(`jenkins build status request failed with status ${response.status}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      return {
        kind: "build",
        polledAt,
        jobName: build.jenkinsJob,
        buildNumber: build.jenkinsBuildNumber,
        url: payload.url,
        building: payload.building,
        result: payload.result,
        duration: payload.duration,
        estimatedDuration: payload.estimatedDuration,
        timestamp: payload.timestamp,
      };
    }
    if (build.jenkinsQueueId) {
      const response = await fetch(
        `${this.config.jenkinsBaseUrl}/queue/item/${build.jenkinsQueueId}/api/json`,
        { headers },
      );
      if (!response.ok) {
        throw new Error(`jenkins queue status request failed with status ${response.status}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const executable =
        payload.executable && typeof payload.executable === "object"
          ? (payload.executable as Record<string, unknown>)
          : undefined;
      const buildNumber =
        typeof executable?.number === "number" ? executable.number : build.jenkinsBuildNumber;
      if (typeof buildNumber === "number" && buildNumber !== build.jenkinsBuildNumber) {
        this.store.upsertBuild({
          ...build,
          jenkinsBuildNumber: buildNumber,
          updatedAt: nowIso(),
        });
      }
      return {
        kind: "queue",
        polledAt,
        jobName: build.jenkinsJob,
        queueId: build.jenkinsQueueId,
        cancelled: payload.cancelled,
        why: payload.why,
        executableNumber: buildNumber,
        executableUrl: executable?.url,
      };
    }
    return null;
  }

  getRollback(rollbackId: string): RollbackOperationRecord | null {
    return this.store.getRollback(rollbackId);
  }

  getRollout(rolloutId: string): RolloutRecord | null {
    return this.store.getRollout(rolloutId);
  }

  listRollouts(params: {
    projectKey: string;
    environment?: ReleaseEnvironment;
    channel?: ReleaseChannel;
    releaseId?: string;
    statuses?: RolloutRecord["status"][];
    limit?: number;
  }): RolloutRecord[] {
    return this.store.listRollouts(params);
  }

  listStableReleases(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    limit?: number;
  }): ReleaseRecord[] {
    return this.store
      .listReleases({
        projectKey: params.projectKey,
        environment: params.environment,
        channel: params.channel,
      })
      .filter((release) => release.stable)
      .toSorted((left, right) => compareVersions(right.version, left.version))
      .slice(0, params.limit ?? 20);
  }

  getChannelHistory(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    limit?: number;
  }): {
    channelState: ChannelStateRecord | null;
    releases: ReleaseRecord[];
    edges: ReleaseRelationRecord[];
  } {
    const releases = this.store
      .listReleases({
        projectKey: params.projectKey,
        environment: params.environment,
        channel: params.channel,
      })
      .toSorted((left, right) => {
        const leftTime = left.publishedAt ?? left.updatedAt;
        const rightTime = right.publishedAt ?? right.updatedAt;
        return rightTime.localeCompare(leftTime);
      })
      .slice(0, params.limit ?? 20);
    const releaseIds = new Set(releases.map((release) => release.releaseId));
    const edges = releases
      .flatMap((release) => this.store.listReleaseRelations(params.projectKey, release.releaseId))
      .filter(
        (edge, index, all) =>
          all.findIndex((item) => item.relationId === edge.relationId) === index,
      )
      .filter((edge) => releaseIds.has(edge.fromReleaseId) || releaseIds.has(edge.toReleaseId));
    return {
      channelState: this.getChannelState(params.projectKey, params.environment, params.channel),
      releases,
      edges,
    };
  }

  listBaselines(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    platform: string;
    targetVersion?: string;
    limit?: number;
  }): BaselineRecord[] {
    return this.store
      .listBaselines({
        projectKey: params.projectKey,
        environment: params.environment,
        channel: params.channel,
        platform: params.platform,
      })
      .filter((baseline) => !params.targetVersion || baseline.toVersion === params.targetVersion)
      .slice(0, params.limit ?? 20);
  }

  getBaselineLineage(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    platform: string;
    releaseId?: string;
    version?: string;
  }): {
    targetVersion: string;
    baselines: BaselineRecord[];
    releases: ReleaseRecord[];
  } {
    const release =
      params.releaseId && this.store.getRelease(params.releaseId)
        ? this.store.getRelease(params.releaseId)
        : null;
    const targetVersion = params.version ?? release?.version;
    if (!targetVersion) {
      throw new Error("version or releaseId is required");
    }
    const available = this.store
      .listBaselines({
        projectKey: params.projectKey,
        environment: params.environment,
        channel: params.channel,
        platform: params.platform,
      })
      .map((baseline) => this.repairBaselineManifestUrl(baseline));
    const chain: BaselineRecord[] = [];
    const releaseIds = new Set<string>();
    const seenVersions = new Set<string>();
    let cursor = targetVersion;
    while (cursor && !seenVersions.has(cursor)) {
      seenVersions.add(cursor);
      const baseline = available.find(
        (item) => item.toVersion === cursor && item.status === "active",
      );
      if (!baseline) {
        break;
      }
      chain.push(baseline);
      if (baseline.fromReleaseId) {
        releaseIds.add(baseline.fromReleaseId);
      }
      if (baseline.toReleaseId) {
        releaseIds.add(baseline.toReleaseId);
      }
      cursor = baseline.fromVersion;
    }
    const releases = [...releaseIds]
      .map((releaseId) => this.store.getRelease(releaseId))
      .filter((item): item is ReleaseRecord => Boolean(item))
      .toSorted((left, right) => compareVersions(right.version, left.version));
    return {
      targetVersion,
      baselines: chain,
      releases,
    };
  }

  getPromotionHistory(params: {
    projectKey: string;
    environment?: ReleaseEnvironment;
    channel?: ReleaseChannel;
    releaseId?: string;
    limit?: number;
  }): Array<{
    relation: ReleaseRelationRecord;
    fromRelease: ReleaseRecord | null;
    toRelease: ReleaseRecord | null;
  }> {
    const relations = params.releaseId
      ? this.store
          .listReleaseRelations(params.projectKey, params.releaseId)
          .filter((edge) => edge.relationType === "promoted_from")
      : this.store.listReleaseRelationsByType(params.projectKey, "promoted_from", params.limit);
    return relations
      .map((relation) => {
        const fromRelease = this.store.getRelease(relation.fromReleaseId);
        const toRelease = this.store.getRelease(relation.toReleaseId);
        return { relation, fromRelease, toRelease };
      })
      .filter(({ fromRelease, toRelease }) => {
        if (params.environment) {
          const matchesEnvironment =
            fromRelease?.environment === params.environment ||
            toRelease?.environment === params.environment;
          if (!matchesEnvironment) {
            return false;
          }
        }
        if (params.channel) {
          const matchesChannel =
            fromRelease?.channel === params.channel || toRelease?.channel === params.channel;
          if (!matchesChannel) {
            return false;
          }
        }
        return true;
      })
      .slice(0, params.limit ?? 20);
  }

  getRollbackAudit(params: {
    projectKey: string;
    environment?: ReleaseEnvironment;
    channel?: ReleaseChannel;
    limit?: number;
  }): Array<{
    rollback: RollbackOperationRecord;
    fromRelease: ReleaseRecord | null;
    toRelease: ReleaseRecord | null;
    events: EventLogRecord[];
  }> {
    return this.store
      .listRollbacks({
        projectKey: params.projectKey,
        environment: params.environment,
        channel: params.channel,
        limit: params.limit,
      })
      .map((rollback) => ({
        rollback,
        fromRelease: this.store.getRelease(rollback.fromReleaseId),
        toRelease: this.store.getRelease(rollback.toReleaseId),
        events: this.store.listEvents({
          projectKey: params.projectKey,
          objectType: "rollback",
          objectId: rollback.rollbackId,
          limit: 20,
        }),
      }));
  }

  getRollbackPlan(params: {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
  }): {
    channelState: ChannelStateRecord | null;
    currentRelease: ReleaseRecord | null;
    recommendedTargetReleaseId?: string;
    candidates: Array<{
      release: ReleaseRecord;
      compatible: boolean;
      reason?: string;
    }>;
  } {
    const channelState = this.getChannelState(
      params.projectKey,
      params.environment,
      params.channel,
    );
    const currentRelease = channelState?.currentReleaseId
      ? this.store.getRelease(channelState.currentReleaseId)
      : null;
    const candidates = this.listStableReleases({
      projectKey: params.projectKey,
      environment: params.environment,
      channel: params.channel,
      limit: 20,
    })
      .filter((release) => release.releaseId !== currentRelease?.releaseId)
      .map((release) => {
        if (!currentRelease) {
          return { release, compatible: true };
        }
        try {
          this.assertRollbackCompatibility(currentRelease, release);
          return { release, compatible: true };
        } catch (error) {
          return {
            release,
            compatible: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      });
    const recommendedTargetReleaseId =
      candidates.find(
        (item) => item.release.releaseId === channelState?.previousReleaseId && item.compatible,
      )?.release.releaseId ?? candidates.find((item) => item.compatible)?.release.releaseId;
    return {
      channelState,
      currentRelease,
      recommendedTargetReleaseId,
      candidates,
    };
  }

  getNotification(notificationId: string): NotificationOutboxRecord | null {
    return this.store.getNotification(notificationId);
  }

  private buildReleaseNotesText(
    release: ReleaseRecord,
    build: BuildRecord | null,
    artifacts: ArtifactRecord[],
    extraSummary?: string,
  ): string {
    const targets = build
      ? Object.entries(build.targets)
          .filter(([, enabled]) => enabled)
          .map(([key]) => key)
      : [];
    const lines = [
      `Release ${release.version}`,
      `Environment: ${release.environment}`,
      `Channel: ${release.channel}`,
      build?.jenkinsBuildNumber ? `Jenkins Build: #${build.jenkinsBuildNumber}` : null,
      build?.sourceGitCommitShort ? `Commit: ${build.sourceGitCommitShort}` : null,
      targets.length > 0 ? `Targets: ${targets.join(", ")}` : null,
      build?.baselineVersion ? `Baseline: ${build.baselineVersion}` : null,
      artifacts.length > 0
        ? `Artifacts: ${artifacts.map((artifact) => artifact.fileName).join(", ")}`
        : null,
      extraSummary?.trim() ? `Summary: ${extraSummary.trim()}` : null,
      release.notes?.trim() ? `Notes: ${release.notes.trim()}` : null,
    ];
    return lines.filter((line): line is string => Boolean(line)).join("\n");
  }

  private archiveReleaseChangelog(
    release: ReleaseRecord,
    operator: string,
    params?: {
      build?: BuildRecord | null;
      reason?: string;
      sourceReleaseId?: string;
      summary?: string;
    },
  ): EventLogRecord {
    const existing = this.store.listEvents({
      projectKey: release.projectKey,
      objectType: "release",
      objectId: release.releaseId,
      eventType: "release.changelog.archived",
      limit: 1,
    })[0];
    if (existing) {
      return existing;
    }
    const build =
      params?.build ??
      (release.currentBuildId ? this.store.getBuild(release.currentBuildId) : null) ??
      null;
    const artifacts = build ? this.store.listArtifactsForBuild(build.buildId) : [];
    const notes = this.buildReleaseNotesText(release, build, artifacts, params?.summary);
    const event = this.recordEvent({
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      objectType: "release",
      objectId: release.releaseId,
      eventType: "release.changelog.archived",
      payload: {
        version: release.version,
        channel: release.channel,
        environment: release.environment,
        releaseId: release.releaseId,
        buildId: build?.buildId ?? null,
        manifestUrl: this.canonicalManifestUrlForRelease(release) ?? null,
        notes,
        sourceNotes: release.notes ?? null,
        reason: params?.reason ?? "publish",
        sourceReleaseId: params?.sourceReleaseId ?? null,
        artifacts: artifacts.map((artifact) => ({
          artifactType: artifact.artifactType,
          fileName: artifact.fileName,
          platform: artifact.platform,
          downloadUrl: artifact.downloadUrl,
        })),
      },
      createdBy: operator,
    });
    this.store.upsertRelease({
      ...release,
      metadata: {
        ...release.metadata,
        changelogArchiveEventId: event.eventId,
        changelogArchivedAt: event.createdAt,
      },
      updatedAt: nowIso(),
    });
    return event;
  }

  generateReleaseNotes(releaseId: string): {
    release: ReleaseRecord;
    build: BuildRecord | null;
    archived: boolean;
    notes: string;
    artifacts: ArtifactRecord[];
  } {
    const release = this.store.getRelease(releaseId);
    if (!release) {
      throw new Error(`release not found: ${releaseId}`);
    }
    const build = release.currentBuildId ? this.store.getBuild(release.currentBuildId) : null;
    const artifacts = build ? this.store.listArtifactsForBuild(build.buildId) : [];
    const archived = this.store.listEvents({
      projectKey: release.projectKey,
      objectType: "release",
      objectId: release.releaseId,
      eventType: "release.changelog.archived",
      limit: 1,
    })[0];
    const notes =
      typeof archived?.payload.notes === "string"
        ? archived.payload.notes
        : this.buildReleaseNotesText(release, build, artifacts);
    return {
      release,
      build,
      archived: Boolean(archived),
      notes,
      artifacts,
    };
  }

  runReleasePreflight(releaseId: string): {
    release: ReleaseRecord;
    build: BuildRecord | null;
    artifacts: ArtifactRecord[];
    passed: boolean;
    issues: string[];
    warnings: string[];
    smokeGate?: Record<string, unknown>;
  } {
    const release = this.store.getRelease(releaseId);
    if (!release) {
      throw new Error(`release not found: ${releaseId}`);
    }
    const build = release.currentBuildId ? this.store.getBuild(release.currentBuildId) : null;
    const artifacts = build ? this.store.listArtifactsForBuild(build.buildId) : [];
    const issues: string[] = [];
    const warnings: string[] = [];
    if (release.frozen) {
      issues.push("release is frozen");
    }
    if (!build) {
      issues.push("release has no current build");
    } else {
      if (!["uploaded", "finished"].includes(build.status)) {
        warnings.push(`build status is ${build.status}`);
      }
      const smokeGate = this.evaluatePublishSmokeGate(
        release,
        build,
        artifacts,
        build.reports?.patchValidation as Record<string, unknown> | undefined,
      );
      if (smokeGate.passed !== true) {
        issues.push(...((smokeGate.errors as string[] | undefined) ?? []));
      }
      warnings.push(...((smokeGate.warnings as string[] | undefined) ?? []));
      return {
        release,
        build,
        artifacts,
        passed: issues.length === 0,
        issues,
        warnings,
        smokeGate,
      };
    }
    return {
      release,
      build,
      artifacts,
      passed: issues.length === 0,
      issues,
      warnings,
    };
  }

  private notificationRetryDelayMs(attemptCount: number): number {
    const exponent = Math.max(0, attemptCount - 1);
    return NOTIFICATION_RETRY_BASE_MS * 2 ** exponent;
  }

  private nextNotificationRetryAt(attemptCount: number, fromMs = Date.now()): string {
    return new Date(fromMs + this.notificationRetryDelayMs(attemptCount)).toISOString();
  }

  private isNotificationRetryable(record: NotificationOutboxRecord, nowMs = Date.now()): boolean {
    if (record.deadLetteredAt || record.attemptCount >= NOTIFICATION_MAX_ATTEMPTS) {
      return false;
    }
    if (!record.nextAttemptAt) {
      return true;
    }
    return new Date(record.nextAttemptAt).getTime() <= nowMs;
  }

  private reclaimTimedOutNotifications(
    deliveryChannel: NotificationOutboxRecord["deliveryChannel"],
    nowMs = Date.now(),
  ): NotificationOutboxRecord[] {
    const sending = this.store.listNotifications({
      statuses: ["sending"],
      deliveryChannel,
    });
    const reclaimed: NotificationOutboxRecord[] = [];
    for (const record of sending) {
      const claimedAtMs = record.claimedAt ? new Date(record.claimedAt).getTime() : NaN;
      if (!Number.isFinite(claimedAtMs) || nowMs - claimedAtMs < NOTIFICATION_SENDING_TIMEOUT_MS) {
        continue;
      }
      const timedOutAt = new Date(nowMs).toISOString();
      const maxedOut = record.attemptCount >= NOTIFICATION_MAX_ATTEMPTS;
      const next: NotificationOutboxRecord = {
        ...record,
        status: "failed",
        lastError: `delivery claim timed out after ${NOTIFICATION_SENDING_TIMEOUT_MS}ms`,
        claimedAt: undefined,
        deadLetteredAt: maxedOut ? timedOutAt : undefined,
        nextAttemptAt: maxedOut
          ? undefined
          : this.nextNotificationRetryAt(record.attemptCount, nowMs),
        updatedAt: timedOutAt,
      };
      this.store.upsertNotification(next);
      reclaimed.push(next);
    }
    return reclaimed;
  }

  renderNotification(notificationId: string): {
    notification: NotificationOutboxRecord;
    messageText: string;
    deliveryPlan: {
      tool: "message";
      args: Record<string, unknown>;
      configured: boolean;
      mode: "explicit_target" | "session_bound" | "unconfigured";
    };
  } {
    const notification = this.store.getNotification(notificationId);
    if (!notification) {
      throw new Error(`notification not found: ${notificationId}`);
    }
    const payload = notification.payload;
    const release = (payload.release as Record<string, unknown> | undefined) ?? {};
    const build = (payload.build as Record<string, unknown> | undefined) ?? {};
    const rollback = (payload.rollback as Record<string, unknown> | undefined) ?? {};
    const summary = typeof payload.summary === "string" ? payload.summary : undefined;
    const lines = [
      `[Lobster Release] ${notification.eventType}`,
      `Project: ${notification.projectKey}`,
      notification.environment ? `Environment: ${notification.environment}` : null,
      notification.channel ? `Channel: ${notification.channel}` : null,
      typeof release.version === "string" ? `Version: ${release.version}` : null,
      typeof release.releaseId === "string" ? `Release: ${release.releaseId}` : null,
      typeof build.buildId === "string" ? `Build: ${build.buildId}` : null,
      typeof build.jenkinsBuildNumber === "number"
        ? `Jenkins Build: #${build.jenkinsBuildNumber}`
        : null,
      typeof rollback.rollbackId === "string" ? `Rollback: ${rollback.rollbackId}` : null,
      summary ? `Summary: ${summary}` : null,
      typeof rollback.reason === "string" ? `Reason: ${rollback.reason}` : null,
      typeof notification.lastError === "string" ? `Last Error: ${notification.lastError}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const mode =
      this.config.notifierChannel && this.config.notifierTarget
        ? ("explicit_target" as const)
        : this.config.notifierSessionKey
          ? ("session_bound" as const)
          : ("unconfigured" as const);
    return {
      notification,
      messageText: lines,
      deliveryPlan: {
        tool: "message",
        configured: mode !== "unconfigured",
        mode,
        args: {
          action: "send",
          ...(mode === "explicit_target" && this.config.notifierChannel
            ? { channel: this.config.notifierChannel }
            : {}),
          ...(mode === "explicit_target" && this.config.notifierTarget
            ? { target: this.config.notifierTarget }
            : {}),
          ...(this.config.notifierAccountId ? { accountId: this.config.notifierAccountId } : {}),
          message: lines,
        },
      },
    };
  }

  pullNotifications(params?: {
    limit?: number;
    includeFailed?: boolean;
    deliveryChannel?: NotificationOutboxRecord["deliveryChannel"];
  }): NotificationOutboxRecord[] {
    const deliveryChannel = params?.deliveryChannel ?? "feishu";
    const nowMs = Date.now();
    this.reclaimTimedOutNotifications(deliveryChannel, nowMs);
    const candidates = this.store
      .listNotifications({
        statuses: params?.includeFailed ? ["pending", "failed"] : ["pending"],
        deliveryChannel,
      })
      .filter((record) => {
        if (record.status === "pending") {
          return true;
        }
        return params?.includeFailed === true && this.isNotificationRetryable(record, nowMs);
      })
      .slice(0, params?.limit ?? 10);
    const claimedAt = new Date(nowMs).toISOString();
    return candidates.map((record) => {
      const next: NotificationOutboxRecord = {
        ...record,
        status: "sending",
        attemptCount: record.attemptCount + 1,
        claimedAt,
        lastAttemptAt: claimedAt,
        nextAttemptAt: undefined,
        deadLetteredAt: undefined,
        updatedAt: claimedAt,
      };
      this.store.upsertNotification(next);
      return next;
    });
  }

  markNotificationSent(
    notificationId: string,
    params?: { deliveryNote?: string },
  ): NotificationOutboxRecord {
    const record = this.store.getNotification(notificationId);
    if (!record) {
      throw new Error(`notification not found: ${notificationId}`);
    }
    const nextPayload =
      params?.deliveryNote && params.deliveryNote.trim()
        ? {
            ...record.payload,
            deliveryNote: params.deliveryNote.trim(),
          }
        : record.payload;
    const next: NotificationOutboxRecord = {
      ...record,
      status: "sent",
      payload: nextPayload,
      lastError: undefined,
      claimedAt: undefined,
      nextAttemptAt: undefined,
      deadLetteredAt: undefined,
      sentAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.upsertNotification(next);
    return next;
  }

  markNotificationFailed(notificationId: string, error: string): NotificationOutboxRecord {
    const record = this.store.getNotification(notificationId);
    if (!record) {
      throw new Error(`notification not found: ${notificationId}`);
    }
    const failedAt = Date.now();
    const maxedOut = record.attemptCount >= NOTIFICATION_MAX_ATTEMPTS;
    const next: NotificationOutboxRecord = {
      ...record,
      status: "failed",
      lastError: error,
      claimedAt: undefined,
      deadLetteredAt: maxedOut ? new Date(failedAt).toISOString() : undefined,
      nextAttemptAt: maxedOut
        ? undefined
        : this.nextNotificationRetryAt(record.attemptCount, failedAt),
      updatedAt: new Date(failedAt).toISOString(),
    };
    this.store.upsertNotification(next);
    this.recordEvent({
      projectId: record.projectId,
      projectKey: record.projectKey,
      environment: record.environment,
      objectType: "notification",
      objectId: record.notificationId,
      eventType: "notification.failed",
      payload: {
        eventType: record.eventType,
        attemptCount: next.attemptCount,
        deadLetteredAt: next.deadLetteredAt ?? null,
        lastError: error,
      },
    });
    return next;
  }

  requeueNotification(
    notificationId: string,
    params?: { reason?: string },
  ): NotificationOutboxRecord {
    const record = this.store.getNotification(notificationId);
    if (!record) {
      throw new Error(`notification not found: ${notificationId}`);
    }
    if (record.status === "sent") {
      throw new Error(`notification already sent: ${notificationId}`);
    }
    const requeuedAt = nowIso();
    const next: NotificationOutboxRecord = {
      ...record,
      status: "pending",
      lastError: undefined,
      claimedAt: undefined,
      nextAttemptAt: undefined,
      deadLetteredAt: undefined,
      requeuedAt,
      requeueReason: params?.reason?.trim() || "manual requeue",
      updatedAt: requeuedAt,
    };
    this.store.upsertNotification(next);
    return next;
  }

  async createRelease(input: CreateReleaseInput): Promise<{
    release: ReleaseRecord;
    currentChannelReleaseId?: string;
    versionBumpType: ReleaseRecord["versionBumpType"];
    build?: Awaited<ReturnType<LobsterReleaseRuntime["triggerRelease"]>>;
  }> {
    const environment = this.resolveProjectEnvironment(input.projectKey, input.environment);
    const channel = this.resolveProjectChannel(input.projectKey, input.channel);
    this.assertProjectScope(input.projectKey, environment, channel, input.scope);
    const project = this.ensureProject(input.projectKey);
    const existing = this.findReleaseByVersion({
      projectKey: input.projectKey,
      environment,
      channel,
      version: input.version,
    });
    if (existing) {
      throw new Error(
        `release version already exists for ${input.projectKey}/${environment}/${channel}: ${input.version}`,
      );
    }
    const currentState = this.getChannelState(input.projectKey, environment, channel);
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
      environment,
      channel,
      version: nextParsed.raw,
      displayVersion: nextParsed.raw,
      versionScheme: "semver3",
      versionMajor: nextParsed.major,
      versionMinor: nextParsed.minor,
      versionPatch: nextParsed.patch,
      versionBumpType: bumpType,
      versionSource: input.versionSource ?? "manual",
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
        ...(input.scope ? { scope: input.scope } : {}),
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
        context: { channel, environment },
        createdBy: input.createdBy,
        createdAt: now,
      });
    }
    this.recordEvent({
      projectId: project.projectId,
      projectKey: project.projectKey,
      environment,
      objectType: "release",
      objectId: release.releaseId,
      eventType: "release.created",
      payload: {
        version: release.version,
        channel,
        environment,
        scope: input.scope ?? null,
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

  private isTerminalBuildStatus(status: BuildRecord["status"]): boolean {
    return TERMINAL_BUILD_STATUSES.has(status);
  }

  private advanceBuildStatus(
    current: BuildRecord["status"],
    next: BuildRecord["status"],
  ): BuildRecord["status"] {
    if (this.isTerminalBuildStatus(current)) {
      return current;
    }
    return buildStatusRank(next) > buildStatusRank(current) ? next : current;
  }

  private artifactIdentityKey(
    artifact: Pick<
      ArtifactRecord,
      "artifactType" | "platform" | "fileName" | "sha256" | "storagePath" | "downloadUrl"
    >,
  ): string {
    return [
      artifact.artifactType,
      artifact.platform,
      artifact.fileName,
      artifact.sha256,
      artifact.storagePath,
      artifact.downloadUrl,
    ].join("\u001f");
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveArtifactFilePath(
    artifact: Pick<ArtifactRecord, "storagePath">,
  ): Promise<string | undefined> {
    const storagePath = artifact.storagePath.trim();
    if (!storagePath) {
      return undefined;
    }
    if (path.isAbsolute(storagePath)) {
      return (await this.pathExists(storagePath)) ? storagePath : undefined;
    }
    const candidates = [
      this.config.uploadDestinationDir
        ? path.join(this.config.uploadDestinationDir, storagePath)
        : undefined,
      path.join(this.stateDir, storagePath),
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private async readArtifactJson<T>(
    artifact: Pick<ArtifactRecord, "storagePath">,
  ): Promise<T | undefined> {
    const filePath = await this.resolveArtifactFilePath(artifact);
    if (!filePath) {
      return undefined;
    }
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  }

  private async hashArtifactFileSha256(filePath: string): Promise<string> {
    const body = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(body).digest("hex");
  }

  private artifactRequiresVersionedName(artifact: ArtifactRecord): boolean {
    return (
      artifact.artifactType === "android_apk" ||
      artifact.artifactType === "android_aab" ||
      artifact.artifactType === "macos_zip" ||
      (artifact.artifactType === "patch_bundle" && artifact.fileName.toLowerCase().endsWith(".zip"))
    );
  }

  private async validateArtifactIntegrity(
    release: ReleaseRecord,
    build: BuildRecord,
    artifacts: ArtifactRecord[],
  ): Promise<Record<string, unknown>> {
    const warnings: string[] = [];
    const errors: string[] = [];
    let validatedSha256Count = 0;
    let skippedSha256Count = 0;
    for (const artifact of artifacts) {
      const fileName = artifact.fileName.toLowerCase();
      if (this.artifactRequiresVersionedName(artifact)) {
        if (!fileName.includes(release.version.toLowerCase())) {
          errors.push(`artifact naming missing version token: ${artifact.fileName}`);
        }
        if (
          build.jenkinsBuildNumber &&
          !new RegExp(`(^|[._-])${build.jenkinsBuildNumber}([._-]|$)`).test(fileName)
        ) {
          errors.push(`artifact naming missing build number: ${artifact.fileName}`);
        }
      }
      const filePath = await this.resolveArtifactFilePath(artifact);
      if (!filePath) {
        skippedSha256Count += 1;
        warnings.push(`sha256 validation skipped: ${artifact.fileName}`);
        continue;
      }
      const actualSha256 = await this.hashArtifactFileSha256(filePath);
      validatedSha256Count += 1;
      if (actualSha256 !== artifact.sha256) {
        errors.push(`artifact sha256 mismatch: ${artifact.fileName}`);
      }
    }
    return {
      validatedSha256Count,
      skippedSha256Count,
      warnings,
      errors,
    };
  }

  private normalizePatchItemPath(rawPath: string): string {
    return rawPath
      .trim()
      .replace(/\\/g, PATCH_CONFLICT_PATH_SEPARATOR)
      .replace(/^\.\//, "")
      .replace(/\/{2,}/g, PATCH_CONFLICT_PATH_SEPARATOR);
  }

  private validatePatchManifestSchema(
    release: ReleaseRecord,
    build: BuildRecord,
    patchManifest: Record<string, unknown>,
    patchBundle?: ArtifactRecord | null,
  ): {
    schema: "design" | "gamexpert";
    resourceProtocolVersion?: number;
    baselineVersion?: string;
  } {
    if (typeof patchManifest.manifestVersion === "number") {
      if (patchManifest.project !== release.projectKey) {
        throw new Error("patch manifest project does not match release");
      }
      if (patchManifest.environment !== release.environment) {
        throw new Error("patch manifest environment does not match release");
      }
      if (patchManifest.channel !== release.channel) {
        throw new Error("patch manifest channel does not match release");
      }
      if (patchManifest.version !== release.version) {
        throw new Error("patch manifest version does not match release");
      }
      const compatibility =
        patchManifest.compatibility && typeof patchManifest.compatibility === "object"
          ? (patchManifest.compatibility as Record<string, unknown>)
          : undefined;
      if (!compatibility || typeof compatibility.resourceProtocolVersion !== "number") {
        throw new Error("patch manifest missing compatibility.resourceProtocolVersion");
      }
      const baselineVersion =
        patchManifest.baseline && typeof patchManifest.baseline === "object"
          ? typeof (patchManifest.baseline as Record<string, unknown>).version === "string"
            ? ((patchManifest.baseline as Record<string, unknown>).version as string)
            : undefined
          : undefined;
      if (build.baselineVersion) {
        if (baselineVersion !== build.baselineVersion) {
          throw new Error("patch manifest baseline version does not match build baseline");
        }
      }
      const manifestInfo = {
        schema: "design" as const,
        resourceProtocolVersion: compatibility.resourceProtocolVersion,
        baselineVersion,
      };
      if (!patchBundle) {
        return manifestInfo;
      }
      const bundleZip =
        patchManifest.bundleZip && typeof patchManifest.bundleZip === "object"
          ? (patchManifest.bundleZip as Record<string, unknown>)
          : undefined;
      const bundleFileName = typeof bundleZip?.fileName === "string" ? bundleZip.fileName : "";
      if (bundleFileName && bundleFileName !== patchBundle.fileName) {
        throw new Error("patch manifest bundleZip.fileName does not match uploaded patch bundle");
      }
      return manifestInfo;
    }
    if (typeof patchManifest.format_version === "number") {
      const packages =
        patchManifest.packages && typeof patchManifest.packages === "object"
          ? (patchManifest.packages as Record<string, unknown>)
          : undefined;
      if (!packages) {
        throw new Error("patch manifest missing packages object");
      }
      const rawFiles =
        patchManifest.raw_files && typeof patchManifest.raw_files === "object"
          ? (patchManifest.raw_files as Record<string, unknown>)
          : undefined;
      if (!rawFiles) {
        throw new Error("patch manifest missing raw_files object");
      }
      return {
        schema: "gamexpert",
      };
    }
    throw new Error("patch manifest schema is not recognized");
  }

  private validatePatchListSchema(
    patchList: Record<string, unknown>,
  ): Array<{ path: string; op: string; sha256?: string }> {
    if (Array.isArray(patchList.items)) {
      return patchList.items.map((item, index) => {
        if (!item || typeof item !== "object") {
          throw new Error(`patch_list item ${index} is not an object`);
        }
        const record = item as Record<string, unknown>;
        const itemPath =
          typeof record.path === "string" ? this.normalizePatchItemPath(record.path) : "";
        const op = typeof record.op === "string" ? record.op.trim() : "";
        if (!itemPath) {
          throw new Error(`patch_list item ${index} missing path`);
        }
        if (!op) {
          throw new Error(`patch_list item ${index} missing op`);
        }
        return {
          path: itemPath,
          op,
          sha256: typeof record.sha256 === "string" ? record.sha256 : undefined,
        };
      });
    }
    const actualEntries: Array<{ path: string; op: string; sha256?: string }> = [];
    const appendEntries = (entries: unknown, label: string) => {
      if (!Array.isArray(entries)) {
        return;
      }
      for (const [index, item] of entries.entries()) {
        if (!item || typeof item !== "object") {
          throw new Error(`patch_list ${label}[${index}] is not an object`);
        }
        const record = item as Record<string, unknown>;
        const rawPath =
          typeof record.file === "string"
            ? record.file
            : typeof record.logical_name === "string"
              ? record.logical_name
              : "";
        const itemPath = rawPath ? this.normalizePatchItemPath(rawPath) : "";
        if (!itemPath) {
          throw new Error(`patch_list ${label}[${index}] missing file path`);
        }
        actualEntries.push({
          path: itemPath,
          op: "replace",
          sha256:
            typeof record.hash === "string"
              ? record.hash
              : typeof record.sha256 === "string"
                ? record.sha256
                : undefined,
        });
      }
    };
    appendEntries(patchList.download_bundles, "download_bundles");
    appendEntries(patchList.download_raw_files, "download_raw_files");
    if (actualEntries.length > 0) {
      return actualEntries;
    }
    throw new Error("patch_list schema is not recognized");
  }

  private detectPatchListConflicts(
    items: Array<{ path: string; op: string; sha256?: string }>,
  ): string[] {
    const seen = new Map<string, { op: string; sha256?: string }>();
    const conflicts = new Set<string>();
    for (const item of items) {
      const previous = seen.get(item.path);
      if (!previous) {
        seen.set(item.path, { op: item.op, sha256: item.sha256 });
        continue;
      }
      if (previous.op !== item.op || previous.sha256 !== item.sha256) {
        conflicts.add(item.path);
        continue;
      }
      conflicts.add(item.path);
    }
    return [...conflicts];
  }

  private async validatePatchArtifacts(
    release: ReleaseRecord,
    build: BuildRecord,
    artifacts: ArtifactRecord[],
  ): Promise<Record<string, unknown> | undefined> {
    if (!build.targets.patch) {
      return undefined;
    }
    const hasPatchArtifacts = artifacts.some(
      (artifact) =>
        artifact.artifactType === "patch_bundle" ||
        artifact.artifactType === "patch_manifest" ||
        artifact.artifactType === "patch_list",
    );
    if (!hasPatchArtifacts) {
      return undefined;
    }
    const patchManifestArtifact = artifacts.find(
      (artifact) => artifact.artifactType === "patch_manifest",
    );
    if (!patchManifestArtifact) {
      throw new Error("patch build missing patch_manifest artifact");
    }
    const patchManifestPath = await this.resolveArtifactFilePath(patchManifestArtifact);
    if (!patchManifestPath) {
      return {
        valid: false,
        skipped: true,
        reason: "patch manifest file unavailable for local validation",
      };
    }
    const patchManifest =
      await this.readArtifactJson<Record<string, unknown>>(patchManifestArtifact);
    if (!patchManifest) {
      throw new Error(`patch manifest file not found: ${patchManifestArtifact.storagePath}`);
    }
    const patchBundle = this.selectPatchBundleArtifact(artifacts);
    const patchManifestInfo = this.validatePatchManifestSchema(
      release,
      build,
      patchManifest,
      patchBundle,
    );
    const patchListArtifact = artifacts.find((artifact) => artifact.artifactType === "patch_list");
    if (!patchListArtifact) {
      return {
        valid: true,
        schema: patchManifestInfo.schema,
        resourceProtocolVersion: patchManifestInfo.resourceProtocolVersion,
        baselineVersion: patchManifestInfo.baselineVersion,
        patchItems: 0,
        conflictPaths: [],
      };
    }
    const patchListPath = await this.resolveArtifactFilePath(patchListArtifact);
    if (!patchListPath) {
      return {
        valid: false,
        skipped: true,
        reason: "patch list file unavailable for local validation",
      };
    }
    const patchList = await this.readArtifactJson<Record<string, unknown>>(patchListArtifact);
    if (!patchList) {
      throw new Error(`patch list file not found: ${patchListArtifact.storagePath}`);
    }
    const items = this.validatePatchListSchema(patchList);
    const conflictPaths = this.detectPatchListConflicts(items);
    if (conflictPaths.length > 0) {
      throw new Error(`patch_list contains conflicting paths: ${conflictPaths.join(", ")}`);
    }
    return {
      valid: true,
      schema: patchManifestInfo.schema,
      resourceProtocolVersion: patchManifestInfo.resourceProtocolVersion,
      baselineVersion: patchManifestInfo.baselineVersion,
      patchItems: items.length,
      conflictPaths,
    };
  }

  private requiredArtifactTypesForBuild(build: BuildRecord): ArtifactRecord["artifactType"][] {
    const required = new Set<ArtifactRecord["artifactType"]>();
    if (build.targets.androidApk) {
      required.add("android_apk");
    }
    if (build.targets.androidAab) {
      required.add("android_aab");
    }
    if (build.targets.macosApp) {
      required.add("macos_zip");
    }
    if (build.targets.patch) {
      required.add("patch_manifest");
      required.add("patch_bundle");
    }
    return [...required];
  }

  private evaluatePublishSmokeGate(
    release: ReleaseRecord,
    build: BuildRecord,
    artifacts: ArtifactRecord[],
    patchValidation?: Record<string, unknown>,
  ): Record<string, unknown> {
    const requiredArtifactTypes = this.requiredArtifactTypesForBuild(build);
    const artifactCounts: Partial<Record<ArtifactRecord["artifactType"], number>> = {};
    const warnings: string[] = [];
    const errors: string[] = [];

    for (const artifact of artifacts) {
      artifactCounts[artifact.artifactType] = (artifactCounts[artifact.artifactType] ?? 0) + 1;
      if (!artifact.fileName.trim()) {
        errors.push(`artifact ${artifact.artifactId} is missing fileName`);
      }
      if (!artifact.sha256.trim()) {
        errors.push(`artifact ${artifact.fileName} is missing sha256`);
      }
      if (!artifact.downloadUrl.trim()) {
        errors.push(`artifact ${artifact.fileName} is missing downloadUrl`);
      }
    }

    for (const artifactType of requiredArtifactTypes) {
      if ((artifactCounts[artifactType] ?? 0) === 0) {
        errors.push(`required artifact missing: ${artifactType}`);
      }
    }

    if (build.targets.patch) {
      const compatibility = this.compatibilityForRelease(release);
      if (build.baselineVersion && !build.baselineManifestUrl) {
        errors.push("patch build baselineManifestUrl is missing");
      }
      if (patchValidation) {
        if (patchValidation.skipped === true) {
          const skipReason =
            typeof patchValidation.reason === "string"
              ? patchValidation.reason
              : patchValidation.reason
                ? JSON.stringify(patchValidation.reason)
                : "patch validation skipped";
          warnings.push(skipReason);
        }
        if (
          typeof patchValidation.resourceProtocolVersion === "number" &&
          patchValidation.resourceProtocolVersion !== compatibility.resourceProtocolVersion
        ) {
          errors.push(
            `patch resourceProtocolVersion ${patchValidation.resourceProtocolVersion} does not match release compatibility ${compatibility.resourceProtocolVersion}`,
          );
        }
      } else {
        warnings.push("patch validation report is unavailable");
      }
    }

    return {
      passed: errors.length === 0,
      checkedAt: nowIso(),
      requiredArtifactTypes,
      artifactCounts,
      warnings,
      errors,
    };
  }

  private compatibilityForRelease(release: ReleaseRecord): ReleaseManifest["compatibility"] {
    return {
      minClientVersion: `${release.versionMajor}.${release.versionMinor}.0`,
      resourceProtocolVersion: release.versionBumpType === "major" ? 2 : 1,
      minManifestVersion: 1,
    };
  }

  private assertRollbackCompatibility(current: ReleaseRecord, target: ReleaseRecord): void {
    const currentCompatibility = this.compatibilityForRelease(current);
    const targetCompatibility = this.compatibilityForRelease(target);
    if (
      compareVersions(targetCompatibility.minClientVersion, currentCompatibility.minClientVersion) <
      0
    ) {
      throw new Error(
        `rollback.compatibility_conflict: target minClientVersion ${targetCompatibility.minClientVersion} is older than current ${currentCompatibility.minClientVersion}`,
      );
    }
    if (
      targetCompatibility.resourceProtocolVersion !== currentCompatibility.resourceProtocolVersion
    ) {
      throw new Error(
        `rollback.compatibility_conflict: target resourceProtocolVersion ${targetCompatibility.resourceProtocolVersion} does not match current ${currentCompatibility.resourceProtocolVersion}`,
      );
    }
  }

  private assertNoActiveRollback(
    projectKey: string,
    environment: ReleaseEnvironment,
    channel: ReleaseChannel,
    action: string,
  ): void {
    const active = this.store
      .listRollbacks({
        projectKey,
        environment,
        channel,
        limit: 20,
      })
      .find(
        (rollback) =>
          rollback.status === "requested" ||
          rollback.status === "approved" ||
          rollback.status === "executing",
      );
    if (active) {
      throw new Error(`rollback.in_progress: ${action} blocked by rollback ${active.rollbackId}`);
    }
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
    this.assertNoActiveRollback(
      release.projectKey,
      release.environment,
      release.channel,
      "trigger-release",
    );
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
      status: this.advanceBuildStatus(build.status, "building"),
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
    const release = this.store.getRelease(next.releaseId);
    if (release) {
      const startedEvent = this.recordEvent({
        projectId: release.projectId,
        projectKey: release.projectKey,
        environment: release.environment,
        objectType: "build",
        objectId: next.buildId,
        eventType: "build.started",
        payload: {
          releaseId: release.releaseId,
          version: release.version,
          channel: release.channel,
          jenkinsJob: next.jenkinsJob,
          jenkinsBuildNumber: next.jenkinsBuildNumber,
        },
      });
      this.queueNotification({
        event: startedEvent,
        dedupeKey: `build.started:${next.buildId}`,
        payload: {
          projectKey: release.projectKey,
          environment: release.environment,
          channel: release.channel,
          release: {
            releaseId: release.releaseId,
            version: release.version,
            status: release.status,
          },
          build: {
            buildId: next.buildId,
            status: next.status,
            jenkinsJob: next.jenkinsJob,
            jenkinsBuildNumber: next.jenkinsBuildNumber,
          },
          summary: "Build started",
        },
      });
    }
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
    const existingArtifactKeys = new Set(
      this.store
        .listArtifactsForBuild(buildId)
        .map((artifact) => this.artifactIdentityKey(artifact)),
    );
    const artifacts = payload.artifacts.filter((artifact) =>
      this.belongsToCurrentBuild(release, build, artifact),
    );
    for (const artifact of artifacts) {
      const downloadUrl =
        artifact.downloadUrl ??
        this.buildArtifactUrl(release, artifact.platform, artifact.fileName);
      const artifactType = (artifact.artifactType ??
        artifact.type ??
        "manifest") as ArtifactRecord["artifactType"];
      const identityKey = this.artifactIdentityKey({
        artifactType,
        platform: artifact.platform,
        fileName: artifact.fileName,
        sha256: artifact.sha256,
        storagePath: artifact.storagePath,
        downloadUrl,
      });
      if (existingArtifactKeys.has(identityKey)) {
        continue;
      }
      const record: ArtifactRecord = {
        artifactId: createId("art"),
        buildId: build.buildId,
        releaseId: release.releaseId,
        projectId: release.projectId,
        projectKey: release.projectKey,
        environment: payload.environment ?? release.environment,
        channel: payload.channel ?? release.channel,
        artifactType,
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
      existingArtifactKeys.add(identityKey);
    }
    const skippedArtifacts = payload.artifacts.length - artifacts.length;
    if (skippedArtifacts > 0) {
      this.logger.warn(
        `[lobster-release] filtered ${skippedArtifacts} stale artifact(s) for release ${release.version} build ${build.jenkinsBuildNumber ?? "unknown"}`,
      );
    }
    const allArtifacts = this.store.listArtifactsForBuild(buildId);
    const patchValidation = await this.validatePatchArtifacts(release, build, allArtifacts);
    const artifactIntegrity = await this.validateArtifactIntegrity(release, build, allArtifacts);
    const smokeGate = this.evaluatePublishSmokeGate(release, build, allArtifacts, patchValidation);
    const nextReports = {
      ...build.reports,
      artifactIntegrity,
      ...(patchValidation ? { patchValidation } : {}),
      smokeGate,
    };
    if (((artifactIntegrity.errors as string[] | undefined) ?? []).length > 0) {
      this.store.upsertBuild({
        ...build,
        reports: nextReports,
        updatedAt: nowIso(),
      });
      throw new Error(
        `artifact integrity validation failed: ${(artifactIntegrity.errors as string[]).join("; ")}`,
      );
    }
    if (smokeGate.passed !== true) {
      this.store.upsertBuild({
        ...build,
        reports: nextReports,
        updatedAt: nowIso(),
      });
      throw new Error(`publish smoke gate failed: ${(smokeGate.errors as string[]).join("; ")}`);
    }
    const updatedBuild: BuildRecord = {
      ...build,
      status: this.advanceBuildStatus(build.status, "uploaded"),
      reports: nextReports,
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
    if (this.isTerminalBuildStatus(build.status) && build.result === payload.status) {
      return { build, release };
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
      reports: {
        ...build.reports,
        ...payload.reports,
      },
      finishedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.upsertBuild(nextBuild);
    const nextRelease: ReleaseRecord = {
      ...release,
      status:
        payload.status === "success"
          ? release.channel === "dev" && !this.requiresApproval(release.projectKey, release.channel)
            ? "published"
            : "awaiting_approval"
          : "failed",
      stable:
        payload.status === "success" &&
        release.channel === "dev" &&
        !this.requiresApproval(release.projectKey, release.channel),
      frozen: payload.status === "success" ? release.frozen : false,
      updatedAt: nowIso(),
      publishedAt:
        payload.status === "success" &&
        release.channel === "dev" &&
        !this.requiresApproval(release.projectKey, release.channel)
          ? nowIso()
          : release.publishedAt,
    };
    this.store.upsertRelease(nextRelease);
    if (nextRelease.status === "published") {
      this.publishChannelPointer(nextRelease, "auto-dev");
      if (nextRelease.currentBuildId) {
        await this.generateManifest(nextRelease.releaseId, nextRelease.currentBuildId);
      }
      this.archiveReleaseChangelog(nextRelease, "auto-dev", {
        build: nextRelease.currentBuildId ? this.store.getBuild(nextRelease.currentBuildId) : null,
        reason: "auto-publish-dev",
        summary: payload.summary,
      });
    }
    const event = this.recordEvent({
      projectId: release.projectId,
      projectKey: release.projectKey,
      environment: release.environment,
      objectType: "build",
      objectId: buildId,
      eventType: `build.${payload.status}`,
      payload: { summary: payload.summary ?? null, reports: payload.reports ?? null },
    });
    if (payload.status === "success" && nextRelease.status === "awaiting_approval") {
      const approvalEvent = this.recordEvent({
        projectId: release.projectId,
        projectKey: release.projectKey,
        environment: release.environment,
        objectType: "release",
        objectId: release.releaseId,
        eventType: "release.awaiting_approval",
        payload: {
          buildId: build.buildId,
          version: release.version,
          channel: release.channel,
          environment: release.environment,
        },
      });
      this.queueNotification({
        event: approvalEvent,
        dedupeKey: `release.awaiting_approval:${release.releaseId}`,
        payload: {
          projectKey: release.projectKey,
          environment: release.environment,
          channel: release.channel,
          release: {
            releaseId: release.releaseId,
            version: release.version,
            status: nextRelease.status,
          },
          build: {
            buildId: build.buildId,
            status: nextBuild.status,
            result: nextBuild.result,
            jenkinsJob: nextBuild.jenkinsJob,
            jenkinsBuildNumber: nextBuild.jenkinsBuildNumber,
          },
        },
      });
    }
    if (payload.status !== "success") {
      this.queueNotification({
        event,
        dedupeKey: `${event.eventType}:${build.buildId}`,
        payload: {
          projectKey: release.projectKey,
          environment: release.environment,
          channel: release.channel,
          release: {
            releaseId: release.releaseId,
            version: release.version,
            status: nextRelease.status,
          },
          build: {
            buildId: build.buildId,
            status: nextBuild.status,
            result: nextBuild.result,
            jenkinsJob: nextBuild.jenkinsJob,
            jenkinsBuildNumber: nextBuild.jenkinsBuildNumber,
          },
          summary: payload.summary,
          reports: payload.reports,
        },
      });
    }
    if (nextRelease.status === "published") {
      const publishedEvent = this.recordEvent({
        projectId: release.projectId,
        projectKey: release.projectKey,
        environment: release.environment,
        objectType: "release",
        objectId: release.releaseId,
        eventType: "release.published",
        payload: {
          buildId: build.buildId,
          version: release.version,
          channel: release.channel,
          environment: release.environment,
        },
      });
      this.queueNotification({
        event: publishedEvent,
        dedupeKey: `release.published:${release.releaseId}`,
        payload: {
          projectKey: release.projectKey,
          environment: release.environment,
          channel: release.channel,
          release: {
            releaseId: release.releaseId,
            version: release.version,
            status: nextRelease.status,
            manifestUrl: release.manifestUrl,
          },
          build: {
            buildId: build.buildId,
            status: nextBuild.status,
            result: nextBuild.result,
          },
        },
      });
    }
    return { build: nextBuild, release: nextRelease };
  }

  async approveRelease(
    releaseId: string,
    operator = "system",
    options?: { allowActiveRollout?: boolean },
  ): Promise<ReleaseRecord> {
    const release = this.store.getRelease(releaseId);
    if (!release) {
      throw new Error(`release not found: ${releaseId}`);
    }
    this.assertNoActiveRollback(
      release.projectKey,
      release.environment,
      release.channel,
      "approve-release",
    );
    if (options?.allowActiveRollout !== true) {
      this.assertNoBlockingRolloutForApproval(release);
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
      const publishedRelease = this.store.getRelease(next.releaseId) ?? next;
      this.archiveReleaseChangelog(publishedRelease, operator, {
        build: publishedRelease.currentBuildId
          ? this.store.getBuild(publishedRelease.currentBuildId)
          : null,
        reason: "approve",
      });
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
      const publishedEvent = this.recordEvent({
        projectId: release.projectId,
        projectKey: release.projectKey,
        environment: release.environment,
        objectType: "release",
        objectId: releaseId,
        eventType: "release.published",
        payload: { channel: release.channel, version: release.version },
        createdBy: operator,
      });
      this.queueNotification({
        event: publishedEvent,
        dedupeKey: `release.published:${release.releaseId}`,
        payload: {
          projectKey: release.projectKey,
          environment: release.environment,
          channel: release.channel,
          release: {
            releaseId: publishedRelease.releaseId,
            version: publishedRelease.version,
            status: publishedRelease.status,
            manifestUrl: publishedRelease.manifestUrl,
            publishedAt: publishedRelease.publishedAt,
          },
        },
      });
      return publishedRelease;
    } finally {
      this.releaseChannelLock(release.projectKey, release.environment, release.channel);
    }
  }

  async promoteRelease(params: {
    projectKey: string;
    sourceReleaseId: string;
    targetEnvironment: ReleaseEnvironment;
    targetChannel: ReleaseChannel;
    operator: string;
    notes?: string;
  }): Promise<ReleaseRecord> {
    const source = this.store.getRelease(params.sourceReleaseId);
    if (!source || source.projectKey !== params.projectKey) {
      throw new Error(`release not found: ${params.sourceReleaseId}`);
    }
    this.assertNoActiveRollback(
      params.projectKey,
      params.targetEnvironment,
      params.targetChannel,
      "promote-release",
    );
    if (source.status !== "published" || !source.stable) {
      throw new Error("only stable published releases can be promoted");
    }
    const blockingRollout = this.activeRolloutsForChannel(
      source.projectKey,
      source.environment,
      source.channel,
    ).find((rollout) => rollout.releaseId === source.releaseId);
    if (blockingRollout) {
      throw new Error(
        `rollout.in_progress: promote-release blocked by rollout ${blockingRollout.rolloutId}`,
      );
    }
    this.acquireChannelLock({
      projectKey: params.projectKey,
      environment: params.targetEnvironment,
      channel: params.targetChannel,
      owner: params.operator,
      reason: "promote-release",
    });
    try {
      const existing = this.findReleaseByVersion({
        projectKey: params.projectKey,
        environment: params.targetEnvironment,
        channel: params.targetChannel,
        version: source.version,
      });
      if (existing) {
        const promotedFromReleaseId =
          existing.metadata && typeof existing.metadata.promotedFromReleaseId === "string"
            ? existing.metadata.promotedFromReleaseId
            : undefined;
        if (promotedFromReleaseId === source.releaseId) {
          return existing;
        }
        throw new Error(
          `target channel already has version ${source.version}: ${existing.releaseId}`,
        );
      }
      const targetState = this.getChannelState(
        params.projectKey,
        params.targetEnvironment,
        params.targetChannel,
      );
      const currentTargetRelease = targetState?.currentReleaseId
        ? this.store.getRelease(targetState.currentReleaseId)
        : null;
      const parsed = parseVersion(source.version);
      const now = nowIso();
      const promoted: ReleaseRecord = {
        ...source,
        releaseId: createId("rel"),
        environment: params.targetEnvironment,
        channel: params.targetChannel,
        versionBumpType: inferBumpType(currentTargetRelease?.version, parsed),
        status: "published",
        stable: true,
        frozen: false,
        notes: params.notes?.trim() || source.notes,
        createdBy: params.operator,
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
        manifestPath: undefined,
        manifestUrl: undefined,
        metadata: {
          ...source.metadata,
          promotedFromReleaseId: source.releaseId,
          promotedFromChannel: source.channel,
          promotedFromEnvironment: source.environment,
          promotedAt: now,
        },
      };
      this.store.upsertRelease(promoted);
      this.store.insertReleaseRelation({
        relationId: createId("reln"),
        projectId: promoted.projectId,
        projectKey: promoted.projectKey,
        fromReleaseId: source.releaseId,
        toReleaseId: promoted.releaseId,
        relationType: "promoted_from",
        context: {
          sourceChannel: source.channel,
          sourceEnvironment: source.environment,
          targetChannel: promoted.channel,
          targetEnvironment: promoted.environment,
        },
        createdBy: params.operator,
        createdAt: now,
      });
      this.publishChannelPointer(promoted, params.operator);
      if (promoted.currentBuildId) {
        await this.generateManifest(promoted.releaseId, promoted.currentBuildId);
      }
      const publishedPromotedRelease = this.store.getRelease(promoted.releaseId) ?? promoted;
      this.archiveReleaseChangelog(publishedPromotedRelease, params.operator, {
        build: publishedPromotedRelease.currentBuildId
          ? this.store.getBuild(publishedPromotedRelease.currentBuildId)
          : null,
        reason: "promote",
        sourceReleaseId: source.releaseId,
      });
      this.recordEvent({
        projectId: publishedPromotedRelease.projectId,
        projectKey: publishedPromotedRelease.projectKey,
        environment: publishedPromotedRelease.environment,
        objectType: "release",
        objectId: publishedPromotedRelease.releaseId,
        eventType: "release.promoted",
        payload: {
          fromReleaseId: source.releaseId,
          fromChannel: source.channel,
          fromEnvironment: source.environment,
          toChannel: publishedPromotedRelease.channel,
          toEnvironment: publishedPromotedRelease.environment,
          version: publishedPromotedRelease.version,
        },
        createdBy: params.operator,
      });
      const publishedEvent = this.recordEvent({
        projectId: publishedPromotedRelease.projectId,
        projectKey: publishedPromotedRelease.projectKey,
        environment: publishedPromotedRelease.environment,
        objectType: "release",
        objectId: publishedPromotedRelease.releaseId,
        eventType: "release.published",
        payload: {
          channel: publishedPromotedRelease.channel,
          version: publishedPromotedRelease.version,
          promotedFromReleaseId: source.releaseId,
        },
        createdBy: params.operator,
      });
      this.queueNotification({
        event: publishedEvent,
        dedupeKey: `release.published:${publishedPromotedRelease.releaseId}`,
        payload: {
          projectKey: publishedPromotedRelease.projectKey,
          environment: publishedPromotedRelease.environment,
          channel: publishedPromotedRelease.channel,
          release: {
            releaseId: publishedPromotedRelease.releaseId,
            version: publishedPromotedRelease.version,
            status: publishedPromotedRelease.status,
            manifestUrl: publishedPromotedRelease.manifestUrl,
            publishedAt: publishedPromotedRelease.publishedAt,
            promotedFromReleaseId: source.releaseId,
          },
        },
      });
      return publishedPromotedRelease;
    } finally {
      this.releaseChannelLock(params.projectKey, params.targetEnvironment, params.targetChannel);
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
    this.assertRollbackCompatibility(fromRelease, toRelease);
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

  async approveRollback(rollbackId: string, approver: string): Promise<RollbackOperationRecord> {
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
      const canceledRollouts = this.markRolloutsCanceled(
        rollback.projectKey,
        rollback.environment,
        rollback.channel,
        approver,
        `rollback:${rollbackId}`,
      );
      const stateBefore = this.getChannelState(
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
        previousReleaseId: stateBefore?.currentReleaseId,
        updatedAt: nowIso(),
        updatedBy: approver,
      });
      this.store.upsertRelease({
        ...current,
        status: "rolled_back",
        frozen: rollback.freezeCurrentRelease ? true : current.frozen,
        updatedAt: nowIso(),
      });
      this.store.upsertRelease({
        ...target,
        status: "published",
        stable: true,
        updatedAt: nowIso(),
      });
      if (target.currentBuildId) {
        await this.generateManifest(target.releaseId, target.currentBuildId);
      }
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
      const stateAfter = this.getChannelState(
        rollback.projectKey,
        rollback.environment,
        rollback.channel,
      );
      const completed: RollbackOperationRecord = {
        ...executing,
        status: "completed",
        manifestAction: {
          ...executing.manifestAction,
          audit: {
            channelStateBefore: stateBefore ?? null,
            channelStateAfter: stateAfter ?? null,
            sourceReleaseStatusBefore: current.status,
            targetReleaseStatusBefore: target.status,
            completedBy: approver,
          },
        },
        completedAt: nowIso(),
      };
      this.store.upsertRollback(completed);
      this.recordEvent({
        projectId: current.projectId,
        projectKey: rollback.projectKey,
        environment: rollback.environment,
        objectType: "release",
        objectId: current.releaseId,
        eventType: "release.rolled_back",
        payload: { rollbackId, targetReleaseId: target.releaseId },
        createdBy: approver,
      });
      const rollbackEvent = this.recordEvent({
        projectId: current.projectId,
        projectKey: rollback.projectKey,
        environment: rollback.environment,
        objectType: "rollback",
        objectId: rollbackId,
        eventType: "rollback.completed",
        payload: {
          fromReleaseId: current.releaseId,
          toReleaseId: target.releaseId,
          channelStateBefore: stateBefore ?? null,
          channelStateAfter: stateAfter ?? null,
          canceledRolloutIds: canceledRollouts.map((item) => item.rolloutId),
        },
        createdBy: approver,
      });
      this.queueNotification({
        event: rollbackEvent,
        dedupeKey: `rollback.completed:${rollbackId}`,
        payload: {
          projectKey: rollback.projectKey,
          environment: rollback.environment,
          channel: rollback.channel,
          rollback: {
            rollbackId,
            status: completed.status,
            fromReleaseId: current.releaseId,
            toReleaseId: target.releaseId,
            reason: rollback.reason,
            strategy: rollback.strategy,
          },
          release: {
            currentReleaseId: target.releaseId,
            previousReleaseId: current.releaseId,
          },
        },
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
    const projectKey = this.normalizeCiProjectKey(request.app?.projectKey);
    const baseline = this.resolveBaseline({
      projectKey,
      environment: this.normalizeCiEnvironment(request.app?.environment, projectKey),
      channel: this.normalizeCiChannel(request.app?.channel, projectKey),
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
    this.upsertCiProvenance(next, request);
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
    this.upsertCiProvenance(build, request);
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
    this.upsertCiProvenance(build, request);
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

  private retentionCutoffIso(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  }

  private isManagedCleanupPath(filePath: string): boolean {
    const roots = [this.config.uploadDestinationDir, this.manifestsDir].filter(
      (root): root is string => Boolean(root),
    );
    const resolvedFilePath = path.resolve(filePath);
    return roots.some((root) => {
      const relative = path.relative(path.resolve(root), resolvedFilePath);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
  }

  private protectedReleaseIdsForMaintenance(projectKey: string): Set<string> {
    const releases = this.store.listReleases({ projectKey });
    const protectedIds = new Set<string>();
    for (const release of releases) {
      if (release.frozen) {
        protectedIds.add(release.releaseId);
      }
    }
    const groupKeys = new Set(
      releases.map((release) => `${release.environment}:${release.channel}`),
    );
    for (const groupKey of groupKeys) {
      const [environment, channel] = groupKey.split(":");
      const channelState = this.getChannelState(
        projectKey,
        environment as ReleaseEnvironment,
        channel as ReleaseChannel,
      );
      if (channelState?.currentReleaseId) {
        protectedIds.add(channelState.currentReleaseId);
      }
      if (channelState?.previousReleaseId) {
        protectedIds.add(channelState.previousReleaseId);
      }
      const recentStable = this.listStableReleases({
        projectKey,
        environment: environment as ReleaseEnvironment,
        channel: channel as ReleaseChannel,
        limit: this.config.maintenanceKeepStableCount,
      });
      for (const release of recentStable) {
        protectedIds.add(release.releaseId);
      }
    }
    return protectedIds;
  }

  getStoreStatus(projectKey = this.config.defaultProjectKey): {
    schema: ReturnType<LobsterReleaseStore["getSchemaInfo"]>;
    counts: {
      releases: number;
      builds: number;
      notifications: number;
      failedNotifications: number;
      stableReleases: number;
    };
    retention: {
      artifactRetentionDays: number;
      auditRetentionDays: number;
      maintenanceKeepStableCount: number;
    };
  } {
    const releases = this.store.listReleases({ projectKey });
    const builds = this.store.listBuilds({ projectKey });
    const notifications = this.store.listNotifications();
    return {
      schema: this.store.getSchemaInfo(),
      counts: {
        releases: releases.length,
        builds: builds.length,
        notifications: notifications.length,
        failedNotifications: notifications.filter((item) => item.status === "failed").length,
        stableReleases: releases.filter((item) => item.stable).length,
      },
      retention: {
        artifactRetentionDays: this.config.artifactRetentionDays,
        auditRetentionDays: this.config.auditRetentionDays,
        maintenanceKeepStableCount: this.config.maintenanceKeepStableCount,
      },
    };
  }

  getProjectCatalog(): {
    defaultProjectKey: string;
    projects: Array<{
      projectKey: string;
      name?: string;
      engine?: string;
      defaultEnvironment: ReleaseEnvironment;
      defaultChannel: ReleaseChannel;
      environments: ReleaseEnvironment[];
      channels: ReleaseChannel[];
      autoPublishDev: boolean;
      requiresApproval: Partial<Record<ReleaseChannel, boolean>>;
      regions: string[];
      audiences: string[];
      grayRelease: LobsterReleaseProjectPolicy["grayRelease"];
      scheduledBuildCount: number;
      smokeWorkflows: string[];
    }>;
  } {
    const projectKeys = uniqueStrings([
      this.config.defaultProjectKey,
      ...Object.keys(this.config.projects),
    ]);
    return {
      defaultProjectKey: this.config.defaultProjectKey,
      projects: projectKeys.map((projectKey) => {
        const policy = this.getProjectPolicy(projectKey);
        return {
          projectKey,
          name: policy.name,
          engine: policy.engine,
          defaultEnvironment: policy.defaultEnvironment ?? this.config.defaultEnvironment,
          defaultChannel: policy.defaultChannel ?? this.config.defaultChannel,
          environments: policy.environments,
          channels: policy.channels,
          autoPublishDev: this.autoPublishDevForProject(projectKey),
          requiresApproval: policy.requiresApproval,
          regions: policy.regions,
          audiences: policy.audiences,
          grayRelease: policy.grayRelease,
          scheduledBuildCount: policy.scheduledBuilds.length,
          smokeWorkflows: policy.smokeWorkflows,
        };
      }),
    };
  }

  getGrayReleasePlan(params: {
    projectKey: string;
    environment?: ReleaseEnvironment;
    channel?: ReleaseChannel;
    region?: string;
    audience?: string;
  }): {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    grayRelease: LobsterReleaseProjectPolicy["grayRelease"];
    scope: {
      region?: string;
      audience?: string;
      supportedRegions: string[];
      supportedAudiences: string[];
    };
    scheduledBuilds: LobsterReleaseProjectPolicy["scheduledBuilds"];
    smokeWorkflows: string[];
  } {
    const environment = this.resolveProjectEnvironment(params.projectKey, params.environment);
    const channel = this.resolveProjectChannel(params.projectKey, params.channel);
    this.assertProjectScope(params.projectKey, environment, channel, {
      region: params.region,
      audience: params.audience,
    });
    const policy = this.getProjectPolicy(params.projectKey);
    return {
      projectKey: params.projectKey,
      environment,
      channel,
      grayRelease: policy.grayRelease,
      scope: {
        region: params.region,
        audience: params.audience,
        supportedRegions: policy.regions,
        supportedAudiences: policy.audiences,
      },
      scheduledBuilds: policy.scheduledBuilds,
      smokeWorkflows: policy.smokeWorkflows,
    };
  }

  async createRollout(input: CreateRolloutInput): Promise<RolloutRecord> {
    const release = this.store.getRelease(input.releaseId);
    if (!release || release.projectKey !== input.projectKey) {
      throw new Error(`release not found: ${input.releaseId}`);
    }
    const environment = this.resolveProjectEnvironment(input.projectKey, input.environment);
    const channel = this.resolveProjectChannel(input.projectKey, input.channel);
    if (release.environment !== environment || release.channel !== channel) {
      throw new Error("rollout release must belong to the same project/environment/channel");
    }
    if (release.status !== "awaiting_approval" && release.status !== "published") {
      throw new Error("rollout release must be built and awaiting approval or already published");
    }
    if (!release.currentBuildId) {
      throw new Error("rollout release is missing current build");
    }
    this.assertProjectScope(input.projectKey, environment, channel, input.scope);
    this.assertNoActiveRollback(input.projectKey, environment, channel, "create-rollout");
    this.assertNoConflictingRollout({
      projectKey: input.projectKey,
      environment,
      channel,
      region: input.scope?.region,
      audience: input.scope?.audience,
      releaseId: input.releaseId,
    });
    const project = this.ensureProject(input.projectKey);
    const policy = this.getProjectPolicy(input.projectKey);
    if (!policy.grayRelease.enabled) {
      throw new Error(`gray rollout is not enabled for project: ${input.projectKey}`);
    }
    const now = nowIso();
    const rollout: RolloutRecord = {
      rolloutId: createId("rlt"),
      projectId: project.projectId,
      projectKey: input.projectKey,
      environment,
      channel,
      releaseId: input.releaseId,
      status: "active",
      trafficPercent: this.trafficPercentFromPolicy(input.projectKey, input.trafficPercent),
      stickiness: policy.grayRelease.stickiness,
      scope: {
        region: this.normalizeOptionalScopeValue(input.scope?.region),
        audience: this.normalizeOptionalScopeValue(input.scope?.audience),
      },
      createdBy: input.operator ?? "system",
      notes: input.notes,
      startedAt: now,
      updatedAt: now,
      createdAt: now,
      metadata: {
        rolloutPercentages: policy.grayRelease.rolloutPercentages,
        smokeWorkflows: policy.smokeWorkflows,
      },
    };
    this.store.upsertRollout(rollout);
    this.recordEvent({
      projectId: project.projectId,
      projectKey: input.projectKey,
      environment,
      objectType: "rollout",
      objectId: rollout.rolloutId,
      eventType: "rollout.created",
      payload: {
        releaseId: input.releaseId,
        trafficPercent: rollout.trafficPercent,
        scope: rollout.scope,
        channel,
      },
      createdBy: rollout.createdBy,
    });
    return rollout;
  }

  async advanceRollout(input: AdvanceRolloutInput): Promise<RolloutRecord> {
    const rollout = this.store.getRollout(input.rolloutId);
    if (!rollout || rollout.projectKey !== input.projectKey) {
      throw new Error(`rollout not found: ${input.rolloutId}`);
    }
    if (rollout.status === "canceled" || rollout.status === "completed") {
      throw new Error(`rollout is terminal: ${rollout.rolloutId}`);
    }
    this.assertNoActiveRollback(
      rollout.projectKey,
      rollout.environment,
      rollout.channel,
      "advance-rollout",
    );
    this.acquireChannelLock({
      projectKey: rollout.projectKey,
      environment: rollout.environment,
      channel: rollout.channel,
      owner: input.operator ?? "system",
      reason: "advance-rollout",
    });
    const now = nowIso();
    const trafficPercent = this.trafficPercentFromPolicy(
      rollout.projectKey,
      input.trafficPercent,
      input.complete,
    );
    const next: RolloutRecord = {
      ...rollout,
      status: input.complete || trafficPercent >= 100 ? "completed" : "active",
      trafficPercent,
      completedAt: input.complete || trafficPercent >= 100 ? now : rollout.completedAt,
      updatedAt: now,
      metadata: {
        ...asRecord(rollout.metadata),
        lastAdvancedBy: input.operator ?? "system",
      },
    };
    try {
      this.store.upsertRollout(next);
    } finally {
      this.releaseChannelLock(rollout.projectKey, rollout.environment, rollout.channel);
    }
    const release = this.store.getRelease(rollout.releaseId);
    if (
      (input.publishRelease === true || next.trafficPercent >= 100) &&
      release &&
      release.status !== "published"
    ) {
      await this.approveRelease(release.releaseId, input.operator ?? "system", {
        allowActiveRollout: true,
      });
    }
    this.recordEvent({
      projectId: rollout.projectId,
      projectKey: rollout.projectKey,
      environment: rollout.environment,
      objectType: "rollout",
      objectId: rollout.rolloutId,
      eventType: next.status === "completed" ? "rollout.completed" : "rollout.advanced",
      payload: {
        releaseId: rollout.releaseId,
        trafficPercent: next.trafficPercent,
        publishRelease: input.publishRelease === true,
      },
      createdBy: input.operator ?? "system",
    });
    return this.store.getRollout(rollout.rolloutId) ?? next;
  }

  cancelRollout(input: CancelRolloutInput): RolloutRecord {
    const rollout = this.store.getRollout(input.rolloutId);
    if (!rollout || rollout.projectKey !== input.projectKey) {
      throw new Error(`rollout not found: ${input.rolloutId}`);
    }
    if (rollout.status === "canceled" || rollout.status === "completed") {
      return rollout;
    }
    const now = nowIso();
    const next: RolloutRecord = {
      ...rollout,
      status: "canceled",
      canceledAt: now,
      completedAt: rollout.completedAt ?? now,
      updatedAt: now,
      metadata: {
        ...asRecord(rollout.metadata),
        canceledBy: input.operator ?? "system",
        canceledReason: input.reason,
      },
    };
    this.store.upsertRollout(next);
    this.recordEvent({
      projectId: rollout.projectId,
      projectKey: rollout.projectKey,
      environment: rollout.environment,
      objectType: "rollout",
      objectId: rollout.rolloutId,
      eventType: "rollout.canceled",
      payload: {
        releaseId: rollout.releaseId,
        reason: input.reason,
      },
      createdBy: input.operator ?? "system",
    });
    return next;
  }

  resolveChannelRoute(params: {
    projectKey: string;
    environment?: ReleaseEnvironment;
    channel?: ReleaseChannel;
    region?: string;
    audience?: string;
    bucketValue?: number;
    subjectKey?: string;
  }): {
    projectKey: string;
    environment: ReleaseEnvironment;
    channel: ReleaseChannel;
    route: "rollout" | "channel";
    bucket: number;
    selectedRelease: ReleaseRecord | null;
    selectedManifestUrl?: string;
    activeRollouts: Array<{
      rollout: RolloutRecord;
      release: ReleaseRecord | null;
      matched: boolean;
    }>;
    fallbackRelease: ReleaseRecord | null;
  } {
    const environment = this.resolveProjectEnvironment(params.projectKey, params.environment);
    const channel = this.resolveProjectChannel(params.projectKey, params.channel);
    this.assertProjectScope(params.projectKey, environment, channel, {
      region: params.region,
      audience: params.audience,
    });
    const fallbackState = this.getChannelState(params.projectKey, environment, channel);
    const fallbackRelease = fallbackState?.currentReleaseId
      ? this.store.getRelease(fallbackState.currentReleaseId)
      : null;
    const bucket =
      typeof params.bucketValue === "number" &&
      Number.isFinite(params.bucketValue) &&
      params.bucketValue >= 0 &&
      params.bucketValue < 100
        ? Math.trunc(params.bucketValue)
        : this.rolloutBucket(
            params.subjectKey ??
              [
                params.projectKey,
                environment,
                channel,
                params.region ?? "",
                params.audience ?? "",
              ].join(":"),
          );
    const candidates = this.matchingRolloutsForRoute({
      projectKey: params.projectKey,
      environment,
      channel,
      region: params.region,
      audience: params.audience,
    });
    const selectedRollout = candidates.find((rollout) => bucket < rollout.trafficPercent);
    const selectedRelease = selectedRollout
      ? this.store.getRelease(selectedRollout.releaseId)
      : fallbackRelease;
    return {
      projectKey: params.projectKey,
      environment,
      channel,
      route: selectedRollout ? "rollout" : "channel",
      bucket,
      selectedRelease,
      selectedManifestUrl: selectedRelease?.manifestUrl,
      activeRollouts: candidates.map((rollout) => ({
        rollout,
        release: this.store.getRelease(rollout.releaseId),
        matched: selectedRollout?.rolloutId === rollout.rolloutId,
      })),
      fallbackRelease,
    };
  }

  async runMaintenance(params?: { projectKey?: string; dryRun?: boolean }): Promise<{
    projectKey: string;
    dryRun: boolean;
    schema: ReturnType<LobsterReleaseStore["getSchemaInfo"]>;
    retention: {
      artifactRetentionDays: number;
      auditRetentionDays: number;
      maintenanceKeepStableCount: number;
    };
    protectedReleaseIds: string[];
    artifactCleanup: {
      candidateReleaseIds: string[];
      candidateBuildIds: string[];
      candidateArtifactIds: string[];
      manifestReleaseIds: string[];
      deletedFiles: string[];
      deletedArtifactRows: number;
      deletedManifestLinks: number;
    };
    auditCleanup: {
      deletedEvents: number;
      deletedNotifications: number;
      deletedIdempotencyReceipts: number;
    };
  }> {
    const projectKey = params?.projectKey ?? this.config.defaultProjectKey;
    const dryRun = params?.dryRun !== false;
    this.store.purgeExpiredLocks();
    this.store.purgeExpiredCallbackNonces();
    const artifactCutoff = this.retentionCutoffIso(this.config.artifactRetentionDays);
    const auditCutoff = this.retentionCutoffIso(this.config.auditRetentionDays);
    const protectedReleaseIds = this.protectedReleaseIdsForMaintenance(projectKey);
    const releases = this.store.listReleases({ projectKey });
    const candidateReleases = releases.filter((release) => {
      const activityAt = release.publishedAt ?? release.updatedAt;
      return !protectedReleaseIds.has(release.releaseId) && activityAt <= artifactCutoff;
    });
    const candidateReleaseIds = new Set(candidateReleases.map((release) => release.releaseId));
    const candidateBuilds = this.store
      .listBuilds({ projectKey })
      .filter((build) => candidateReleaseIds.has(build.releaseId));
    const artifactCandidates = candidateBuilds.flatMap((build) =>
      this.store.listArtifactsForBuild(build.buildId),
    );
    const deletedFiles: string[] = [];
    for (const artifact of artifactCandidates) {
      const filePath = await this.resolveArtifactFilePath(artifact);
      if (!filePath || !this.isManagedCleanupPath(filePath)) {
        continue;
      }
      if (!dryRun && (await this.pathExists(filePath))) {
        await fs.rm(filePath, { force: true });
      }
      deletedFiles.push(filePath);
    }
    const manifestReleases = candidateReleases.filter(
      (release) => release.manifestPath && this.isManagedCleanupPath(release.manifestPath),
    );
    for (const release of manifestReleases) {
      if (!release.manifestPath) {
        continue;
      }
      if (!dryRun && (await this.pathExists(release.manifestPath))) {
        await fs.rm(release.manifestPath, { force: true });
      }
      deletedFiles.push(release.manifestPath);
      if (!dryRun) {
        this.store.upsertRelease({
          ...release,
          manifestPath: undefined,
          manifestUrl: undefined,
          updatedAt: nowIso(),
        });
      }
    }
    const deletedArtifactRows = dryRun
      ? artifactCandidates.length
      : this.store.deleteArtifacts(artifactCandidates.map((artifact) => artifact.artifactId));
    const deletedEvents = dryRun ? 0 : this.store.purgeEvents(auditCutoff);
    const deletedNotifications = dryRun
      ? 0
      : this.store.purgeNotifications({
          before: auditCutoff,
          statuses: ["sent", "failed"],
        });
    const deletedIdempotencyReceipts = dryRun
      ? 0
      : this.store.purgeIdempotencyReceipts(auditCutoff);
    const result = {
      projectKey,
      dryRun,
      schema: this.store.getSchemaInfo(),
      retention: {
        artifactRetentionDays: this.config.artifactRetentionDays,
        auditRetentionDays: this.config.auditRetentionDays,
        maintenanceKeepStableCount: this.config.maintenanceKeepStableCount,
      },
      protectedReleaseIds: [...protectedReleaseIds],
      artifactCleanup: {
        candidateReleaseIds: candidateReleases.map((release) => release.releaseId),
        candidateBuildIds: candidateBuilds.map((build) => build.buildId),
        candidateArtifactIds: artifactCandidates.map((artifact) => artifact.artifactId),
        manifestReleaseIds: manifestReleases.map((release) => release.releaseId),
        deletedFiles,
        deletedArtifactRows,
        deletedManifestLinks: manifestReleases.length,
      },
      auditCleanup: {
        deletedEvents,
        deletedNotifications,
        deletedIdempotencyReceipts,
      },
    };
    this.recordSystemEvent({
      projectKey,
      environment: undefined,
      objectType: "maintenance",
      objectId: projectKey,
      eventType: "maintenance.completed",
      payload: {
        dryRun,
        retention: result.retention,
        artifactCleanup: {
          candidateReleaseCount: result.artifactCleanup.candidateReleaseIds.length,
          candidateBuildCount: result.artifactCleanup.candidateBuildIds.length,
          candidateArtifactCount: result.artifactCleanup.candidateArtifactIds.length,
          deletedArtifactRows: result.artifactCleanup.deletedArtifactRows,
          deletedManifestLinks: result.artifactCleanup.deletedManifestLinks,
        },
        auditCleanup: result.auditCleanup,
      },
      createdBy: "system",
    });
    return result;
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
      compatibility: this.compatibilityForRelease(release),
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
