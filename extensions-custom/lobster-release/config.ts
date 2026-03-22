import type { ReleaseChannel, ReleaseEnvironment } from "./types.js";

export type LobsterReleaseConfig = {
  defaultProjectKey: string;
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

export function resolveLobsterReleaseConfig(raw: unknown): LobsterReleaseConfig {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    defaultProjectKey: asNonEmptyString(input.defaultProjectKey) ?? "gamexpert",
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
    autoPublishDev: asBoolean(input.autoPublishDev, true),
    defaultEnvironment:
      (asNonEmptyString(input.defaultEnvironment) as ReleaseEnvironment | undefined) ?? "staging",
    defaultChannel:
      (asNonEmptyString(input.defaultChannel) as ReleaseChannel | undefined) ?? "beta",
  };
}
