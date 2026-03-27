import type { ReleaseChannel, ReleaseEnvironment } from "./types.js";

export type LobsterReleaseProjectPolicy = {
  name?: string;
  engine?: string;
  defaultEnvironment?: ReleaseEnvironment;
  defaultChannel?: ReleaseChannel;
  environments: ReleaseEnvironment[];
  channels: ReleaseChannel[];
  autoPublishDev?: boolean;
  requiresApproval: Partial<Record<ReleaseChannel, boolean>>;
  regions: string[];
  audiences: string[];
  grayRelease: {
    enabled: boolean;
    rolloutPercentages: number[];
    stickiness: "channel" | "account" | "device";
    monitoring: {
      enabled: boolean;
      minSampleSize: number;
      minSuccessRate: number;
      maxErrorRate: number;
      maxCrashRate: number;
      autoAdvance: boolean;
      autoAdvanceAfterMinutes: number;
      publishOnComplete: boolean;
      circuitBreakerAction: "pause" | "cancel";
    };
  };
  scheduledBuilds: Array<{
    name: string;
    cron: string;
    environment?: ReleaseEnvironment;
    channel?: ReleaseChannel;
    targets: string[];
  }>;
  smokeWorkflows: string[];
};

export type LobsterReleaseConfig = {
  defaultProjectKey: string;
  projects: Record<string, LobsterReleaseProjectPolicy>;
  routePrefix: string;
  ciRoutePrefix: string;
  notifierSessionKey?: string;
  notifierChannel?: string;
  notifierTarget?: string;
  notifierAccountId?: string;
  publicBaseUrl?: string;
  callbackToken?: string;
  ciApiKey?: string;
  ciApiSecret?: string;
  jenkinsBaseUrl?: string;
  jenkinsJob?: string;
  jenkinsUser?: string;
  jenkinsApiToken?: string;
  jenkinsLobsterApiKeyCredentialsId?: string;
  jenkinsLobsterApiSecretCredentialsId?: string;
  jenkinsAndroidKeystoreBase64CredentialsId?: string;
  jenkinsAndroidKeystoreAliasCredentialsId?: string;
  jenkinsAndroidKeystorePasswordCredentialsId?: string;
  uploadDestinationDir?: string;
  uploadBaseUrl?: string;
  artifactRetentionDays: number;
  auditRetentionDays: number;
  maintenanceKeepStableCount: number;
  autoPublishDev: boolean;
  defaultEnvironment: ReleaseEnvironment;
  defaultChannel: ReleaseChannel;
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function asNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function asRate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim()))]
    : [];
}

function asReleaseEnvironmentArray(value: unknown): ReleaseEnvironment[] {
  return asStringArray(value).filter((item): item is ReleaseEnvironment =>
    ["test", "staging", "production"].includes(item),
  );
}

function asReleaseChannelArray(value: unknown): ReleaseChannel[] {
  return asStringArray(value).filter((item): item is ReleaseChannel =>
    ["dev", "beta", "release"].includes(item),
  );
}

