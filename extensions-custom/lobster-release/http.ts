import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  type PluginLogger,
} from "openclaw/plugin-sdk/lobster";
import type { LobsterReleaseConfig } from "./config.js";
import type { LobsterReleaseRuntime } from "./runtime.js";
import type {
  BuildTargets,
  CiBuildRequest,
  CiFinishRequest,
  CiPublishRequest,
  CreateReleaseInput,
  ReleaseChannel,
  ReleaseEnvironment,
} from "./types.js";

const CALLBACK_RATE_LIMIT_WINDOW_MS = 60_000;
const CALLBACK_RATE_LIMIT_MAX_REQUESTS = 60;
const CALLBACK_RETRY_AFTER_SECONDS = 30;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extras?: Record<string, unknown>,
): void {
  sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
      ...extras,
    },
  });
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".json":
      return "application/json; charset=utf-8";
    case ".apk":
      return "application/vnd.android.package-archive";
    case ".aab":
      return "application/octet-stream";
    case ".zip":
      return "application/zip";
    case ".sha256":
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function resolveSafeChildPath(rootDir: string, relativePath: string): string | null {
  const normalized = path.posix.normalize(`/${relativePath}`).replace(/^\/+/, "");
  const candidate = path.resolve(rootDir, normalized);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (candidate !== rootDir && !candidate.startsWith(rootWithSep)) {
    return null;
  }
  return candidate;
}

async function sendFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const body = await fs.readFile(filePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", guessContentType(filePath));
    res.end(body);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      sendText(res, 404, "Not Found", "text/plain; charset=utf-8");
      return;
    }
    throw error;
  }
}

function sendCiError(
  res: ServerResponse,
  status: number,
  message: string,
  extras?: Record<string, unknown>,
): void {
  sendJson(res, status, {
    code: status,
    message,
    data: extras ?? null,
  });
}

function ciEnvelope(data: unknown) {
  return {
    code: 0,
    message: "ok",
    data,
  };
}

function ok(data: unknown) {
  return {
    ok: true,
    data,
  };
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readHeaderString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function parseRoutePath(fullPath: string, prefix: string): string {
  if (!fullPath.startsWith(prefix)) {
    return fullPath;
  }
  const trimmed = fullPath.slice(prefix.length);
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function matchPath(pattern: RegExp, pathname: string): RegExpExecArray | null {
  return pattern.exec(pathname);
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
  const value = JSON.parse(rawBody) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function resolveCiIdempotencyKey(
  pathname: string,
  headers: IncomingMessage["headers"],
  body: Record<string, unknown>,
): string | undefined {
  return (
    readHeaderString(headers["x-lobster-idempotency-key"]) ??
    readString(body.requestId) ??
    (() => {
      const jobName = readString(body.jobName);
      const buildNumber = readString(body.buildNumber);
      return jobName && buildNumber ? `${pathname}:${jobName}:${buildNumber}` : undefined;
    })()
  );
}

function resolveSignedCallbackIdempotencyKey(
  pathname: string,
  headers: IncomingMessage["headers"],
  body: Record<string, unknown>,
  requestHash: string,
): string {
  return (
    readHeaderString(headers["x-idempotency-key"]) ??
    readString(body.idempotencyKey) ??
    `${pathname}:${requestHash}`
  );
}

function isSignedBuildCallbackPath(pathname: string): boolean {
  return /^\/projects\/[^/]+\/builds\/[^/]+\/(start|publish|finish)$/.test(pathname);
}

function normalizeBuildTargets(raw: unknown): BuildTargets {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    androidApk: input.androidApk === true,
    androidAab: input.androidAab === true,
    macosApp: input.macosApp === true,
    patch: input.patch === true,
  };
}

async function readJsonObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
  options: { maxBytes: number; timeoutMs: number },
): Promise<Record<string, unknown> | null> {
  const result = await readJsonBodyWithLimit(req, options);
  if (!result.ok) {
    sendError(res, 400, "request.invalid_json", result.error);
    return null;
  }
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    sendError(res, 400, "request.invalid_json", "request body must be a JSON object");
    return null;
  }
  return result.value as Record<string, unknown>;
}

