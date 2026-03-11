import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk";
import { requireNodeSqlite } from "../../src/memory/sqlite.js";
import type { Mem0Memory } from "./memory.js";
import type {
  StepStatus,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowStatus,
  WorkflowStepRecord,
} from "./workflow-schema.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

export type StoredWorkflowRecord = WorkflowRecord & {
  startAt?: string;
  steps: WorkflowStepRecord[];
  resultSummary?: string;
  cancelReason?: string;
  planningMemories?: Array<Pick<Mem0Memory, "id" | "text" | "score">>;
  terminalMemoryState?: "pending" | "written" | "skipped";
  terminalMemoryKind?: "completed" | "failed";
  terminalMemoryText?: string;
  terminalMemoryError?: string;
  completionNoticeState?: "pending" | "sent" | "skipped";
  completionNoticeSentAt?: string;
  completionNoticeError?: string;
};

type LegacyOrchestratorState = {
  workflows: Record<string, StoredWorkflowRecord>;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeRecord(record: StoredWorkflowRecord): StoredWorkflowRecord {
  return {
    ...record,
    steps: [...record.steps],
  };
}

export class OrchestratorStore {
  private readonly dbPath: string;
  private readonly legacyJsonPath?: string;
  private db: SqliteDatabase | undefined;

  constructor(dbPath: string, legacyJsonPath?: string) {
    this.dbPath = dbPath;
    this.legacyJsonPath = legacyJsonPath;
  }

  async load(): Promise<void> {
    if (this.db) {
      return;
    }
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        requester_agent_id TEXT,
        requester_session_key TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflows_status_updated_idx
        ON workflows(status, updated_at DESC);
    `);
    await this.maybeImportLegacyJson();
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  async createWorkflow(input: {
    workflowId: string;
    definition: WorkflowDefinition;
    requesterAgentId?: string;
    requesterSessionKey?: string;
    startAt?: string;
  }): Promise<StoredWorkflowRecord> {
    await this.load();
    const createdAt = nowIso();
    const record: StoredWorkflowRecord = {
      workflowId: input.workflowId,
      definition: input.definition,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      requesterAgentId: input.requesterAgentId,
      requesterSessionKey: input.requesterSessionKey,
      startAt: input.startAt,
      steps: input.definition.steps.map((step) => ({
        workflowId: input.workflowId,
        stepId: step.id,
        status: "pending",
        attempt: 0,
        createdAt,
        updatedAt: createdAt,
      })),
    };
    this.writeRecord(record);
    return record;
  }

  async getWorkflow(workflowId: string): Promise<StoredWorkflowRecord | null> {
    await this.load();
    const row = this.getDb()
      .prepare("SELECT record_json FROM workflows WHERE workflow_id = ?")
      .get(workflowId) as { record_json?: string } | undefined;
    if (!row?.record_json) {
      return null;
    }
    return this.parseRecord(row.record_json);
  }

  async listWorkflows(params?: {
    status?: WorkflowStatus;
    limit?: number;
  }): Promise<StoredWorkflowRecord[]> {
    await this.load();
    const limit = params?.limit && Number.isFinite(params.limit) ? Math.max(1, params.limit) : 20;
    const rows = params?.status
      ? (this.getDb()
          .prepare(
            "SELECT record_json FROM workflows WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
          )
          .all(params.status, limit) as Array<{ record_json?: string }>)
      : (this.getDb()
          .prepare("SELECT record_json FROM workflows ORDER BY updated_at DESC LIMIT ?")
          .all(limit) as Array<{ record_json?: string }>);
    return rows
      .map((row) => (row.record_json ? this.parseRecord(row.record_json) : null))
      .filter((row): row is StoredWorkflowRecord => Boolean(row));
  }

  async updateWorkflow(
    workflowId: string,
    updater: (record: StoredWorkflowRecord) => StoredWorkflowRecord,
  ): Promise<StoredWorkflowRecord | null> {
    await this.load();
    const existing = await this.getWorkflow(workflowId);
    if (!existing) {
      return null;
    }
    const next = normalizeRecord(updater(existing));
    next.updatedAt = nowIso();
    this.writeRecord(next);
    return next;
  }

  async updateStep(
    workflowId: string,
    stepId: string,
    updater: (step: WorkflowStepRecord) => WorkflowStepRecord,
  ): Promise<StoredWorkflowRecord | null> {
    return await this.updateWorkflow(workflowId, (workflow) => {
      const nextSteps = workflow.steps.map((step) => {
        if (step.stepId !== stepId) {
          return step;
        }
        return {
          ...updater(step),
          updatedAt: nowIso(),
        };
      });
      return {
        ...workflow,
        steps: nextSteps,
      };
    });
  }

  async setWorkflowStatus(
    workflowId: string,
    status: WorkflowStatus,
    patch?: Partial<StoredWorkflowRecord>,
  ): Promise<StoredWorkflowRecord | null> {
    return await this.updateWorkflow(workflowId, (workflow) => ({
      ...workflow,
      ...patch,
      status,
    }));
  }

  async deleteWorkflow(workflowId: string): Promise<boolean> {
    await this.load();
    const result = this.getDb()
      .prepare("DELETE FROM workflows WHERE workflow_id = ?")
      .run(workflowId);
    return result.changes > 0;
  }

  findStepRecord(workflow: StoredWorkflowRecord, stepId: string): WorkflowStepRecord | undefined {
    return workflow.steps.find((step) => step.stepId === stepId);
  }

  getStepStatus(workflow: StoredWorkflowRecord, stepId: string): StepStatus | undefined {
    return this.findStepRecord(workflow, stepId)?.status;
  }

  private getDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error("orchestrator sqlite store is not loaded");
    }
    return this.db;
  }

  private writeRecord(record: StoredWorkflowRecord): void {
    const db = this.getDb();
    const serialized = JSON.stringify(record);
    db.prepare(
      `
        INSERT INTO workflows (
          workflow_id,
          status,
          created_at,
          updated_at,
          completed_at,
          requester_agent_id,
          requester_session_key,
          record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_id) DO UPDATE SET
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          requester_agent_id = excluded.requester_agent_id,
          requester_session_key = excluded.requester_session_key,
          record_json = excluded.record_json
      `,
    ).run(
      record.workflowId,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.completedAt ?? null,
      record.requesterAgentId ?? null,
      record.requesterSessionKey ?? null,
      serialized,
    );
  }

  private parseRecord(serialized: string): StoredWorkflowRecord | null {
    try {
      const parsed = JSON.parse(serialized) as StoredWorkflowRecord;
      if (!parsed || typeof parsed !== "object" || typeof parsed.workflowId !== "string") {
        return null;
      }
      return normalizeRecord(parsed);
    } catch {
      return null;
    }
  }

  private async maybeImportLegacyJson(): Promise<void> {
    if (!this.legacyJsonPath) {
      return;
    }
    const existingCount = this.getDb().prepare("SELECT COUNT(*) AS count FROM workflows").get() as
      | { count?: number }
      | undefined;
    if ((existingCount?.count ?? 0) > 0) {
      return;
    }
    const { value } = await readJsonFileWithFallback<LegacyOrchestratorState>(this.legacyJsonPath, {
      workflows: {},
    });
    const workflows = value?.workflows;
    if (!workflows || typeof workflows !== "object") {
      return;
    }
    for (const record of Object.values(workflows)) {
      if (!record?.workflowId) {
        continue;
      }
      this.writeRecord(record);
    }
  }
}
