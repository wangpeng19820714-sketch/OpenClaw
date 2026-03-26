export type ReleaseEnvironment = "test" | "staging" | "production";
export type ReleaseChannel = "dev" | "beta" | "release";
export type ReleaseStatus =
  | "draft"
  | "building"
  | "built"
  | "awaiting_approval"
  | "published"
  | "failed"
  | "rolled_back";
export type BuildStatus =
  | "queued"
  | "triggering"
  | "building"
  | "uploaded"
  | "finished"
  | "failed"
  | "canceled";
export type ReleaseBumpType = "patch" | "minor" | "major";
export type ReleaseVersionSource = "manual" | "suggested" | "enforced";
export type ReleaseRelationType =
  | "derived_from"
  | "patch_based_on"
  | "promoted_from"
  | "rolled_back_to"
  | "rebuilt_from"
  | "replaced_by";
export type RollbackStatus =
  | "requested"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "canceled";
export type RollbackStrategy = "pointer_switch" | "manifest_republish" | "rebuild_and_publish";
export type ArtifactType =
  | "android_apk"
  | "android_aab"
  | "macos_zip"
  | "patch_bundle"
  | "patch_manifest"
  | "patch_list"
  | "build_report"
  | "bundle_layout"
  | "manifest"
  | "sha256";
export type LockScope = "channel" | "release" | "build" | "rollback";
export type NotificationStatus = "pending" | "sending" | "sent" | "failed";
export type NotificationChannel = "feishu";

export type ProjectRecord = {
  projectId: string;
  projectKey: string;
  name: string;
  engine: string;
  defaultChannel: ReleaseChannel;
  createdAt: string;
  updatedAt: string;
};

export type ReleaseRecord = {
  releaseId: string;
  projectId: string;
  projectKey: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  version: string;
  displayVersion?: string;
  versionScheme: "semver3";
  versionMajor: number;
  versionMinor: number;
  versionPatch: number;
  versionPrerelease?: string;
  versionBuildmeta?: string;
  versionBumpType: ReleaseBumpType;
  versionSource: ReleaseVersionSource;
  status: ReleaseStatus;
  stable: boolean;
  frozen: boolean;
  git: {
    url?: string;
    branch?: string;
    commit?: string;
    commitShort?: string;
    tag?: string;
  };
  notes?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  currentBuildId?: string;
  manifestPath?: string;
  manifestUrl?: string;
  metadata?: Record<string, unknown>;
};

export type BuildTargets = {
  androidApk: boolean;
  androidAab: boolean;
  macosApp: boolean;
  patch: boolean;
};

export type BuildRecord = {
  buildId: string;
  releaseId: string;
  projectId: string;
  projectKey: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  status: BuildStatus;
  result?: "success" | "failed" | "canceled";
  triggeredBy?: string;
  triggerSource: "manual" | "api" | "agent" | "rollback";
  sourceGitUrl?: string;
  sourceGitBranch?: string;
  sourceGitCommit?: string;
  sourceGitCommitShort?: string;
  jenkinsJob?: string;
  jenkinsBuildNumber?: number;
  jenkinsQueueId?: string;
  baselineVersion?: string;
  baselineManifestUrl?: string;
  rebuildOfBuildId?: string;
  idempotencyKey?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  targets: BuildTargets;
  reports?: Record<string, unknown>;
};