function verifyCallbackSignature(
  body: string,
  req: IncomingMessage,
  config: LobsterReleaseConfig,
): { ok: true } | { ok: false; message: string } {
  if (!config.callbackToken) {
    return { ok: true };
  }
  const timestamp = req.headers["x-timestamp"];
  const nonce = req.headers["x-nonce"];
  const signature = req.headers["x-signature"];
  if (typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
    return { ok: false, message: "missing signature headers" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return { ok: false, message: "expired timestamp" };
  }
  const payload = `${timestamp}\n${nonce}\n${body}`;
  const computed = crypto.createHmac("sha256", config.callbackToken).update(payload).digest("hex");
  const normalized = signature.replace(/^sha256=/i, "");
  if (!timingSafeEqualHex(computed, normalized)) {
    return { ok: false, message: "invalid signature" };
  }
  return { ok: true };
}

function verifyCiSignature(
  body: string,
  req: IncomingMessage,
  requestPath: string,
  config: LobsterReleaseConfig,
): { ok: true } | { ok: false; message: string } {
  if (!config.ciApiKey || !config.ciApiSecret) {
    return { ok: true };
  }
  const method = (req.method ?? "POST").toUpperCase();
  const key = req.headers["x-lobster-key"];
  const timestamp = req.headers["x-lobster-timestamp"];
  const nonce = req.headers["x-lobster-nonce"];
  const contentSha256 = req.headers["x-lobster-content-sha256"];
  const signature = req.headers["x-lobster-signature"];
  if (
    typeof key !== "string" ||
    typeof timestamp !== "string" ||
    typeof nonce !== "string" ||
    typeof contentSha256 !== "string" ||
    typeof signature !== "string"
  ) {
    return { ok: false, message: "missing X-Lobster-* headers" };
  }
  if (key !== config.ciApiKey) {
    return { ok: false, message: "invalid api key" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return { ok: false, message: "expired timestamp" };
  }
  const computedBodyHash = crypto.createHash("sha256").update(body).digest("hex");
  if (!timingSafeEqualHex(computedBodyHash, contentSha256)) {
    return { ok: false, message: "invalid body hash" };
  }
  const signingString = `${method}\n${requestPath}\n${timestamp}\n${nonce}\n${contentSha256}`;
  const computedSignature = crypto
    .createHmac("sha256", config.ciApiSecret)
    .update(signingString)
    .digest("hex");
  if (!timingSafeEqualHex(computedSignature, signature)) {
    return { ok: false, message: "invalid signature" };
  }
  return { ok: true };
}

export function createLobsterReleaseHttpHandler(params: {
  runtime: LobsterReleaseRuntime;
  config: LobsterReleaseConfig;
  logger: PluginLogger;
}) {
  const { runtime, config, logger } = params;
  const pluginPrefix = config.routePrefix;
  const ciPrefix = config.ciRoutePrefix;
  const callbackRateLimits = new Map<string, number[]>();

  const claimCallbackRateLimit = (key: string, nowMs = Date.now()): boolean => {
    const existing = callbackRateLimits.get(key) ?? [];
    const recent = existing.filter(
      (timestamp) => nowMs - timestamp < CALLBACK_RATE_LIMIT_WINDOW_MS,
    );
    if (recent.length >= CALLBACK_RATE_LIMIT_MAX_REQUESTS) {
      callbackRateLimits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    callbackRateLimits.set(key, recent);
    return true;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = getUrl(req);
    const originalPath = url.pathname;
    const isCiRoute = originalPath.startsWith(ciPrefix);
    const prefix = isCiRoute ? ciPrefix : pluginPrefix;
    const pathname = parseRoutePath(originalPath, prefix);
    const isSignedBuildCallback = !isCiRoute && isSignedBuildCallbackPath(pathname);
    const callbackProjectKey =
      /^\/projects\/([^/]+)/.exec(pathname)?.[1] ?? config.defaultProjectKey;
    const remoteAddress = req.socket.remoteAddress ?? "unknown";

    try {
      if (isCiRoute) {
        if (req.method !== "POST") {
          sendCiError(res, 405, "method not allowed");
          return true;
        }
        if (!claimCallbackRateLimit(`ci:${pathname}:${remoteAddress}`)) {
          res.setHeader("Retry-After", String(CALLBACK_RETRY_AFTER_SECONDS));
          sendCiError(res, 429, "callback rate limit exceeded", {
            retryable: true,
            retryAfterSeconds: CALLBACK_RETRY_AFTER_SECONDS,
          });
          return true;
        }
        const rawBody = await readRequestBodyWithLimit(req, {
          maxBytes: 2 * 1024 * 1024,
          timeoutMs: 15_000,
        });
        const verification = verifyCiSignature(rawBody, req, originalPath, config);
        if (!verification.ok) {
          sendCiError(res, 403, verification.message);
          return true;
        }
        let body: Record<string, unknown>;
        try {
          body = parseJsonObject(rawBody);
        } catch (error) {
          sendCiError(res, 400, error instanceof Error ? error.message : "invalid JSON body");
          return true;
        }
        const requestHash = sha256Hex(rawBody);
        const idempotencyKey = resolveCiIdempotencyKey(pathname, req.headers, body);
        if (!idempotencyKey) {
          sendCiError(res, 400, "missing idempotency key");
          return true;
        }
        const receiptScope = `ci:${pathname}`;
        const existingReceipt = await runtime.getIdempotencyReceiptAsync(
          receiptScope,
          idempotencyKey,
        );
        if (existingReceipt) {
          if (existingReceipt.requestHash !== requestHash) {
            sendCiError(res, 409, "idempotency key reused with different request body");
            return true;
          }
          sendJson(res, existingReceipt.statusCode, existingReceipt.responseBody);
          return true;
        }
        const nonce = readHeaderString(req.headers["x-lobster-nonce"]);
        if (!(nonce && (await runtime.claimCallbackNonceAsync(receiptScope, nonce, requestHash)))) {
          sendCiError(res, 409, "replayed nonce");
          return true;
        }

        if (pathname === "/builds/resolve-baseline") {
          const responseBody = ciEnvelope(
            await runtime.resolveCiBaselineAsync(body as CiBuildRequest),
          );
          await runtime.recordIdempotencyReceiptAsync(
            receiptScope,
            idempotencyKey,
            requestHash,
            200,
            responseBody,
          );
          sendJson(res, 200, responseBody);
          return true;
        }
        if (pathname === "/builds/start") {
          const build = await runtime.recordCiBuildStartAsync(body as CiBuildRequest);
          const responseBody = ciEnvelope({
            accepted: true,
            traceId: build.buildId,
            buildId: build.buildId,
            releaseId: build.releaseId,
          });
          await runtime.recordIdempotencyReceiptAsync(
            receiptScope,
            idempotencyKey,
            requestHash,
            200,
            responseBody,
          );
          sendJson(res, 200, responseBody);
          return true;
        }
        if (pathname === "/builds/publish") {
          const result = await runtime.recordCiBuildPublish(body as CiPublishRequest);
          const responseBody = ciEnvelope({
            accepted: true,
            traceId: result.build.buildId,
            buildId: result.build.buildId,
            releaseId: result.build.releaseId,
            manifestUrl:
              result.manifest.patch?.manifestUrl ??
              result.manifest.artifacts.find((item) => item.type === "manifest")?.downloadUrl ??
              null,
          });
          await runtime.recordIdempotencyReceiptAsync(
            receiptScope,
            idempotencyKey,
            requestHash,
            200,
            responseBody,
          );
          sendJson(res, 200, responseBody);
          return true;
        }
        if (pathname === "/builds/finish") {
          const result = await runtime.recordCiBuildFinish(body as CiFinishRequest);
          const responseBody = ciEnvelope({
            accepted: true,
            traceId: result.build.buildId,
            buildId: result.build.buildId,
            releaseId: result.release.releaseId,
            releaseStatus: result.release.status,
          });
          await runtime.recordIdempotencyReceiptAsync(
            receiptScope,
            idempotencyKey,
            requestHash,
            200,
            responseBody,
          );
          sendJson(res, 200, responseBody);
          return true;
        }
        return false;
      }

      if (req.method === "GET") {
        let match = matchPath(/^\/projects$/, pathname);
        if (match) {
          sendJson(res, 200, ok(runtime.getProjectCatalog()));
          return true;
        }
        match = matchPath(
          /^\/manifests\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/release_manifest\.json$/,
          pathname,
        );
        if (match) {
          const filePath = runtime.getManifestFilePath(
            match[1],
            match[2] as ReleaseEnvironment,
            match[3] as ReleaseChannel,
            match[4],
          );
          await sendFile(res, filePath);
          return true;
        }
        match = matchPath(/^\/uploads\/(.+)$/, pathname);
        if (match) {
          if (!config.uploadDestinationDir) {
            sendText(res, 404, "Not Found", "text/plain; charset=utf-8");
            return true;
          }
          const filePath = resolveSafeChildPath(config.uploadDestinationDir, match[1]);
          if (!filePath) {
            sendText(res, 400, "Bad Request", "text/plain; charset=utf-8");
            return true;
          }
          await sendFile(res, filePath);
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)$/, pathname);
        if (match) {
          const release = await runtime.getReleaseAsync(match[2]);
          if (!release || release.projectKey !== match[1]) {
            sendError(res, 404, "release.not_found", `release not found: ${match[2]}`);
            return true;
          }
          sendJson(res, 200, ok(release));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/versions\/suggest$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const channel =
            (url.searchParams.get("channel") as ReleaseChannel | null) ?? config.defaultChannel;
          const bumpType = url.searchParams.get("bumpType");
          if (bumpType !== "patch" && bumpType !== "minor" && bumpType !== "major") {
            sendError(res, 400, "request.invalid", "bumpType must be patch, minor, or major");
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              runtime.suggestVersion({
                projectKey: match[1],
                environment,
                channel,
                bumpType,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/builds\/([^/]+)$/, pathname);
        if (match) {
          const refreshJenkins = url.searchParams.get("refreshJenkins") === "true";
          sendJson(
            res,
            200,
            ok({
              ...(await runtime.getBuildStatusAsync(match[2])),
              jenkinsStatus: refreshJenkins ? await runtime.pollJenkinsBuildStatus(match[2]) : null,
            }),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/store\/status$/, pathname);
        if (match) {
          sendJson(res, 200, ok(await runtime.getStoreStatusAsync(match[1])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/policy$/, pathname);
        if (match) {
          sendJson(
            res,
            200,
            ok(
              runtime.getProjectCatalog().projects.find((item) => item.projectKey === match[1]) ??
                null,
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/preflight$/, pathname);
        if (match) {
          sendJson(res, 200, ok(await runtime.runReleasePreflightAsync(match[2])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/notes$/, pathname);
        if (match) {
          sendJson(res, 200, ok(await runtime.generateReleaseNotesAsync(match[2])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/current$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const state = await runtime.getChannelStateAsync(
            match[1],
            environment,
            match[2] as ReleaseChannel,
          );
          sendJson(res, 200, ok(state));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/stable$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const limitRaw = url.searchParams.get("limit");
          const limitValue = limitRaw ? Number(limitRaw) : Number.NaN;
          sendJson(
            res,
            200,
            ok(
              await runtime.listStableReleasesAsync({
                projectKey: match[1],
                environment,
                channel: match[2] as ReleaseChannel,
                limit: Number.isFinite(limitValue) ? limitValue : undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/promotions$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const limitRaw = url.searchParams.get("limit");
          const limitValue = limitRaw ? Number(limitRaw) : Number.NaN;
          sendJson(
            res,
            200,
            ok(
              await runtime.getPromotionHistoryAsync({
                projectKey: match[1],
                environment,
                channel: match[2] as ReleaseChannel,
                limit: Number.isFinite(limitValue) ? limitValue : undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/history$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const limitRaw = url.searchParams.get("limit");
          const limitValue = limitRaw ? Number(limitRaw) : Number.NaN;
          sendJson(
            res,
            200,
            ok(
              await runtime.getChannelHistoryAsync({
                projectKey: match[1],
                environment,
                channel: match[2] as ReleaseChannel,
                limit: Number.isFinite(limitValue) ? limitValue : undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/rollback-plan$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          sendJson(
            res,
            200,
            ok(
              await runtime.getRollbackPlanAsync({
                projectKey: match[1],
                environment,
                channel: match[2] as ReleaseChannel,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/gray-plan$/, pathname);
        if (match) {
          const environment = url.searchParams.get("environment") as ReleaseEnvironment | null;
          sendJson(
            res,
            200,
            ok(
              runtime.getGrayReleasePlan({
                projectKey: match[1],
                environment: environment ?? undefined,
                channel: match[2] as ReleaseChannel,
                region: url.searchParams.get("region") ?? undefined,
                audience: url.searchParams.get("audience") ?? undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/rollouts$/, pathname);
        if (match) {
          const environment = url.searchParams.get("environment") as ReleaseEnvironment | null;
          const limitValue = Number(url.searchParams.get("limit") ?? "");
          sendJson(
            res,
            200,
            ok(
              await runtime.listRolloutsAsync({
                projectKey: match[1],
                environment: environment ?? undefined,
                channel: match[2] as ReleaseChannel,
                limit: Number.isFinite(limitValue) ? limitValue : undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollouts\/([^/]+)$/, pathname);
        if (match) {
          sendJson(res, 200, ok(await runtime.getRolloutAsync(match[2])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollouts\/([^/]+)\/status$/, pathname);
        if (match) {
          sendJson(
            res,
            200,
            ok(
              await runtime.getRolloutStatusAsync({
                projectKey: match[1],
                rolloutId: match[2],
                publishRelease: url.searchParams.get("publishRelease") !== "false",
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/route$/, pathname);
        if (match) {
          const environment = url.searchParams.get("environment") as ReleaseEnvironment | null;
          const bucketValue = Number(url.searchParams.get("bucket") ?? "");
          sendJson(
            res,
            200,
            ok(
              await runtime.resolveChannelRouteAsync({
                projectKey: match[1],
                environment: environment ?? undefined,
                channel: match[2] as ReleaseChannel,
                region: url.searchParams.get("region") ?? undefined,
                audience: url.searchParams.get("audience") ?? undefined,
                subjectKey: url.searchParams.get("subjectKey") ?? undefined,
                bucketValue: Number.isFinite(bucketValue) ? bucketValue : undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/graph$/, pathname);
        if (match) {
          sendJson(res, 200, ok(await runtime.getReleaseGraphAsync(match[1], match[2])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/graph$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          sendJson(
            res,
            200,
            ok(
              await runtime.getChannelGraphAsync(match[1], environment, match[2] as ReleaseChannel),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/builds\/([^/]+)\/provenance$/, pathname);
        if (match) {
          sendJson(res, 200, ok(await runtime.getBuildProvenanceAsync(match[2])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/provenance$/, pathname);
        if (match) {
          const mode = url.searchParams.get("mode") === "all" ? "all" : "latest";
          sendJson(res, 200, ok(await runtime.getReleaseProvenanceAsync(match[2], mode)));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/baselines\/resolve$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const channel =
            (url.searchParams.get("channel") as ReleaseChannel | null) ?? config.defaultChannel;
          const targetVersion = url.searchParams.get("targetVersion");
          const platform = url.searchParams.get("platform") ?? "patch";
          if (!targetVersion) {
            sendError(res, 400, "request.invalid", "targetVersion is required");
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.resolveBaselineAsync({
                projectKey: match[1],
                environment,
                channel,
                targetVersion,
                platform,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/baselines$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const channel =
            (url.searchParams.get("channel") as ReleaseChannel | null) ?? config.defaultChannel;
          const platform = url.searchParams.get("platform") ?? "patch";
          const targetVersion = url.searchParams.get("targetVersion") ?? undefined;
          const limitValue = Number(url.searchParams.get("limit") ?? "");
          sendJson(
            res,
            200,
            ok(
              await runtime.listBaselinesAsync({
                projectKey: match[1],
                environment,
                channel,
                platform,
                targetVersion,
                limit: Number.isFinite(limitValue) ? limitValue : undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/baselines\/lineage$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const channel =
            (url.searchParams.get("channel") as ReleaseChannel | null) ?? config.defaultChannel;
          const platform = url.searchParams.get("platform") ?? "patch";
          const releaseId = url.searchParams.get("releaseId") ?? undefined;
          const version = url.searchParams.get("version") ?? undefined;
          sendJson(
            res,
            200,
            ok(
              await runtime.getBaselineLineageAsync({
                projectKey: match[1],
                environment,
                channel,
                platform,
                releaseId,
                version,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollbacks\/([^/]+)$/, pathname);
        if (match) {
          sendJson(res, 200, ok(await runtime.getRollbackAsync(match[2])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollbacks$/, pathname);
        if (match) {
          const environment = url.searchParams.get("environment") as ReleaseEnvironment | null;
          const channel = url.searchParams.get("channel") as ReleaseChannel | null;
          const limitValue = Number(url.searchParams.get("limit") ?? "");
          sendJson(
            res,
            200,
            ok(
              await runtime.getRollbackAuditAsync({
                projectKey: match[1],
                environment: environment ?? undefined,
                channel: channel ?? undefined,
                limit: Number.isFinite(limitValue) ? limitValue : undefined,
              }),
            ),
          );
          return true;
        }
      }

      if (req.method === "POST") {
        let match = matchPath(/^\/projects\/([^/]+)\/releases$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 1024 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          const result = await runtime.createRelease({
            projectKey: match[1],
            environment:
              (body.environment as ReleaseEnvironment | undefined) ?? config.defaultEnvironment,
            channel: (body.channel as ReleaseChannel | undefined) ?? config.defaultChannel,
            version: readString(body.version),
            git: body.git as CreateReleaseInput["git"],
            targets: normalizeBuildTargets(body.targets),
            scope:
              body.scope && typeof body.scope === "object"
                ? {
                    region:
                      typeof (body.scope as Record<string, unknown>).region === "string"
                        ? ((body.scope as Record<string, unknown>).region as string)
                        : undefined,
                    audience:
                      typeof (body.scope as Record<string, unknown>).audience === "string"
                        ? ((body.scope as Record<string, unknown>).audience as string)
                        : undefined,
                  }
                : undefined,
            notes: typeof body.notes === "string" ? body.notes : undefined,
            versionSource:
              typeof body.versionSource === "string"
                ? (body.versionSource as "manual" | "suggested" | "enforced")
                : undefined,
            triggerBuild: body.triggerBuild === true,
            createdBy: typeof body.createdBy === "string" ? body.createdBy : undefined,
          });
          sendJson(res, 200, ok(result));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/rollouts$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 256 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.createRollout({
                projectKey: match[1],
                environment:
                  (body.environment as ReleaseEnvironment | undefined) ?? config.defaultEnvironment,
                channel: match[2] as ReleaseChannel,
                releaseId: readString(body.releaseId),
                trafficPercent:
                  typeof body.trafficPercent === "number" ? body.trafficPercent : undefined,
                scope:
                  body.scope && typeof body.scope === "object"
                    ? {
                        region:
                          typeof (body.scope as Record<string, unknown>).region === "string"
                            ? ((body.scope as Record<string, unknown>).region as string)
                            : undefined,
                        audience:
                          typeof (body.scope as Record<string, unknown>).audience === "string"
                            ? ((body.scope as Record<string, unknown>).audience as string)
                            : undefined,
                      }
                    : undefined,
                notes: typeof body.notes === "string" ? body.notes : undefined,
                operator: typeof body.operator === "string" ? body.operator : "api",
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/trigger$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 1024 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          const result = await runtime.triggerRelease({
            projectKey: match[1],
            releaseId: match[2],
            operator: typeof body.operator === "string" ? body.operator : undefined,
            rebuild: body.rebuild === true,
          });
          sendJson(res, 200, ok(result));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/approve$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.approveRelease(
                match[2],
                typeof body.operator === "string" ? body.operator : "api",
              ),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/promote$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 256 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.promoteRelease({
                projectKey: match[1],
                sourceReleaseId: match[2],
                targetEnvironment:
                  (body.targetEnvironment as ReleaseEnvironment | undefined) ??
                  config.defaultEnvironment,
                targetChannel:
                  (body.targetChannel as ReleaseChannel | undefined) ?? config.defaultChannel,
                notes: typeof body.notes === "string" ? body.notes : undefined,
                operator: typeof body.operator === "string" ? body.operator : "api",
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/maintenance\/run$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.runMaintenance({
                projectKey: match[1],
                dryRun: body.dryRun !== false,
              }),
            ),
          );
          return true;
        }
        match = matchPath(
          /^\/projects\/([^/]+)\/builds\/([^/]+)\/(start|publish|finish)$/,
          pathname,
        );
        if (match) {
          if (!claimCallbackRateLimit(`signed:${pathname}:${remoteAddress}`)) {
            res.setHeader("Retry-After", String(CALLBACK_RETRY_AFTER_SECONDS));
            sendError(res, 429, "request.rate_limited", "callback rate limit exceeded", {
              retryable: true,
              retryAfterSeconds: CALLBACK_RETRY_AFTER_SECONDS,
            });
            return true;
          }
          const rawBody = await readRequestBodyWithLimit(req, {
            maxBytes: 1024 * 1024,
            timeoutMs: 10_000,
          });
          const verification = verifyCallbackSignature(rawBody, req, config);
          if (!verification.ok) {
            sendError(res, 403, "auth.invalid_signature", verification.message);
            return true;
          }
          let body: Record<string, unknown>;
          try {
            body = parseJsonObject(rawBody);
          } catch (error) {
            sendError(
              res,
              400,
              "request.invalid_json",
              error instanceof Error ? error.message : "invalid JSON body",
            );
            return true;
          }
          const requestHash = sha256Hex(rawBody);
          const action = match[3];
          const receiptScope = `signed-callback:${pathname}`;
          const idempotencyKey = resolveSignedCallbackIdempotencyKey(
            pathname,
            req.headers,
            body,
            requestHash,
          );
          const existingReceipt = await runtime.getIdempotencyReceiptAsync(
            receiptScope,
            idempotencyKey,
          );
          if (existingReceipt) {
            if (existingReceipt.requestHash !== requestHash) {
              sendError(
                res,
                409,
                "request.idempotency_conflict",
                "idempotency key reused with different request body",
              );
              return true;
            }
            sendJson(res, existingReceipt.statusCode, existingReceipt.responseBody);
            return true;
          }
          const nonce = readHeaderString(req.headers["x-nonce"]);
          if (
            !(nonce && (await runtime.claimCallbackNonceAsync(receiptScope, nonce, requestHash)))
          ) {
            sendError(res, 409, "auth.replayed_nonce", "replayed nonce");
            return true;
          }
          if (action === "start") {
            const responseBody = ok(
              await runtime.recordBuildStartAsync(match[2], {
                jenkinsJob: typeof body.jenkinsJob === "string" ? body.jenkinsJob : undefined,
                jenkinsBuildNumber:
                  typeof body.jenkinsBuildNumber === "number" ? body.jenkinsBuildNumber : undefined,
                jenkinsQueueId:
                  typeof body.jenkinsQueueId === "string" ? body.jenkinsQueueId : undefined,
                executorNode: typeof body.executorNode === "string" ? body.executorNode : undefined,
                executorLabel:
                  typeof body.executorLabel === "string" ? body.executorLabel : undefined,
                startedAt: typeof body.startedAt === "string" ? body.startedAt : undefined,
              }),
            );
            await runtime.recordIdempotencyReceiptAsync(
              receiptScope,
              idempotencyKey,
              requestHash,
              200,
              responseBody,
            );
            sendJson(res, 200, responseBody);
            return true;
          }
          if (action === "publish") {
            const responseBody = ok(
              await runtime.recordBuildPublish(match[2], {
                environment:
                  typeof body.environment === "string"
                    ? (body.environment as ReleaseEnvironment)
                    : undefined,
                channel:
                  typeof body.channel === "string" ? (body.channel as ReleaseChannel) : undefined,
                artifacts: Array.isArray(body.artifacts)
                  ? (body.artifacts as Array<Record<string, unknown>>).map((artifact) => ({
                      artifactType:
                        typeof artifact.artifactType === "string"
                          ? artifact.artifactType
                          : typeof artifact.type === "string"
                            ? artifact.type
                            : undefined,
                      type: typeof artifact.type === "string" ? artifact.type : undefined,
                      platform: readString(artifact.platform, "unknown"),
                      fileName: readString(artifact.fileName),
                      fileSizeBytes:
                        typeof artifact.fileSizeBytes === "number" ? artifact.fileSizeBytes : 0,
                      sha256: readString(artifact.sha256),
                      storageProvider: readString(artifact.storageProvider, "unknown"),
                      storageBucket:
                        typeof artifact.storageBucket === "string"
                          ? artifact.storageBucket
                          : undefined,
                      storagePath: readString(artifact.storagePath),
                      downloadUrl:
                        typeof artifact.downloadUrl === "string" ? artifact.downloadUrl : undefined,
                      manifestRole:
                        typeof artifact.manifestRole === "string"
                          ? artifact.manifestRole
                          : undefined,
                    }))
                  : [],
              }),
            );
            await runtime.recordIdempotencyReceiptAsync(
              receiptScope,
              idempotencyKey,
              requestHash,
              200,
              responseBody,
            );
            sendJson(res, 200, responseBody);
            return true;
          }
          const responseBody = ok(
            await runtime.recordBuildFinish(match[2], {
              status:
                body.status === "failed" || body.status === "canceled" ? body.status : "success",
              summary: typeof body.summary === "string" ? body.summary : undefined,
              durationSeconds:
                typeof body.durationSeconds === "number" ? body.durationSeconds : undefined,
              reports:
                body.reports && typeof body.reports === "object"
                  ? (body.reports as Record<string, unknown>)
                  : undefined,
              artifactsCount:
                typeof body.artifactsCount === "number" ? body.artifactsCount : undefined,
              error: body.error,
            }),
          );
          await runtime.recordIdempotencyReceiptAsync(
            receiptScope,
            idempotencyKey,
            requestHash,
            200,
            responseBody,
          );
          sendJson(res, 200, responseBody);
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/rollback$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 512 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          const result = await runtime.createRollback({
            projectKey: match[1],
            environment:
              (body.environment as ReleaseEnvironment | undefined) ?? config.defaultEnvironment,
            channel: match[2] as ReleaseChannel,
            targetReleaseId: readString(body.targetReleaseId),
            reason: readString(body.reason),
            strategy:
              (body.strategy as
                | "pointer_switch"
                | "manifest_republish"
                | "rebuild_and_publish"
                | undefined) ?? "pointer_switch",
            freezeCurrentRelease: body.freezeCurrentRelease !== false,
            operator: typeof body.operator === "string" ? body.operator : "api",
            comment: typeof body.comment === "string" ? body.comment : undefined,
          });
          sendJson(res, 200, ok(result));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollbacks\/([^/]+)\/approve$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.approveRollback(
                match[2],
                typeof body.approver === "string" ? body.approver : "api",
              ),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollbacks\/([^/]+)\/cancel$/, pathname);
        if (match) {
          sendJson(res, 200, ok(await runtime.cancelRollback(match[2])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollouts\/([^/]+)\/advance$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.advanceRollout({
                projectKey: match[1],
                rolloutId: match[2],
                trafficPercent: typeof body.trafficPercent === "number" ? body.trafficPercent : 100,
                operator: typeof body.operator === "string" ? body.operator : "api",
                complete: body.complete === true,
                publishRelease: body.publishRelease === true,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollouts\/([^/]+)\/cancel$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.cancelRollout({
                projectKey: match[1],
                rolloutId: match[2],
                operator: typeof body.operator === "string" ? body.operator : "api",
                reason: typeof body.reason === "string" ? body.reason : undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollouts\/([^/]+)\/observe$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.recordRolloutObservationAsync({
                projectKey: match[1],
                rolloutId: match[2],
                sampleSize: typeof body.sampleSize === "number" ? body.sampleSize : undefined,
                successCount: typeof body.successCount === "number" ? body.successCount : undefined,
                errorCount: typeof body.errorCount === "number" ? body.errorCount : undefined,
                crashCount: typeof body.crashCount === "number" ? body.crashCount : undefined,
                latencyP95Ms: typeof body.latencyP95Ms === "number" ? body.latencyP95Ms : undefined,
                source: typeof body.source === "string" ? body.source : undefined,
                notes: typeof body.notes === "string" ? body.notes : undefined,
                observedAt: typeof body.observedAt === "string" ? body.observedAt : undefined,
                operator: typeof body.operator === "string" ? body.operator : "api",
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollouts\/([^/]+)\/evaluate$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.evaluateRollout({
                projectKey: match[1],
                rolloutId: match[2],
                autoApply: body.autoApply === true,
                publishRelease: body.publishRelease !== false,
                operator: typeof body.operator === "string" ? body.operator : "api",
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollouts\/([^/]+)\/tick$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          const observation =
            body.observation && typeof body.observation === "object"
              ? (body.observation as Record<string, unknown>)
              : undefined;
          sendJson(
            res,
            200,
            ok(
              await runtime.tickRollout({
                projectKey: match[1],
                rolloutId: match[2],
                autoApply: body.autoApply === true,
                publishRelease: body.publishRelease !== false,
                operator: typeof body.operator === "string" ? body.operator : "api",
                observation: observation
                  ? {
                      sampleSize:
                        typeof observation.sampleSize === "number"
                          ? observation.sampleSize
                          : undefined,
                      successCount:
                        typeof observation.successCount === "number"
                          ? observation.successCount
                          : undefined,
                      errorCount:
                        typeof observation.errorCount === "number"
                          ? observation.errorCount
                          : undefined,
                      crashCount:
                        typeof observation.crashCount === "number"
                          ? observation.crashCount
                          : undefined,
                      latencyP95Ms:
                        typeof observation.latencyP95Ms === "number"
                          ? observation.latencyP95Ms
                          : undefined,
                      source:
                        typeof observation.source === "string" ? observation.source : undefined,
                      notes: typeof observation.notes === "string" ? observation.notes : undefined,
                      observedAt:
                        typeof observation.observedAt === "string"
                          ? observation.observedAt
                          : undefined,
                    }
                  : undefined,
              }),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/rollouts\/tick$/, pathname);
        if (match) {
          const body = await readJsonObjectBody(req, res, {
            maxBytes: 128 * 1024,
            timeoutMs: 10_000,
          });
          if (!body) {
            return true;
          }
          sendJson(
            res,
            200,
            ok(
              await runtime.tickAllRollouts({
                projectKey: match[1],
                environment:
                  (body.environment as ReleaseEnvironment | undefined) ?? config.defaultEnvironment,
                channel: match[2] as ReleaseChannel,
                autoApply: body.autoApply === true,
                publishRelease: body.publishRelease !== false,
                limit: typeof body.limit === "number" ? body.limit : undefined,
                operator: typeof body.operator === "string" ? body.operator : "api",
              }),
            ),
          );
          return true;
        }
      }
      return false;
    } catch (error) {
      logger.warn(`lobster-release http handler failed: ${String(error)}`);
      if (isCiRoute || isSignedBuildCallback) {
        runtime.recordSystemEvent({
          projectKey: callbackProjectKey,
          environment: config.defaultEnvironment,
          objectType: "callback",
          objectId: pathname,
          eventType: "callback.failed",
          payload: {
            route: pathname,
            originalPath,
            remoteAddress,
            isCiRoute,
            error: String(error),
          },
        });
      }
      if (isCiRoute) {
        res.setHeader("Retry-After", String(CALLBACK_RETRY_AFTER_SECONDS));
        sendCiError(res, 500, String(error), {
          retryable: true,
          retryAfterSeconds: CALLBACK_RETRY_AFTER_SECONDS,
        });
      } else {
        if (isSignedBuildCallback) {
          res.setHeader("Retry-After", String(CALLBACK_RETRY_AFTER_SECONDS));
          sendError(res, 500, "internal.error", String(error), {
            retryable: true,
            retryAfterSeconds: CALLBACK_RETRY_AFTER_SECONDS,
          });
        } else {
          sendError(res, 500, "internal.error", String(error));
        }
      }
      return true;
    }
  };
}
