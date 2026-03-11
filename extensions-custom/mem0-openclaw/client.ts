type MemoryScope = {
  userId?: string;
  runId?: string;
};

export type Mem0Memory = {
  id: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
  raw: Record<string, unknown>;
};

type Mem0ClientParams = {
  baseUrl: string;
  timeoutMs: number;
};

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

const HEALTH_PATHS = ["/health", "/docs", "/openapi.json"];

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getArrayCandidate(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = toRecord(payload);
  if (!record) {
    return [];
  }
  for (const key of ["results", "memories", "items", "data"]) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }
  return [];
}

function extractText(record: Record<string, unknown>): string {
  for (const key of ["memory", "text", "content"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key];
    }
  }
  const nestedMemory = toRecord(record.memory);
  if (nestedMemory) {
    return extractText(nestedMemory);
  }
  return JSON.stringify(record);
}

function extractId(record: Record<string, unknown>): string {
  for (const key of ["id", "memory_id", "memoryId", "uuid"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key];
    }
  }
  const nestedMemory = toRecord(record.memory);
  if (nestedMemory) {
    return extractId(nestedMemory);
  }
  return "";
}

function extractScore(record: Record<string, unknown>): number | undefined {
  for (const key of ["score", "similarity", "relevance"]) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) {
      return record[key];
    }
  }
  return undefined;
}

function normalizeMemories(payload: unknown): Mem0Memory[] {
  return getArrayCandidate(payload)
    .map((entry) => toRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((record) => ({
      id: extractId(record),
      text: extractText(record),
      score: extractScore(record),
      metadata: toRecord(record.metadata) ?? undefined,
      raw: record,
    }))
    .filter((entry) => entry.text.trim().length > 0);
}

function buildScopeQuery(scope: MemoryScope): Record<string, string | number | undefined> {
  return {
    user_id: scope.userId,
    run_id: scope.runId,
  };
}

export class Mem0Client {
  private readonly params: Mem0ClientParams;

  constructor(params: Mem0ClientParams) {
    this.params = params;
  }

  private async request(method: string, pathname: string, options: RequestOptions = {}) {
    const url = new URL(pathname, `${this.params.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.params.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: options.body ? { "content-type": "application/json" } : undefined,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(
            `Local Mem0 API ${method} ${pathname} timed out after ${this.params.timeoutMs}ms`,
            { cause: error },
          );
        }
        throw error;
      }
      const text = await response.text();
      const payload = text ? safeJsonParse(text) : null;
      if (!response.ok) {
        throw new Error(
          `Mem0 API ${method} ${pathname} failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
        );
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async probeHealth(): Promise<boolean> {
    for (const pathname of HEALTH_PATHS) {
      try {
        await this.request("GET", pathname);
        return true;
      } catch {
        // Try the next endpoint.
      }
    }
    return false;
  }

  async addMessages(params: {
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    userId?: string;
    runId?: string;
    infer?: boolean;
  }): Promise<unknown> {
    return this.request("POST", "/memories", {
      body: {
        messages: params.messages,
        user_id: params.userId,
        run_id: params.runId,
        infer: params.infer,
      },
    });
  }

  async search(params: {
    query: string;
    userId?: string;
    runId?: string;
    limit?: number;
  }): Promise<Mem0Memory[]> {
    try {
      const payload = await this.request("POST", "/search", {
        body: {
          query: params.query,
          limit: params.limit,
          user_id: params.userId,
          run_id: params.runId,
        },
      });
      return normalizeMemories(payload);
    } catch (firstError) {
      const payload = await this.request("GET", "/memories/search", {
        query: {
          query: params.query,
          limit: params.limit,
          ...buildScopeQuery(params),
        },
      }).catch(async () => {
        return this.request("POST", "/memories/search", {
          body: {
            query: params.query,
            limit: params.limit,
            user_id: params.userId,
            run_id: params.runId,
          },
        }).catch(() => {
          throw firstError;
        });
      });
      return normalizeMemories(payload);
    }
  }

  async list(params: { userId?: string; runId?: string; limit?: number }): Promise<Mem0Memory[]> {
    try {
      const payload = await this.request("GET", "/memories", {
        query: {
          limit: params.limit,
          ...buildScopeQuery(params),
        },
      });
      return normalizeMemories(payload);
    } catch (firstError) {
      const payload = await this.request("POST", "/v2/memories", {
        body: {
          filters: {
            user_id: params.userId,
            run_id: params.runId,
          },
          limit: params.limit,
        },
      }).catch(() => {
        throw firstError;
      });
      return normalizeMemories(payload);
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
