import { URL } from "node:url";

export type Mem0PluginConfig = {
  baseUrl: string;
  userId?: string;
  topK: number;
  requestTimeoutMs: number;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:8888";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TOP_K = 5;

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function parseInteger(value: unknown, fallback: number, label: string, min: number, max: number) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return normalized;
}

function parseBaseUrl(raw: unknown): string {
  const resolved = typeof raw === "string" ? resolveEnvVars(raw) : DEFAULT_BASE_URL;
  const url = new URL(resolved);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("baseUrl must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

export const mem0ConfigSchema = {
  parse(value: unknown): Mem0PluginConfig {
    const cfg = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const root = cfg as Record<string, unknown>;
    assertAllowedKeys(root, ["baseUrl", "userId", "topK", "requestTimeoutMs"], "mem0 config");

    return {
      baseUrl: parseBaseUrl(root.baseUrl),
      userId:
        typeof root.userId === "string" && root.userId.trim()
          ? resolveEnvVars(root.userId.trim())
          : undefined,
      topK: parseInteger(root.topK, DEFAULT_TOP_K, "topK", 1, 20),
      requestTimeoutMs: parseInteger(
        root.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        "requestTimeoutMs",
        1_000,
        300_000,
      ),
    };
  },
};
