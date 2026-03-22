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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
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

function sendCi(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, {
    code: 0,
    message: "ok",
    data,
  });
}

function sendCiError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    code: status,
    message,
    data: null,
  });
}

function ok(data: unknown) {
  return {
    ok: true,
    data,
  };
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
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

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = getUrl(req);
    const originalPath = url.pathname;
    const isCiRoute = originalPath.startsWith(ciPrefix);
    const prefix = isCiRoute ? ciPrefix : pluginPrefix;
    const pathname = parseRoutePath(originalPath, prefix);

    try {
      if (isCiRoute) {
        if (req.method !== "POST") {
          sendCiError(res, 405, "method not allowed");
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
        const body = JSON.parse(rawBody) as Record<string, unknown>;

        if (pathname === "/builds/resolve-baseline") {
          sendCi(res, runtime.resolveCiBaseline(body as CiBuildRequest));
          return true;
        }
        if (pathname === "/builds/start") {
          const build = runtime.recordCiBuildStart(body as CiBuildRequest);
          sendCi(res, {
            accepted: true,
            traceId: build.buildId,
            buildId: build.buildId,
            releaseId: build.releaseId,
          });
          return true;
        }
        if (pathname === "/builds/publish") {
          const result = await runtime.recordCiBuildPublish(body as CiPublishRequest);
          sendCi(res, {
            accepted: true,
            traceId: result.build.buildId,
            buildId: result.build.buildId,
            releaseId: result.build.releaseId,
            manifestUrl:
              result.manifest.patch?.manifestUrl ??
              result.manifest.artifacts.find((item) => item.type === "manifest")?.downloadUrl ??
              null,
          });
          return true;
        }
        if (pathname === "/builds/finish") {
          const result = await runtime.recordCiBuildFinish(body as CiFinishRequest);
          sendCi(res, {
            accepted: true,
            traceId: result.build.buildId,
            buildId: result.build.buildId,
            releaseId: result.release.releaseId,
            releaseStatus: result.release.status,
          });
          return true;
        }
        return false;
      }

      if (req.method === "GET") {
        let match = matchPath(
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
          const release = runtime.getRelease(match[2]);
          if (!release || release.projectKey !== match[1]) {
            sendError(res, 404, "release.not_found", `release not found: ${match[2]}`);
            return true;
          }
          sendJson(res, 200, ok(release));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/channels\/([^/]+)\/current$/, pathname);
        if (match) {
          const environment =
            (url.searchParams.get("environment") as ReleaseEnvironment | null) ??
            config.defaultEnvironment;
          const state = runtime.getChannelState(match[1], environment, match[2] as ReleaseChannel);
          sendJson(res, 200, ok(state));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/graph$/, pathname);
        if (match) {
          sendJson(res, 200, ok(runtime.getReleaseGraph(match[1], match[2])));
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
            ok(runtime.getChannelGraph(match[1], environment, match[2] as ReleaseChannel)),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/builds\/([^/]+)\/provenance$/, pathname);
        if (match) {
          sendJson(res, 200, ok(runtime.getBuildProvenance(match[2])));
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/releases\/([^/]+)\/provenance$/, pathname);
        if (match) {
          const mode = url.searchParams.get("mode") === "all" ? "all" : "latest";
          sendJson(res, 200, ok(runtime.getReleaseProvenance(match[2], mode)));
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
              runtime.resolveBaseline({
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
        match = matchPath(/^\/projects\/([^/]+)\/rollbacks\/([^/]+)$/, pathname);
        if (match) {
          sendJson(res, 200, ok(runtime.getRollback(match[2])));
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
            notes: typeof body.notes === "string" ? body.notes : undefined,
            triggerBuild: body.triggerBuild === true,
            createdBy: typeof body.createdBy === "string" ? body.createdBy : undefined,
          });
          sendJson(res, 200, ok(result));
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
        match = matchPath(
          /^\/projects\/([^/]+)\/builds\/([^/]+)\/(start|publish|finish)$/,
          pathname,
        );
        if (match) {
          const rawBody = await readRequestBodyWithLimit(req, {
            maxBytes: 1024 * 1024,
            timeoutMs: 10_000,
          });
          const verification = verifyCallbackSignature(rawBody, req, config);
          if (!verification.ok) {
            sendError(res, 403, "auth.invalid_signature", verification.message);
            return true;
          }
          const body = JSON.parse(rawBody) as Record<string, unknown>;
          const action = match[3];
          if (action === "start") {
            sendJson(
              res,
              200,
              ok(
                runtime.recordBuildStart(match[2], {
                  jenkinsJob: typeof body.jenkinsJob === "string" ? body.jenkinsJob : undefined,
                  jenkinsBuildNumber:
                    typeof body.jenkinsBuildNumber === "number"
                      ? body.jenkinsBuildNumber
                      : undefined,
                  jenkinsQueueId:
                    typeof body.jenkinsQueueId === "string" ? body.jenkinsQueueId : undefined,
                  executorNode:
                    typeof body.executorNode === "string" ? body.executorNode : undefined,
                  executorLabel:
                    typeof body.executorLabel === "string" ? body.executorLabel : undefined,
                  startedAt: typeof body.startedAt === "string" ? body.startedAt : undefined,
                }),
              ),
            );
            return true;
          }
          if (action === "publish") {
            sendJson(
              res,
              200,
              ok(
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
                          typeof artifact.downloadUrl === "string"
                            ? artifact.downloadUrl
                            : undefined,
                        manifestRole:
                          typeof artifact.manifestRole === "string"
                            ? artifact.manifestRole
                            : undefined,
                      }))
                    : [],
                }),
              ),
            );
            return true;
          }
          sendJson(
            res,
            200,
            ok(
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
            ),
          );
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
              runtime.approveRollback(
                match[2],
                typeof body.approver === "string" ? body.approver : "api",
              ),
            ),
          );
          return true;
        }
        match = matchPath(/^\/projects\/([^/]+)\/rollbacks\/([^/]+)\/cancel$/, pathname);
        if (match) {
          sendJson(res, 200, ok(runtime.cancelRollback(match[2])));
          return true;
        }
      }
      return false;
    } catch (error) {
      logger.warn(`lobster-release http handler failed: ${String(error)}`);
      if (isCiRoute) {
        sendCiError(res, 500, String(error));
      } else {
        sendError(res, 500, "internal.error", String(error));
      }
      return true;
    }
  };
}