function resolveProjectPolicy(raw: unknown): LobsterReleaseProjectPolicy {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const environments = asReleaseEnvironmentArray(input.environments);
  const channels = asReleaseChannelArray(input.channels);
  const grayRaw =
    input.grayRelease && typeof input.grayRelease === "object"
      ? (input.grayRelease as Record<string, unknown>)
      : {};
  const monitoringRaw =
    grayRaw.monitoring && typeof grayRaw.monitoring === "object"
      ? (grayRaw.monitoring as Record<string, unknown>)
      : {};
  const scheduledBuilds = Array.isArray(input.scheduledBuilds)
    ? input.scheduledBuilds
        .map((item) => {
          const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          const name = asNonEmptyString(record.name);
          const cron = asNonEmptyString(record.cron);
          if (!name || !cron) {
            return null;
          }
          return {
            name,
            cron,
            environment: asNonEmptyString(record.environment) as ReleaseEnvironment | undefined,
            channel: asNonEmptyString(record.channel) as ReleaseChannel | undefined,
            targets: asStringArray(record.targets),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];
  return {
    name: asNonEmptyString(input.name),
    engine: asNonEmptyString(input.engine),
    defaultEnvironment: asNonEmptyString(input.defaultEnvironment) as
      | ReleaseEnvironment
      | undefined,
    defaultChannel: asNonEmptyString(input.defaultChannel) as ReleaseChannel | undefined,
    environments: environments.length > 0 ? environments : ["test", "staging", "production"],
    channels: channels.length > 0 ? channels : ["dev", "beta", "release"],
    autoPublishDev: typeof input.autoPublishDev === "boolean" ? input.autoPublishDev : undefined,
    requiresApproval: {
      dev:
        input.requiresApproval &&
        typeof input.requiresApproval === "object" &&
        (input.requiresApproval as Record<string, unknown>).dev === true
          ? true
          : undefined,
      beta:
        !input.requiresApproval ||
        typeof input.requiresApproval !== "object" ||
        (input.requiresApproval as Record<string, unknown>).beta !== false,
      release:
        !input.requiresApproval ||
        typeof input.requiresApproval !== "object" ||
        (input.requiresApproval as Record<string, unknown>).release !== false,
    },
    regions: asStringArray(input.regions),
    audiences: asStringArray(input.audiences),
    grayRelease: {
      enabled: grayRaw.enabled === true,
      rolloutPercentages:
        Array.isArray(grayRaw.rolloutPercentages) &&
        grayRaw.rolloutPercentages.some(
          (item) => typeof item === "number" && item > 0 && item <= 100,
        )
          ? grayRaw.rolloutPercentages
              .filter((item): item is number => typeof item === "number" && item > 0 && item <= 100)
              .toSorted((left, right) => left - right)
          : [5, 10, 25, 50, 100],
      stickiness:
        grayRaw.stickiness === "channel" ||
        grayRaw.stickiness === "device" ||
        grayRaw.stickiness === "account"
          ? grayRaw.stickiness
          : "account",
      monitoring: {
        enabled: monitoringRaw.enabled === true,
        minSampleSize: asNonNegativeInteger(monitoringRaw.minSampleSize, 100),
        minSuccessRate: asRate(monitoringRaw.minSuccessRate, 0.95),
        maxErrorRate: asRate(monitoringRaw.maxErrorRate, 0.05),
        maxCrashRate: asRate(monitoringRaw.maxCrashRate, 0.02),
        autoAdvance: monitoringRaw.autoAdvance === true,
        autoAdvanceAfterMinutes: asNonNegativeInteger(monitoringRaw.autoAdvanceAfterMinutes, 0),
        publishOnComplete: monitoringRaw.publishOnComplete !== false,
        circuitBreakerAction: monitoringRaw.circuitBreakerAction === "cancel" ? "cancel" : "pause",
      },
    },
    scheduledBuilds,
    smokeWorkflows: asStringArray(input.smokeWorkflows),
  };
}

export function resolveLobsterReleaseConfig(raw: unknown): LobsterReleaseConfig {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaultProjectKey = asNonEmptyString(input.defaultProjectKey) ?? "gamexpert";
  const rawProjects =
    input.projects && typeof input.projects === "object"
      ? (input.projects as Record<string, unknown>)
      : {};
  const projects = Object.fromEntries(
    Object.entries(rawProjects)
      .map(([projectKey, policy]) => [projectKey, resolveProjectPolicy(policy)])
      .filter(([projectKey]) => projectKey.trim()),
  ) as Record<string, LobsterReleaseProjectPolicy>;
  if (!projects[defaultProjectKey]) {
    projects[defaultProjectKey] = resolveProjectPolicy({});
  }
  return {
    defaultProjectKey,
    projects,
    routePrefix:
      asNonEmptyString(input.routePrefix)?.replace(/\/+$/, "") ?? "/plugins/lobster-release/api",
    ciRoutePrefix: asNonEmptyString(input.ciRoutePrefix)?.replace(/\/+$/, "") ?? "/api/ci/v1",
    notifierSessionKey: asNonEmptyString(input.notifierSessionKey),
    notifierChannel: asNonEmptyString(input.notifierChannel),
    notifierTarget: asNonEmptyString(input.notifierTarget),
    notifierAccountId: asNonEmptyString(input.notifierAccountId),
    publicBaseUrl: asNonEmptyString(input.publicBaseUrl)?.replace(/\/+$/, ""),
    callbackToken: asNonEmptyString(input.callbackToken),
    ciApiKey: asNonEmptyString(input.ciApiKey),
    ciApiSecret: asNonEmptyString(input.ciApiSecret),
    jenkinsBaseUrl: asNonEmptyString(input.jenkinsBaseUrl)?.replace(/\/+$/, ""),
    jenkinsJob: asNonEmptyString(input.jenkinsJob),
    jenkinsUser: asNonEmptyString(input.jenkinsUser),
    jenkinsApiToken: asNonEmptyString(input.jenkinsApiToken),
    jenkinsLobsterApiKeyCredentialsId: asNonEmptyString(input.jenkinsLobsterApiKeyCredentialsId),
    jenkinsLobsterApiSecretCredentialsId: asNonEmptyString(
      input.jenkinsLobsterApiSecretCredentialsId,
    ),
    jenkinsAndroidKeystoreBase64CredentialsId: asNonEmptyString(
      input.jenkinsAndroidKeystoreBase64CredentialsId,
    ),
    jenkinsAndroidKeystoreAliasCredentialsId: asNonEmptyString(
      input.jenkinsAndroidKeystoreAliasCredentialsId,
    ),
    jenkinsAndroidKeystorePasswordCredentialsId: asNonEmptyString(
      input.jenkinsAndroidKeystorePasswordCredentialsId,
    ),
    uploadDestinationDir: asNonEmptyString(input.uploadDestinationDir),
    uploadBaseUrl: asNonEmptyString(input.uploadBaseUrl)?.replace(/\/+$/, ""),
    artifactRetentionDays: asInteger(input.artifactRetentionDays, 21),
    auditRetentionDays: asInteger(input.auditRetentionDays, 30),
    maintenanceKeepStableCount: asInteger(input.maintenanceKeepStableCount, 10),
    autoPublishDev: asBoolean(input.autoPublishDev, true),
    defaultEnvironment:
      (asNonEmptyString(input.defaultEnvironment) as ReleaseEnvironment | undefined) ?? "staging",
    defaultChannel:
      (asNonEmptyString(input.defaultChannel) as ReleaseChannel | undefined) ?? "beta",
  };
}