export type ArtifactRecord = {
  artifactId: string;
  buildId: string;
  releaseId: string;
  projectId: string;
  projectKey: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  artifactType: ArtifactType;
  platform: string;
  fileName: string;
  fileSizeBytes: number;
  sha256: string;
  storageProvider: string;
  storageBucket?: string;
  storagePath: string;
  downloadUrl: string;
  manifestRole?: string;
  immutable: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type BaselineRecord = {
  baselineId: string;
  projectId: string;
  projectKey: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  platform: string;
  fromReleaseId?: string;
  toReleaseId?: string;
  fromVersion: string;
  toVersion: string;
  baselineManifestUrl: string;
  patchManifestUrl?: string;
  compatibilityRule: "reuse" | "validate" | "reset";
  status: "active" | "deprecated" | "blocked";
  createdAt: string;
};

export type ChannelStateRecord = {
  projectId: string;
  projectKey: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  currentReleaseId?: string;
  previousReleaseId?: string;
  updatedAt: string;
  updatedBy?: string;
};

export type EventLogRecord = {
  eventId: string;
  projectId: string;
  projectKey: string;
  environment?: ReleaseEnvironment;
  objectType: string;
  objectId: string;
  eventType: string;
  requestId?: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
};

export type NotificationOutboxRecord = {
  notificationId: string;
  eventId: string;
  projectId: string;
  projectKey: string;
  environment?: ReleaseEnvironment;
  channel?: ReleaseChannel;
  eventType: string;
  deliveryChannel: NotificationChannel;
  status: NotificationStatus;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  lastError?: string;
  claimedAt?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  requeuedAt?: string;
  requeueReason?: string;
  deadLetteredAt?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ReleaseRelationRecord = {
  relationId: string;
  projectId: string;
  projectKey: string;
  fromReleaseId: string;
  toReleaseId: string;
  relationType: ReleaseRelationType;
  context: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
};

export type BuildProvenanceRecord = {
  provenanceId: string;
  buildId: string;
  releaseId: string;
  projectId: string;
  projectKey: string;
  sourceGitUrl?: string;
  sourceGitBranch?: string;
  sourceGitCommit?: string;
  sourceGitCommitShort?: string;
  sourceGitTag?: string;
  workspaceRevision?: string;
  jenkinsJob?: string;
  jenkinsBuildNumber?: number;
  jenkinsQueueId?: string;
  executorNode?: string;
  executorLabel?: string;
  godotVersion?: string;
  godotBin?: string;
  dotnetVersion?: string;
  exportPresets: string[];
  buildTargets: string[];
  baselineVersion?: string;
  baselineManifestUrl?: string;
  configFingerprint?: string;
  assetGroupsFingerprint?: string;
  scriptsFingerprint?: string;
  envSnapshot: Record<string, unknown>;
  parameters: Record<string, unknown>;
  provenanceHash: string;
  capturedAt: string;
};

export type RollbackOperationRecord = {
  rollbackId: string;
  projectId: string;
  projectKey: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  fromReleaseId: string;
  toReleaseId: string;
  status: RollbackStatus;
  reason: string;
  triggeredBy: string;
  approvedBy?: string;
  strategy: RollbackStrategy;
  freezeCurrentRelease: boolean;
  manifestAction: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
};

export type OperationLockRecord = {
  lockId: string;
  projectId: string;
  projectKey: string;
  environment: ReleaseEnvironment;
  lockScope: LockScope;
  lockKey: string;
  owner: string;
  reason?: string;
  expiresAt: string;
  createdAt: string;
};

export type ReleaseManifest = {
  manifestVersion: 1;
  project: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  releaseId: string;
  buildId: string;
  version: string;
  displayVersion?: string;
  status: "published";
  stable: boolean;
  frozen: boolean;
  rollbackTarget?: string;
  publishedAt?: string;
  git: {
    branch?: string;
    commit?: string;
    commitShort?: string;
    tag?: string;
  };
  provenance: {
    hash: string;
    jenkinsJob?: string;
    jenkinsBuildNumber?: number;
  };
  compatibility: {
    minClientVersion: string;
    resourceProtocolVersion: number;
    minManifestVersion: number;
  };
  baseline?: {
    releaseId?: string;
    version?: string;
    manifestUrl?: string;
    strategy: "reuse" | "validate" | "reset";
  };
  artifacts: Array<{
    type: ArtifactType;
    platform: string;
    fileName: string;
    downloadUrl: string;
    sha256: string;
    sizeBytes: number;
    manifestRole?: string;
  }>;
  patch?: {
    enabled: boolean;
    manifestUrl?: string;
    bundleUrl?: string;
    riskLevel: "low" | "medium" | "high";
  };
  metadata?: Record<string, unknown>;
};

export type CreateReleaseInput = {
  projectKey: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  version: string;
  git?: {
    url?: string;
    branch?: string;
    commit?: string;
    tag?: string;
  };
  targets: BuildTargets;
  notes?: string;
  triggerBuild: boolean;
  createdBy?: string;
};

export type TriggerReleaseInput = {
  projectKey: string;
  releaseId: string;
  operator?: string;
  rebuild?: boolean;
};

export type RollbackInput = {
  projectKey: string;
  environment: ReleaseEnvironment;
  channel: ReleaseChannel;
  targetReleaseId: string;
  reason: string;
  strategy: RollbackStrategy;
  freezeCurrentRelease: boolean;
  operator: string;
  comment?: string;
};

export type CiGitInfo = {
  url?: string;
  branch?: string;
  commit?: string;
  shortCommit?: string;
};

export type CiAppInfo = {
  appVersion?: string;
  resourceVersion?: string;
  platform?: string;
  channel?: string;
};

export type CiBaselineInfo = {
  strategy?: string;
  baselineVersion?: string;
  baselineManifestUrl?: string;
  baselinePackageUrl?: string;
  baselineSha256?: string;
};

export type CiBuildRequest = {
  requestId?: string;
  jobName?: string;
  buildNumber?: string | number;
  pipelineUrl?: string;
  target?: string;
  targets?: string[];
  git?: CiGitInfo;
  app?: CiAppInfo;
  baseline?: CiBaselineInfo;
};

export type CiPublishArtifact = {
  target?: string;
  name?: string;
  relativePath?: string;
  uploadedPath?: string;
  downloadUrl?: string;
  sha256?: string;
  sizeBytes?: number;
};

export type CiPublishRequest = CiBuildRequest & {
  artifacts?: CiPublishArtifact[];
  reports?: Record<string, unknown>;
};

export type CiFinishRequest = CiBuildRequest & {
  result?: string;
  durationSeconds?: number;
  summary?: {
    artifactCount?: number;
    failedStage?: string;
    message?: string;
  };
};
