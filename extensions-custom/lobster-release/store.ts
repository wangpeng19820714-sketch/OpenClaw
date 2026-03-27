import fs from "node:fs/promises";
import path from "node:path";
import { requireNodeSqlite } from "../../src/memory/sqlite.js";
import type {
  ArtifactRecord,
  BaselineRecord,
  BuildProvenanceRecord,
  BuildRecord,
  ChannelStateRecord,
  EventLogRecord,
  NotificationOutboxRecord,
  OperationLockRecord,
  ProjectRecord,
  ReleaseRecord,
  ReleaseRelationRecord,
  RolloutRecord,
  RollbackOperationRecord,
} from "./types.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: string | undefined): T | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as T;
}

type JsonRow = { record_json?: string };
type PostgresRow = { record_json?: unknown };
type PostgresClient = {
  unsafe<T extends PostgresRow[] = PostgresRow[]>(
    query: string,
    params?: readonly unknown[],
  ): Promise<T>;
  begin<T>(cb: (sql: PostgresClient) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
};
type SchemaIdentifier = string;
export type CallbackNonceRecord = {
  nonceKey: string;
  scope: string;
  nonce: string;
  requestHash: string;
  createdAt: string;
  expiresAt: string;
};

export type IdempotencyReceiptRecord = {
  receiptKey: string;
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
  createdAt: string;
  updatedAt: string;
};

type SchemaMetaRecord = {
  metaKey: string;
  schemaVersion: number;
  updatedAt: string;
};

const STORE_SCHEMA_VERSION = 1;

export type StoreSchemaInfo = SchemaMetaRecord;
export type LobsterReleaseStoreDriver = "sqlite" | "postgres";
export type LobsterReleaseStoreOptions =
  | {
      driver?: "sqlite";
      sqlitePath: string;
    }
  | {
      driver: "postgres";
      connectionString: string;
      schema?: string;
    };

export interface LobsterReleaseStoreApi {
  load(): Promise<void>;
  close(): void;
  getSchemaInfo(): StoreSchemaInfo;
  upsertProject(record: ProjectRecord): void;
  upsertProjectAsync(record: ProjectRecord): Promise<void>;
  getProject(projectKey: string): ProjectRecord | null;
  getProjectAsync(projectKey: string): Promise<ProjectRecord | null>;
  upsertRelease(record: ReleaseRecord): void;
  upsertReleaseAsync(record: ReleaseRecord): Promise<void>;
  getRelease(releaseId: string): ReleaseRecord | null;
  getReleaseAsync(releaseId: string): Promise<ReleaseRecord | null>;
  listReleases(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    status?: string;
    stable?: boolean;
    limit?: number;
  }): ReleaseRecord[];
  listReleasesAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    status?: string;
    stable?: boolean;
    limit?: number;
  }): Promise<ReleaseRecord[]>;
  upsertBuild(record: BuildRecord): void;
  upsertBuildAsync(record: BuildRecord): Promise<void>;
  getBuild(buildId: string): BuildRecord | null;
  getBuildAsync(buildId: string): Promise<BuildRecord | null>;
  listBuildsForRelease(releaseId: string): BuildRecord[];
  listBuilds(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): BuildRecord[];
  listBuildsAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): Promise<BuildRecord[]>;
  insertArtifact(record: ArtifactRecord): void;
  insertArtifactAsync(record: ArtifactRecord): Promise<void>;
  listArtifactsForBuild(buildId: string): ArtifactRecord[];
  listArtifactsForBuildAsync(buildId: string): Promise<ArtifactRecord[]>;
  deleteArtifacts(artifactIds: string[]): number;
  deleteArtifactsAsync(artifactIds: string[]): Promise<number>;
  upsertChannelState(record: ChannelStateRecord): void;
  upsertChannelStateAsync(record: ChannelStateRecord): Promise<void>;
  getChannelState(
    projectKey: string,
    environment: string,
    channel: string,
  ): ChannelStateRecord | null;
  getChannelStateAsync(
    projectKey: string,
    environment: string,
    channel: string,
  ): Promise<ChannelStateRecord | null>;
  insertReleaseRelation(record: ReleaseRelationRecord): void;
  insertReleaseRelationAsync(record: ReleaseRelationRecord): Promise<void>;
  listReleaseRelations(projectKey: string, releaseId: string): ReleaseRelationRecord[];
  listReleaseRelationsAsync(
    projectKey: string,
    releaseId: string,
  ): Promise<ReleaseRelationRecord[]>;
  listReleaseRelationsByType(
    projectKey: string,
    relationType: string,
    limit?: number,
  ): ReleaseRelationRecord[];
  listReleaseRelationsByTypeAsync(
    projectKey: string,
    relationType: string,
    limit?: number,
  ): Promise<ReleaseRelationRecord[]>;
  upsertBuildProvenance(record: BuildProvenanceRecord): void;
  upsertBuildProvenanceAsync(record: BuildProvenanceRecord): Promise<void>;
  getBuildProvenance(buildId: string): BuildProvenanceRecord | null;
  getBuildProvenanceAsync(buildId: string): Promise<BuildProvenanceRecord | null>;
  listReleaseProvenance(releaseId: string): BuildProvenanceRecord[];
  listReleaseProvenanceAsync(releaseId: string): Promise<BuildProvenanceRecord[]>;
  upsertRollback(record: RollbackOperationRecord): void;
  upsertRollbackAsync(record: RollbackOperationRecord): Promise<void>;
  getRollback(rollbackId: string): RollbackOperationRecord | null;
  getRollbackAsync(rollbackId: string): Promise<RollbackOperationRecord | null>;
  listRollbacks(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): RollbackOperationRecord[];
  listRollbacksAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): Promise<RollbackOperationRecord[]>;
  upsertRollout(record: RolloutRecord): void;
  upsertRolloutAsync(record: RolloutRecord): Promise<void>;
  getRollout(rolloutId: string): RolloutRecord | null;
  getRolloutAsync(rolloutId: string): Promise<RolloutRecord | null>;
  listRollouts(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    releaseId?: string;
    statuses?: RolloutRecord["status"][];
    limit?: number;
  }): RolloutRecord[];
  listRolloutsAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    releaseId?: string;
    statuses?: RolloutRecord["status"][];
    limit?: number;
  }): Promise<RolloutRecord[]>;
  insertEvent(record: EventLogRecord): void;
  insertEventAsync(record: EventLogRecord): Promise<void>;
  listEvents(params: {
    projectKey: string;
    objectType?: string;
    objectId?: string;
    eventType?: string;
    eventTypePrefix?: string;
    limit?: number;
  }): EventLogRecord[];
  listEventsAsync(params: {
    projectKey: string;
    objectType?: string;
    objectId?: string;
    eventType?: string;
    eventTypePrefix?: string;
    limit?: number;
  }): Promise<EventLogRecord[]>;
  getIdempotencyReceipt(scope: string, idempotencyKey: string): IdempotencyReceiptRecord | null;
  getIdempotencyReceiptAsync(
    scope: string,
    idempotencyKey: string,
  ): Promise<IdempotencyReceiptRecord | null>;
  upsertIdempotencyReceipt(record: IdempotencyReceiptRecord): void;
  upsertIdempotencyReceiptAsync(record: IdempotencyReceiptRecord): Promise<void>;
  purgeExpiredCallbackNonces(now?: string): void;
  purgeExpiredCallbackNoncesAsync(now?: string): Promise<void>;
  purgeIdempotencyReceipts(before: string): number;
  claimCallbackNonce(record: CallbackNonceRecord): boolean;
  claimCallbackNonceAsync(record: CallbackNonceRecord): Promise<boolean>;
  insertNotification(record: NotificationOutboxRecord): void;
  insertNotificationAsync(record: NotificationOutboxRecord): Promise<NotificationOutboxRecord>;
  upsertNotification(record: NotificationOutboxRecord): void;
  upsertNotificationAsync(record: NotificationOutboxRecord): Promise<void>;
  getNotification(notificationId: string): NotificationOutboxRecord | null;
  getNotificationAsync(notificationId: string): Promise<NotificationOutboxRecord | null>;
  getNotificationByDedupeKey(
    deliveryChannel: NotificationOutboxRecord["deliveryChannel"],
    dedupeKey: string,
  ): NotificationOutboxRecord | null;
  getNotificationByDedupeKeyAsync(
    deliveryChannel: NotificationOutboxRecord["deliveryChannel"],
    dedupeKey: string,
  ): Promise<NotificationOutboxRecord | null>;
  listNotifications(params?: {
    deliveryChannel?: NotificationOutboxRecord["deliveryChannel"];
    statuses?: NotificationOutboxRecord["status"][];
    limit?: number;
  }): NotificationOutboxRecord[];
  listNotificationsAsync(params?: {
    deliveryChannel?: NotificationOutboxRecord["deliveryChannel"];
    statuses?: NotificationOutboxRecord["status"][];
    limit?: number;
  }): Promise<NotificationOutboxRecord[]>;
  purgeNotifications(params: {
    before: string;
    statuses?: NotificationOutboxRecord["status"][];
  }): number;
  purgeNotificationsAsync(params: {
    before: string;
    statuses?: NotificationOutboxRecord["status"][];
  }): Promise<number>;
  upsertBaseline(record: BaselineRecord): void;
  upsertBaselineAsync(record: BaselineRecord): Promise<void>;
  listBaselines(params: {
    projectKey: string;
    environment: string;
    channel: string;
    platform: string;
  }): BaselineRecord[];
  listBaselinesAsync(params: {
    projectKey: string;
    environment: string;
    channel: string;
    platform: string;
  }): Promise<BaselineRecord[]>;
  purgeEvents(before: string): number;
  purgeEventsAsync(before: string): Promise<number>;
  purgeIdempotencyReceiptsAsync(before: string): Promise<number>;
  acquireLock(record: OperationLockRecord): { ok: true } | { ok: false; lock: OperationLockRecord };
  acquireLockAsync(
    record: OperationLockRecord,
  ): Promise<{ ok: true } | { ok: false; lock: OperationLockRecord }>;
  releaseLock(lockKey: string): void;
  releaseLockAsync(lockKey: string): Promise<void>;
  purgeExpiredLocks(): void;
  purgeExpiredLocksAsync(): Promise<void>;
}

function quoteSchemaIdentifier(value: string): SchemaIdentifier {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid PostgreSQL schema identifier: ${value}`);
  }
  return `"${value}"`;
}

function parsePostgresJson<T>(value: unknown): T | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export class LobsterReleaseStore implements LobsterReleaseStoreApi {
  private readonly dbPath: string;
  private db: SqliteDatabase | undefined;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
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

      CREATE TABLE IF NOT EXISTS schema_meta (
        meta_key TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_key TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS releases (
        release_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        environment TEXT NOT NULL,
        channel TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        stable INTEGER NOT NULL,
        frozen INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS releases_project_env_channel_version_uq
        ON releases(project_key, environment, channel, version);
      CREATE INDEX IF NOT EXISTS releases_project_env_channel_updated_idx
        ON releases(project_key, environment, channel, updated_at DESC);

      CREATE TABLE IF NOT EXISTS builds (
        build_id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        environment TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS builds_release_idx
        ON builds(release_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        build_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_build_idx
        ON artifacts(build_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS channel_state (
        state_key TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        environment TEXT NOT NULL,
        channel TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS release_relations (
        relation_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        from_release_id TEXT NOT NULL,
        to_release_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS release_relations_from_idx
        ON release_relations(project_key, from_release_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS release_relations_to_idx
        ON release_relations(project_key, to_release_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS build_provenance (
        build_id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        provenance_hash TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rollback_operations (
        rollback_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        environment TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rollouts (
        rollout_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        environment TEXT NOT NULL,
        channel TEXT NOT NULL,
        release_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rollouts_project_env_channel_idx
        ON rollouts(project_key, environment, channel, updated_at DESC);
      CREATE INDEX IF NOT EXISTS rollouts_release_idx
        ON rollouts(release_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS operation_locks (
        lock_key TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        environment TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_logs (
        event_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS callback_nonces (
        nonce_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_receipts (
        receipt_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_outbox (
        notification_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        project_key TEXT NOT NULL,
        delivery_channel TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedupe_uq
        ON notification_outbox(delivery_channel, dedupe_key);
      CREATE INDEX IF NOT EXISTS notification_outbox_status_idx
        ON notification_outbox(status, updated_at ASC);

      CREATE TABLE IF NOT EXISTS patch_baselines (
        baseline_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        environment TEXT NOT NULL,
        channel TEXT NOT NULL,
        platform TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
    `);
    this.setSchemaMeta({
      metaKey: "store_schema_version",
      schemaVersion: STORE_SCHEMA_VERSION,
      updatedAt: nowIso(),
    });
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private getDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error("lobster-release store is not loaded");
    }
    return this.db;
  }

  private setSchemaMeta(record: SchemaMetaRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO schema_meta (meta_key, record_json)
         VALUES (?, ?)
         ON CONFLICT(meta_key) DO UPDATE SET
           record_json = excluded.record_json`,
      )
      .run(record.metaKey, JSON.stringify(record));
  }

  getSchemaInfo(): SchemaMetaRecord {
    const row = this.getDb()
      .prepare("SELECT record_json FROM schema_meta WHERE meta_key = ?")
      .get("store_schema_version") as JsonRow | undefined;
    return (
      parseJson<SchemaMetaRecord>(row?.record_json) ?? {
        metaKey: "store_schema_version",
        schemaVersion: STORE_SCHEMA_VERSION,
        updatedAt: nowIso(),
      }
    );
  }

  upsertProject(record: ProjectRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO projects (project_key, updated_at, record_json)
         VALUES (?, ?, ?)
         ON CONFLICT(project_key) DO UPDATE SET
           updated_at = excluded.updated_at,
           record_json = excluded.record_json`,
      )
      .run(record.projectKey, record.updatedAt, JSON.stringify(record));
  }

  async upsertProjectAsync(record: ProjectRecord): Promise<void> {
    this.upsertProject(record);
  }

  getProject(projectKey: string): ProjectRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM projects WHERE project_key = ?")
      .get(projectKey) as JsonRow | undefined;
    return parseJson<ProjectRecord>(row?.record_json);
  }

  async getProjectAsync(projectKey: string): Promise<ProjectRecord | null> {
    return this.getProject(projectKey);
  }

  upsertRelease(record: ReleaseRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO releases (
            release_id, project_key, environment, channel, version, status, stable, frozen, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(release_id) DO UPDATE SET
            status = excluded.status,
            stable = excluded.stable,
            frozen = excluded.frozen,
            updated_at = excluded.updated_at,
            record_json = excluded.record_json`,
      )
      .run(
        record.releaseId,
        record.projectKey,
        record.environment,
        record.channel,
        record.version,
        record.status,
        record.stable ? 1 : 0,
        record.frozen ? 1 : 0,
        record.updatedAt,
        JSON.stringify(record),
      );
  }

  async upsertReleaseAsync(record: ReleaseRecord): Promise<void> {
    this.upsertRelease(record);
  }

  getRelease(releaseId: string): ReleaseRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM releases WHERE release_id = ?")
      .get(releaseId) as JsonRow | undefined;
    return parseJson<ReleaseRecord>(row?.record_json);
  }

  async getReleaseAsync(releaseId: string): Promise<ReleaseRecord | null> {
    return this.getRelease(releaseId);
  }

  listReleases(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
  }): ReleaseRecord[] {
    const rows =
      params.environment && params.channel
        ? (this.getDb()
            .prepare(
              `SELECT record_json FROM releases
               WHERE project_key = ? AND environment = ? AND channel = ?
               ORDER BY updated_at DESC`,
            )
            .all(params.projectKey, params.environment, params.channel) as JsonRow[])
        : (this.getDb()
            .prepare(
              `SELECT record_json FROM releases WHERE project_key = ? ORDER BY updated_at DESC`,
            )
            .all(params.projectKey) as JsonRow[]);
    return rows
      .map((row) => parseJson<ReleaseRecord>(row.record_json))
      .filter((row): row is ReleaseRecord => Boolean(row));
  }

  async listReleasesAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    status?: string;
    stable?: boolean;
    limit?: number;
  }): Promise<ReleaseRecord[]> {
    return this.listReleases(params);
  }

  upsertBuild(record: BuildRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO builds (
            build_id, release_id, project_key, environment, channel, status, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(build_id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            record_json = excluded.record_json`,
      )
      .run(
        record.buildId,
        record.releaseId,
        record.projectKey,
        record.environment,
        record.channel,
        record.status,
        record.updatedAt,
        JSON.stringify(record),
      );
  }

  async upsertBuildAsync(record: BuildRecord): Promise<void> {
    this.upsertBuild(record);
  }

  getBuild(buildId: string): BuildRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM builds WHERE build_id = ?")
      .get(buildId) as JsonRow | undefined;
    return parseJson<BuildRecord>(row?.record_json);
  }

  async getBuildAsync(buildId: string): Promise<BuildRecord | null> {
    return this.getBuild(buildId);
  }

  listBuildsForRelease(releaseId: string): BuildRecord[] {
    const rows = this.getDb()
      .prepare("SELECT record_json FROM builds WHERE release_id = ? ORDER BY updated_at DESC")
      .all(releaseId) as JsonRow[];
    return rows
      .map((row) => parseJson<BuildRecord>(row.record_json))
      .filter((row): row is BuildRecord => Boolean(row));
  }

  listBuilds(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
  }): BuildRecord[] {
    const rows =
      params.environment && params.channel
        ? (this.getDb()
            .prepare(
              `SELECT record_json FROM builds
               WHERE project_key = ? AND environment = ? AND channel = ?
               ORDER BY updated_at DESC`,
            )
            .all(params.projectKey, params.environment, params.channel) as JsonRow[])
        : (this.getDb()
            .prepare(
              `SELECT record_json FROM builds WHERE project_key = ? ORDER BY updated_at DESC`,
            )
            .all(params.projectKey) as JsonRow[]);
    return rows
      .map((row) => parseJson<BuildRecord>(row.record_json))
      .filter((row): row is BuildRecord => Boolean(row));
  }

  async listBuildsAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): Promise<BuildRecord[]> {
    return this.listBuilds(params);
  }

  insertArtifact(record: ArtifactRecord): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO artifacts (
            artifact_id, build_id, release_id, project_key, artifact_type, created_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.artifactId,
        record.buildId,
        record.releaseId,
        record.projectKey,
        record.artifactType,
        record.createdAt,
        JSON.stringify(record),
      );
  }

  async insertArtifactAsync(record: ArtifactRecord): Promise<void> {
    this.insertArtifact(record);
  }

  listArtifactsForBuild(buildId: string): ArtifactRecord[] {
    const rows = this.getDb()
      .prepare("SELECT record_json FROM artifacts WHERE build_id = ? ORDER BY created_at ASC")
      .all(buildId) as JsonRow[];
    return rows
      .map((row) => parseJson<ArtifactRecord>(row.record_json))
      .filter((row): row is ArtifactRecord => Boolean(row));
  }

  async listArtifactsForBuildAsync(buildId: string): Promise<ArtifactRecord[]> {
    return this.listArtifactsForBuild(buildId);
  }

  deleteArtifacts(artifactIds: string[]): number {
    if (artifactIds.length === 0) {
      return 0;
    }
    const placeholders = artifactIds.map(() => "?").join(", ");
    const result = this.getDb()
      .prepare(`DELETE FROM artifacts WHERE artifact_id IN (${placeholders})`)
      .run(...artifactIds);
    return Number(result.changes ?? 0);
  }

  async deleteArtifactsAsync(artifactIds: string[]): Promise<number> {
    return this.deleteArtifacts(artifactIds);
  }

  upsertChannelState(record: ChannelStateRecord): void {
    const stateKey = `${record.projectKey}:${record.environment}:${record.channel}`;
    this.getDb()
      .prepare(
        `INSERT INTO channel_state (
            state_key, project_key, environment, channel, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(state_key) DO UPDATE SET
            updated_at = excluded.updated_at,
            record_json = excluded.record_json`,
      )
      .run(
        stateKey,
        record.projectKey,
        record.environment,
        record.channel,
        record.updatedAt,
        JSON.stringify(record),
      );
  }

  async upsertChannelStateAsync(record: ChannelStateRecord): Promise<void> {
    this.upsertChannelState(record);
  }

  getChannelState(
    projectKey: string,
    environment: string,
    channel: string,
  ): ChannelStateRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM channel_state WHERE state_key = ?")
      .get(`${projectKey}:${environment}:${channel}`) as JsonRow | undefined;
    return parseJson<ChannelStateRecord>(row?.record_json);
  }

  async getChannelStateAsync(
    projectKey: string,
    environment: string,
    channel: string,
  ): Promise<ChannelStateRecord | null> {
    return this.getChannelState(projectKey, environment, channel);
  }

  insertReleaseRelation(record: ReleaseRelationRecord): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO release_relations (
            relation_id, project_key, from_release_id, to_release_id, relation_type, created_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.relationId,
        record.projectKey,
        record.fromReleaseId,
        record.toReleaseId,
        record.relationType,
        record.createdAt,
        JSON.stringify(record),
      );
  }

  async insertReleaseRelationAsync(record: ReleaseRelationRecord): Promise<void> {
    this.insertReleaseRelation(record);
  }

  listReleaseRelations(projectKey: string, releaseId: string): ReleaseRelationRecord[] {
    const rows = this.getDb()
      .prepare(
        `SELECT record_json FROM release_relations
         WHERE project_key = ? AND (from_release_id = ? OR to_release_id = ?)
         ORDER BY created_at ASC`,
      )
      .all(projectKey, releaseId, releaseId) as JsonRow[];
    return rows
      .map((row) => parseJson<ReleaseRelationRecord>(row.record_json))
      .filter((row): row is ReleaseRelationRecord => Boolean(row));
  }

  async listReleaseRelationsAsync(
    projectKey: string,
    releaseId: string,
  ): Promise<ReleaseRelationRecord[]> {
    return this.listReleaseRelations(projectKey, releaseId);
  }

  listReleaseRelationsByType(
    projectKey: string,
    relationType: ReleaseRelationRecord["relationType"],
    limit?: number,
  ): ReleaseRelationRecord[] {
    const values: Array<number | string> = [projectKey, relationType];
    let query = `SELECT record_json FROM release_relations WHERE project_key = ? AND relation_type = ? ORDER BY created_at DESC`;
    if (limit && limit > 0) {
      query += " LIMIT ?";
      values.push(limit);
    }
    const rows = this.getDb()
      .prepare(query)
      .all(...values) as JsonRow[];
    return rows
      .map((row) => parseJson<ReleaseRelationRecord>(row.record_json))
      .filter((row): row is ReleaseRelationRecord => Boolean(row));
  }

  async listReleaseRelationsByTypeAsync(
    projectKey: string,
    relationType: ReleaseRelationRecord["relationType"],
    limit?: number,
  ): Promise<ReleaseRelationRecord[]> {
    return this.listReleaseRelationsByType(projectKey, relationType, limit);
  }

  upsertBuildProvenance(record: BuildProvenanceRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO build_provenance (
            build_id, release_id, project_key, captured_at, provenance_hash, record_json
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(build_id) DO UPDATE SET
            captured_at = excluded.captured_at,
            provenance_hash = excluded.provenance_hash,
            record_json = excluded.record_json`,
      )
      .run(
        record.buildId,
        record.releaseId,
        record.projectKey,
        record.capturedAt,
        record.provenanceHash,
        JSON.stringify(record),
      );
  }

  async upsertBuildProvenanceAsync(record: BuildProvenanceRecord): Promise<void> {
    this.upsertBuildProvenance(record);
  }

  getBuildProvenance(buildId: string): BuildProvenanceRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM build_provenance WHERE build_id = ?")
      .get(buildId) as JsonRow | undefined;
    return parseJson<BuildProvenanceRecord>(row?.record_json);
  }

  async getBuildProvenanceAsync(buildId: string): Promise<BuildProvenanceRecord | null> {
    return this.getBuildProvenance(buildId);
  }

  listReleaseProvenance(releaseId: string): BuildProvenanceRecord[] {
    const rows = this.getDb()
      .prepare(
        "SELECT record_json FROM build_provenance WHERE release_id = ? ORDER BY captured_at DESC",
      )
      .all(releaseId) as JsonRow[];
    return rows
      .map((row) => parseJson<BuildProvenanceRecord>(row.record_json))
      .filter((row): row is BuildProvenanceRecord => Boolean(row));
  }

  async listReleaseProvenanceAsync(releaseId: string): Promise<BuildProvenanceRecord[]> {
    return this.listReleaseProvenance(releaseId);
  }

  upsertRollback(record: RollbackOperationRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO rollback_operations (
            rollback_id, project_key, environment, channel, status, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(rollback_id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            record_json = excluded.record_json`,
      )
      .run(
        record.rollbackId,
        record.projectKey,
        record.environment,
        record.channel,
        record.status,
        record.completedAt ?? record.createdAt,
        JSON.stringify(record),
      );
  }

  async upsertRollbackAsync(record: RollbackOperationRecord): Promise<void> {
    this.upsertRollback(record);
  }

  getRollback(rollbackId: string): RollbackOperationRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM rollback_operations WHERE rollback_id = ?")
      .get(rollbackId) as JsonRow | undefined;
    return parseJson<RollbackOperationRecord>(row?.record_json);
  }

  async getRollbackAsync(rollbackId: string): Promise<RollbackOperationRecord | null> {
    return this.getRollback(rollbackId);
  }

  listRollbacks(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): RollbackOperationRecord[] {
    const clauses = ["project_key = ?"];
    const values: Array<number | string> = [params.projectKey];
    if (params.environment) {
      clauses.push("environment = ?");
      values.push(params.environment);
    }
    if (params.channel) {
      clauses.push("channel = ?");
      values.push(params.channel);
    }
    let query = `SELECT record_json FROM rollback_operations WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`;
    if (params.limit && params.limit > 0) {
      query += " LIMIT ?";
      values.push(params.limit);
    }
    const rows = this.getDb()
      .prepare(query)
      .all(...values) as JsonRow[];
    return rows
      .map((row) => parseJson<RollbackOperationRecord>(row.record_json))
      .filter((row): row is RollbackOperationRecord => Boolean(row));
  }

  async listRollbacksAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): Promise<RollbackOperationRecord[]> {
    return this.listRollbacks(params);
  }

  upsertRollout(record: RolloutRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO rollouts (
            rollout_id, project_key, environment, channel, release_id, status, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(rollout_id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            record_json = excluded.record_json`,
      )
      .run(
        record.rolloutId,
        record.projectKey,
        record.environment,
        record.channel,
        record.releaseId,
        record.status,
        record.updatedAt,
        JSON.stringify(record),
      );
  }

  async upsertRolloutAsync(record: RolloutRecord): Promise<void> {
    this.upsertRollout(record);
  }

  getRollout(rolloutId: string): RolloutRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM rollouts WHERE rollout_id = ?")
      .get(rolloutId) as JsonRow | undefined;
    return parseJson<RolloutRecord>(row?.record_json);
  }

  async getRolloutAsync(rolloutId: string): Promise<RolloutRecord | null> {
    return this.getRollout(rolloutId);
  }

  listRollouts(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    releaseId?: string;
    statuses?: RolloutRecord["status"][];
    limit?: number;
  }): RolloutRecord[] {
    const clauses = ["project_key = ?"];
    const values: Array<number | string> = [params.projectKey];
    if (params.environment) {
      clauses.push("environment = ?");
      values.push(params.environment);
    }
    if (params.channel) {
      clauses.push("channel = ?");
      values.push(params.channel);
    }
    if (params.releaseId) {
      clauses.push("release_id = ?");
      values.push(params.releaseId);
    }
    if (params.statuses?.length) {
      clauses.push(`status IN (${params.statuses.map(() => "?").join(", ")})`);
      values.push(...params.statuses);
    }
    let query = `SELECT record_json FROM rollouts WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`;
    if (params.limit && params.limit > 0) {
      query += " LIMIT ?";
      values.push(params.limit);
    }
    const rows = this.getDb()
      .prepare(query)
      .all(...values) as JsonRow[];
    return rows
      .map((row) => parseJson<RolloutRecord>(row.record_json))
      .filter((row): row is RolloutRecord => Boolean(row));
  }

  async listRolloutsAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    releaseId?: string;
    statuses?: RolloutRecord["status"][];
    limit?: number;
  }): Promise<RolloutRecord[]> {
    return this.listRollouts(params);
  }

  insertEvent(record: EventLogRecord): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO event_logs (
            event_id, project_key, object_type, object_id, event_type, created_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.eventId,
        record.projectKey,
        record.objectType,
        record.objectId,
        record.eventType,
        record.createdAt,
        JSON.stringify(record),
      );
  }

  async insertEventAsync(record: EventLogRecord): Promise<void> {
    this.insertEvent(record);
  }

  listEvents(params: {
    projectKey: string;
    objectType?: string;
    objectId?: string;
    eventType?: string;
    eventTypePrefix?: string;
    limit?: number;
  }): EventLogRecord[] {
    const clauses = ["project_key = ?"];
    const values: Array<number | string> = [params.projectKey];
    if (params.objectType) {
      clauses.push("object_type = ?");
      values.push(params.objectType);
    }
    if (params.objectId) {
      clauses.push("object_id = ?");
      values.push(params.objectId);
    }
    if (params.eventType) {
      clauses.push("event_type = ?");
      values.push(params.eventType);
    } else if (params.eventTypePrefix) {
      clauses.push("event_type LIKE ?");
      values.push(`${params.eventTypePrefix}%`);
    }
    let query = `SELECT record_json FROM event_logs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`;
    if (params.limit && params.limit > 0) {
      query += " LIMIT ?";
      values.push(params.limit);
    }
    const rows = this.getDb()
      .prepare(query)
      .all(...values) as JsonRow[];
    return rows
      .map((row) => parseJson<EventLogRecord>(row.record_json))
      .filter((row): row is EventLogRecord => Boolean(row));
  }

  async listEventsAsync(params: {
    projectKey: string;
    objectType?: string;
    objectId?: string;
    eventType?: string;
    eventTypePrefix?: string;
    limit?: number;
  }): Promise<EventLogRecord[]> {
    return this.listEvents(params);
  }

  getIdempotencyReceipt(scope: string, idempotencyKey: string): IdempotencyReceiptRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM idempotency_receipts WHERE receipt_key = ?")
      .get(`${scope}:${idempotencyKey}`) as JsonRow | undefined;
    return parseJson<IdempotencyReceiptRecord>(row?.record_json);
  }

  async getIdempotencyReceiptAsync(
    scope: string,
    idempotencyKey: string,
  ): Promise<IdempotencyReceiptRecord | null> {
    return this.getIdempotencyReceipt(scope, idempotencyKey);
  }

  upsertIdempotencyReceipt(record: IdempotencyReceiptRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO idempotency_receipts (
            receipt_key, scope, created_at, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(receipt_key) DO UPDATE SET
            updated_at = excluded.updated_at,
            record_json = excluded.record_json`,
      )
      .run(
        record.receiptKey,
        record.scope,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record),
      );
  }

  async upsertIdempotencyReceiptAsync(record: IdempotencyReceiptRecord): Promise<void> {
    this.upsertIdempotencyReceipt(record);
  }

  purgeExpiredCallbackNonces(now = nowIso()): void {
    this.getDb().prepare("DELETE FROM callback_nonces WHERE expires_at <= ?").run(now);
  }

  async purgeExpiredCallbackNoncesAsync(now = nowIso()): Promise<void> {
    this.purgeExpiredCallbackNonces(now);
  }

  purgeIdempotencyReceipts(before: string): number {
    const result = this.getDb()
      .prepare("DELETE FROM idempotency_receipts WHERE updated_at <= ?")
      .run(before);
    return Number(result.changes ?? 0);
  }

  claimCallbackNonce(record: CallbackNonceRecord): boolean {
    const result = this.getDb()
      .prepare(
        `INSERT OR IGNORE INTO callback_nonces (
            nonce_key, scope, expires_at, record_json
          ) VALUES (?, ?, ?, ?)`,
      )
      .run(record.nonceKey, record.scope, record.expiresAt, JSON.stringify(record));
    return Number(result.changes ?? 0) > 0;
  }

  async claimCallbackNonceAsync(record: CallbackNonceRecord): Promise<boolean> {
    return this.claimCallbackNonce(record);
  }

  insertNotification(record: NotificationOutboxRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO notification_outbox (
            notification_id, event_id, project_key, delivery_channel, event_type, status, dedupe_key, created_at, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(delivery_channel, dedupe_key) DO NOTHING`,
      )
      .run(
        record.notificationId,
        record.eventId,
        record.projectKey,
        record.deliveryChannel,
        record.eventType,
        record.status,
        record.dedupeKey,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record),
      );
  }

  async insertNotificationAsync(
    record: NotificationOutboxRecord,
  ): Promise<NotificationOutboxRecord> {
    this.insertNotification(record);
    return this.getNotificationByDedupeKey(record.deliveryChannel, record.dedupeKey) ?? record;
  }

  upsertNotification(record: NotificationOutboxRecord): void {
    this.getDb()
      .prepare(
        `INSERT INTO notification_outbox (
            notification_id, event_id, project_key, delivery_channel, event_type, status, dedupe_key, created_at, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(notification_id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            record_json = excluded.record_json`,
      )
      .run(
        record.notificationId,
        record.eventId,
        record.projectKey,
        record.deliveryChannel,
        record.eventType,
        record.status,
        record.dedupeKey,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record),
      );
  }

  async upsertNotificationAsync(record: NotificationOutboxRecord): Promise<void> {
    this.upsertNotification(record);
  }

  getNotification(notificationId: string): NotificationOutboxRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM notification_outbox WHERE notification_id = ?")
      .get(notificationId) as JsonRow | undefined;
    return parseJson<NotificationOutboxRecord>(row?.record_json);
  }

  async getNotificationAsync(notificationId: string): Promise<NotificationOutboxRecord | null> {
    return this.getNotification(notificationId);
  }

  getNotificationByDedupeKey(
    deliveryChannel: NotificationOutboxRecord["deliveryChannel"],
    dedupeKey: string,
  ): NotificationOutboxRecord | null {
    const row = this.getDb()
      .prepare(
        "SELECT record_json FROM notification_outbox WHERE delivery_channel = ? AND dedupe_key = ?",
      )
      .get(deliveryChannel, dedupeKey) as JsonRow | undefined;
    return parseJson<NotificationOutboxRecord>(row?.record_json);
  }

  async getNotificationByDedupeKeyAsync(
    deliveryChannel: NotificationOutboxRecord["deliveryChannel"],
    dedupeKey: string,
  ): Promise<NotificationOutboxRecord | null> {
    return this.getNotificationByDedupeKey(deliveryChannel, dedupeKey);
  }

  listNotifications(params?: {
    statuses?: NotificationOutboxRecord["status"][];
    deliveryChannel?: NotificationOutboxRecord["deliveryChannel"];
    limit?: number;
  }): NotificationOutboxRecord[] {
    const clauses: string[] = [];
    const values: Array<number | string> = [];
    if (params?.deliveryChannel) {
      clauses.push("delivery_channel = ?");
      values.push(params.deliveryChannel);
    }
    if (params?.statuses?.length) {
      clauses.push(`status IN (${params.statuses.map(() => "?").join(", ")})`);
      values.push(...params.statuses);
    }
    let query = "SELECT record_json FROM notification_outbox";
    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(" AND ")}`;
    }
    query += " ORDER BY created_at ASC";
    if (params?.limit && params.limit > 0) {
      query += " LIMIT ?";
      values.push(params.limit);
    }
    const rows = this.getDb()
      .prepare(query)
      .all(...values) as JsonRow[];
    return rows
      .map((row) => parseJson<NotificationOutboxRecord>(row.record_json))
      .filter((row): row is NotificationOutboxRecord => Boolean(row));
  }

  async listNotificationsAsync(params?: {
    deliveryChannel?: NotificationOutboxRecord["deliveryChannel"];
    statuses?: NotificationOutboxRecord["status"][];
    limit?: number;
  }): Promise<NotificationOutboxRecord[]> {
    return this.listNotifications(params);
  }

  purgeNotifications(params: {
    before: string;
    statuses?: NotificationOutboxRecord["status"][];
  }): number {
    const clauses = ["updated_at <= ?"];
    const values: Array<string> = [params.before];
    if (params.statuses?.length) {
      clauses.push(`status IN (${params.statuses.map(() => "?").join(", ")})`);
      values.push(...params.statuses);
    }
    const result = this.getDb()
      .prepare(`DELETE FROM notification_outbox WHERE ${clauses.join(" AND ")}`)
      .run(...values);
    return Number(result.changes ?? 0);
  }

  async purgeNotificationsAsync(params: {
    before: string;
    statuses?: NotificationOutboxRecord["status"][];
  }): Promise<number> {
    return this.purgeNotifications(params);
  }

  upsertBaseline(record: BaselineRecord): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO patch_baselines (
            baseline_id, project_key, environment, channel, platform, created_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.baselineId,
        record.projectKey,
        record.environment,
        record.channel,
        record.platform,
        record.createdAt,
        JSON.stringify(record),
      );
  }

  async upsertBaselineAsync(record: BaselineRecord): Promise<void> {
    this.upsertBaseline(record);
  }

  listBaselines(params: {
    projectKey: string;
    environment: string;
    channel: string;
    platform: string;
  }): BaselineRecord[] {
    const rows = this.getDb()
      .prepare(
        `SELECT record_json FROM patch_baselines
         WHERE project_key = ? AND environment = ? AND channel = ? AND platform = ?
         ORDER BY created_at DESC`,
      )
      .all(params.projectKey, params.environment, params.channel, params.platform) as JsonRow[];
    return rows
      .map((row) => parseJson<BaselineRecord>(row.record_json))
      .filter((row): row is BaselineRecord => Boolean(row));
  }

  async listBaselinesAsync(params: {
    projectKey: string;
    environment: string;
    channel: string;
    platform: string;
  }): Promise<BaselineRecord[]> {
    return this.listBaselines(params);
  }

  purgeEvents(before: string): number {
    const result = this.getDb().prepare("DELETE FROM event_logs WHERE created_at <= ?").run(before);
    return Number(result.changes ?? 0);
  }

  async purgeEventsAsync(before: string): Promise<number> {
    return this.purgeEvents(before);
  }

  async purgeIdempotencyReceiptsAsync(before: string): Promise<number> {
    return this.purgeIdempotencyReceipts(before);
  }

  acquireLock(
    record: OperationLockRecord,
  ): { ok: true } | { ok: false; lock: OperationLockRecord } {
    const existing = this.getDb()
      .prepare("SELECT record_json FROM operation_locks WHERE lock_key = ?")
      .get(record.lockKey) as JsonRow | undefined;
    const current = parseJson<OperationLockRecord>(existing?.record_json);
    const now = Date.now();
    if (current && new Date(current.expiresAt).getTime() > now) {
      return { ok: false, lock: current };
    }
    this.getDb()
      .prepare(
        `INSERT INTO operation_locks (
            lock_key, project_key, environment, scope, expires_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(lock_key) DO UPDATE SET
            expires_at = excluded.expires_at,
            record_json = excluded.record_json`,
      )
      .run(
        record.lockKey,
        record.projectKey,
        record.environment,
        record.lockScope,
        record.expiresAt,
        JSON.stringify(record),
      );
    return { ok: true };
  }

  async acquireLockAsync(
    record: OperationLockRecord,
  ): Promise<{ ok: true } | { ok: false; lock: OperationLockRecord }> {
    return this.acquireLock(record);
  }

  releaseLock(lockKey: string): void {
    this.getDb().prepare("DELETE FROM operation_locks WHERE lock_key = ?").run(lockKey);
  }

  async releaseLockAsync(lockKey: string): Promise<void> {
    this.releaseLock(lockKey);
  }

  purgeExpiredLocks(): void {
    this.getDb().prepare("DELETE FROM operation_locks WHERE expires_at <= ?").run(nowIso());
  }

  async purgeExpiredLocksAsync(): Promise<void> {
    this.purgeExpiredLocks();
  }
}

export class PostgresLobsterReleaseStore implements LobsterReleaseStoreApi {
  private readonly quotedSchema: SchemaIdentifier;
  private client: PostgresClient | undefined;
  private loaded = false;
  private fatalWriteError: Error | undefined;
  private readonly schemaMeta = new Map<string, SchemaMetaRecord>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly releases = new Map<string, ReleaseRecord>();
  private readonly builds = new Map<string, BuildRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly channelStates = new Map<string, ChannelStateRecord>();
  private readonly releaseRelations = new Map<string, ReleaseRelationRecord>();
  private readonly buildProvenance = new Map<string, BuildProvenanceRecord>();
  private readonly rollbacks = new Map<string, RollbackOperationRecord>();
  private readonly rollouts = new Map<string, RolloutRecord>();
  private readonly events = new Map<string, EventLogRecord>();
  private readonly callbackNonces = new Map<string, CallbackNonceRecord>();
  private readonly idempotencyReceipts = new Map<string, IdempotencyReceiptRecord>();
  private readonly notifications = new Map<string, NotificationOutboxRecord>();
  private readonly baselines = new Map<string, BaselineRecord>();
  private readonly locks = new Map<string, OperationLockRecord>();

  constructor(
    private readonly connectionString: string,
    private readonly schema = "public",
  ) {
    this.quotedSchema = quoteSchemaIdentifier(schema);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      this.assertHealthy();
      return;
    }
    const { createPostgresClient } = await import("./postgres.runtime.js");
    const client = createPostgresClient(this.connectionString) as unknown as PostgresClient;
    this.client = client;
    await this.bootstrapSchema();
    const schemaMeta: SchemaMetaRecord = {
      metaKey: "store_schema_version",
      schemaVersion: STORE_SCHEMA_VERSION,
      updatedAt: nowIso(),
    };
    this.schemaMeta.set(schemaMeta.metaKey, schemaMeta);
    await client.unsafe(
      `INSERT INTO ${this.table("schema_meta")} (meta_key, record_json)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (meta_key) DO UPDATE SET record_json = EXCLUDED.record_json`,
      [schemaMeta.metaKey, JSON.stringify(schemaMeta)],
    );
    this.loaded = true;
  }

  close(): void {
    const client = this.client;
    this.client = undefined;
    this.loaded = false;
    if (client) {
      void client.end({ timeout: 1 }).catch(() => undefined);
    }
  }

  getSchemaInfo(): StoreSchemaInfo {
    this.assertHealthy();
    return (
      this.schemaMeta.get("store_schema_version") ?? {
        metaKey: "store_schema_version",
        schemaVersion: STORE_SCHEMA_VERSION,
        updatedAt: nowIso(),
      }
    );
  }

  async upsertProjectAsync(record: ProjectRecord): Promise<void> {
    this.projects.set(record.projectKey, record);
    await this.executeDirect(
      `upsertProject:${record.projectKey}`,
      `INSERT INTO ${this.table("projects")} (project_key, updated_at, record_json)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (project_key) DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         record_json = EXCLUDED.record_json`,
      [record.projectKey, record.updatedAt, JSON.stringify(record)],
    );
  }

  upsertProject(_record: ProjectRecord): void {
    this.assertSyncMethodUnsupported("upsertProject");
  }

  getProject(_projectKey: string): ProjectRecord | null {
    return this.assertSyncMethodUnsupported("getProject");
  }

  async getProjectAsync(projectKey: string): Promise<ProjectRecord | null> {
    const record = await this.selectSingleByField<ProjectRecord>(
      "projects",
      "project_key",
      projectKey,
    );
    if (record) {
      this.projects.set(record.projectKey, record);
    }
    return record;
  }

  upsertRelease(_record: ReleaseRecord): void {
    this.assertSyncMethodUnsupported("upsertRelease");
  }

  async insertEventAsync(record: EventLogRecord): Promise<void> {
    await this.executeDirect(
      `insertEvent:${record.eventId}`,
      `INSERT INTO ${this.table("event_logs")} (
         event_id, project_key, object_type, object_id, event_type, created_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (event_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
      [
        record.eventId,
        record.projectKey,
        record.objectType,
        record.objectId,
        record.eventType,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
    this.events.set(record.eventId, record);
  }

  async upsertReleaseAsync(record: ReleaseRecord): Promise<void> {
    this.releases.set(record.releaseId, record);
    await this.executeDirect(
      `upsertRelease:${record.releaseId}`,
      `INSERT INTO ${this.table("releases")} (
         release_id, project_key, environment, channel, version, status, stable, frozen, updated_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (release_id) DO UPDATE SET
         status = EXCLUDED.status,
         stable = EXCLUDED.stable,
         frozen = EXCLUDED.frozen,
         updated_at = EXCLUDED.updated_at,
         record_json = EXCLUDED.record_json`,
      [
        record.releaseId,
        record.projectKey,
        record.environment,
        record.channel,
        record.version,
        record.status,
        record.stable,
        record.frozen,
        record.updatedAt,
        JSON.stringify(record),
      ],
    );
  }

  getRelease(_releaseId: string): ReleaseRecord | null {
    return this.assertSyncMethodUnsupported("getRelease");
  }

  async getReleaseAsync(releaseId: string): Promise<ReleaseRecord | null> {
    const record = await this.selectSingleByField<ReleaseRecord>(
      "releases",
      "release_id",
      releaseId,
    );
    if (record) {
      this.releases.set(record.releaseId, record);
    }
    return record;
  }

  listReleases(_params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    status?: string;
    stable?: boolean;
    limit?: number;
  }): ReleaseRecord[] {
    return this.assertSyncMethodUnsupported("listReleases");
  }

  async listBuildsAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): Promise<BuildRecord[]> {
    const clauses = ["project_key = $1"];
    const values: unknown[] = [params.projectKey];
    if (params.environment) {
      values.push(params.environment);
      clauses.push(`environment = $${values.length}`);
    }
    if (params.channel) {
      values.push(params.channel);
      clauses.push(`channel = $${values.length}`);
    }
    const records = await this.selectManyByClauses<BuildRecord>("builds", clauses, values, {
      orderBy: "updated_at DESC",
      limit: params.limit,
    });
    for (const record of records) {
      this.builds.set(record.buildId, record);
    }
    return records;
  }

  async listReleasesAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    status?: string;
    stable?: boolean;
    limit?: number;
  }): Promise<ReleaseRecord[]> {
    const clauses = ["project_key = $1"];
    const values: unknown[] = [params.projectKey];
    if (params.environment) {
      values.push(params.environment);
      clauses.push(`environment = $${values.length}`);
    }
    if (params.channel) {
      values.push(params.channel);
      clauses.push(`channel = $${values.length}`);
    }
    if (params.status) {
      values.push(params.status);
      clauses.push(`status = $${values.length}`);
    }
    if (params.stable !== undefined) {
      values.push(params.stable);
      clauses.push(`stable = $${values.length}`);
    }
    const records = await this.selectManyByClauses<ReleaseRecord>("releases", clauses, values, {
      orderBy: "updated_at DESC",
      limit: params.limit,
    });
    for (const record of records) {
      this.releases.set(record.releaseId, record);
    }
    return records;
  }

  upsertBuild(_record: BuildRecord): void {
    this.assertSyncMethodUnsupported("upsertBuild");
  }

  async upsertBuildAsync(record: BuildRecord): Promise<void> {
    this.builds.set(record.buildId, record);
    await this.executeDirect(
      `upsertBuild:${record.buildId}`,
      `INSERT INTO ${this.table("builds")} (
         build_id, release_id, project_key, environment, channel, status, updated_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (build_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         record_json = EXCLUDED.record_json`,
      [
        record.buildId,
        record.releaseId,
        record.projectKey,
        record.environment,
        record.channel,
        record.status,
        record.updatedAt,
        JSON.stringify(record),
      ],
    );
  }

  getBuild(_buildId: string): BuildRecord | null {
    return this.assertSyncMethodUnsupported("getBuild");
  }

  async getBuildAsync(buildId: string): Promise<BuildRecord | null> {
    const record = await this.selectSingleByField<BuildRecord>("builds", "build_id", buildId);
    if (record) {
      this.builds.set(record.buildId, record);
    }
    return record;
  }

  listBuildsForRelease(_releaseId: string): BuildRecord[] {
    return this.assertSyncMethodUnsupported("listBuildsForRelease");
  }

  listBuilds(_params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): BuildRecord[] {
    return this.assertSyncMethodUnsupported("listBuilds");
  }

  insertArtifact(_record: ArtifactRecord): void {
    this.assertSyncMethodUnsupported("insertArtifact");
  }

  async insertArtifactAsync(record: ArtifactRecord): Promise<void> {
    this.artifacts.set(record.artifactId, record);
    await this.executeDirect(
      `insertArtifact:${record.artifactId}`,
      `INSERT INTO ${this.table("artifacts")} (
         artifact_id, build_id, release_id, project_key, artifact_type, created_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (artifact_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
      [
        record.artifactId,
        record.buildId,
        record.releaseId,
        record.projectKey,
        record.artifactType,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
  }

  listArtifactsForBuild(_buildId: string): ArtifactRecord[] {
    return this.assertSyncMethodUnsupported("listArtifactsForBuild");
  }

  async listArtifactsForBuildAsync(buildId: string): Promise<ArtifactRecord[]> {
    const records = await this.selectManyByClauses<ArtifactRecord>(
      "artifacts",
      ["build_id = $1"],
      [buildId],
      { orderBy: "created_at ASC" },
    );
    for (const record of records) {
      this.artifacts.set(record.artifactId, record);
    }
    return records;
  }

  deleteArtifacts(_artifactIds: string[]): number {
    this.assertSyncMethodUnsupported("deleteArtifacts");
  }

  async deleteArtifactsAsync(artifactIds: string[]): Promise<number> {
    if (artifactIds.length === 0) {
      return 0;
    }
    let deleted = 0;
    for (const artifactId of artifactIds) {
      if (this.artifacts.delete(artifactId)) {
        deleted += 1;
      }
    }
    await this.executeDirect(
      `deleteArtifacts:${artifactIds.length}`,
      `DELETE FROM ${this.table("artifacts")} WHERE artifact_id = ANY($1::text[])`,
      [artifactIds],
    );
    return deleted;
  }

  upsertChannelState(_record: ChannelStateRecord): void {
    this.assertSyncMethodUnsupported("upsertChannelState");
  }

  async upsertChannelStateAsync(record: ChannelStateRecord): Promise<void> {
    const stateKey = this.channelStateKey(record.projectKey, record.environment, record.channel);
    this.channelStates.set(stateKey, record);
    await this.executeDirect(
      `upsertChannelState:${stateKey}`,
      `INSERT INTO ${this.table("channel_state")} (
         state_key, project_key, environment, channel, updated_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (state_key) DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         record_json = EXCLUDED.record_json`,
      [
        stateKey,
        record.projectKey,
        record.environment,
        record.channel,
        record.updatedAt,
        JSON.stringify(record),
      ],
    );
  }

  getChannelState(
    _projectKey: string,
    _environment: string,
    _channel: string,
  ): ChannelStateRecord | null {
    return this.assertSyncMethodUnsupported("getChannelState");
  }

  async getChannelStateAsync(
    projectKey: string,
    environment: string,
    channel: string,
  ): Promise<ChannelStateRecord | null> {
    const record = await this.selectSingleByField<ChannelStateRecord>(
      "channel_state",
      "state_key",
      this.channelStateKey(projectKey, environment, channel),
    );
    if (record) {
      this.channelStates.set(this.channelStateKey(projectKey, environment, channel), record);
    }
    return record;
  }

  insertReleaseRelation(_record: ReleaseRelationRecord): void {
    this.assertSyncMethodUnsupported("insertReleaseRelation");
  }

  async insertReleaseRelationAsync(record: ReleaseRelationRecord): Promise<void> {
    this.releaseRelations.set(record.relationId, record);
    await this.executeDirect(
      `insertReleaseRelation:${record.relationId}`,
      `INSERT INTO ${this.table("release_relations")} (
         relation_id, project_key, from_release_id, to_release_id, relation_type, created_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (relation_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
      [
        record.relationId,
        record.projectKey,
        record.fromReleaseId,
        record.toReleaseId,
        record.relationType,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
  }

  listReleaseRelations(_projectKey: string, _releaseId: string): ReleaseRelationRecord[] {
    return this.assertSyncMethodUnsupported("listReleaseRelations");
  }

  async listReleaseRelationsAsync(
    projectKey: string,
    releaseId: string,
  ): Promise<ReleaseRelationRecord[]> {
    const records = await this.selectManyByClauses<ReleaseRelationRecord>(
      "release_relations",
      ["project_key = $1", "(from_release_id = $2 OR to_release_id = $3)"],
      [projectKey, releaseId, releaseId],
      { orderBy: "created_at ASC" },
    );
    for (const record of records) {
      this.releaseRelations.set(record.relationId, record);
    }
    return records;
  }

  listReleaseRelationsByType(
    _projectKey: string,
    _relationType: string,
    _limit?: number,
  ): ReleaseRelationRecord[] {
    return this.assertSyncMethodUnsupported("listReleaseRelationsByType");
  }

  async listReleaseRelationsByTypeAsync(
    projectKey: string,
    relationType: string,
    limit?: number,
  ): Promise<ReleaseRelationRecord[]> {
    const records = await this.selectManyByClauses<ReleaseRelationRecord>(
      "release_relations",
      ["project_key = $1", "relation_type = $2"],
      [projectKey, relationType],
      {
        orderBy: "created_at DESC",
        limit,
      },
    );
    for (const record of records) {
      this.releaseRelations.set(record.relationId, record);
    }
    return records;
  }

  upsertBuildProvenance(_record: BuildProvenanceRecord): void {
    this.assertSyncMethodUnsupported("upsertBuildProvenance");
  }

  async upsertBuildProvenanceAsync(record: BuildProvenanceRecord): Promise<void> {
    this.buildProvenance.set(record.buildId, record);
    await this.executeDirect(
      `upsertBuildProvenance:${record.buildId}`,
      `INSERT INTO ${this.table("build_provenance")} (
         build_id, release_id, project_key, captured_at, provenance_hash, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (build_id) DO UPDATE SET
         captured_at = EXCLUDED.captured_at,
         provenance_hash = EXCLUDED.provenance_hash,
         record_json = EXCLUDED.record_json`,
      [
        record.buildId,
        record.releaseId,
        record.projectKey,
        record.capturedAt,
        record.provenanceHash,
        JSON.stringify(record),
      ],
    );
  }

  getBuildProvenance(_buildId: string): BuildProvenanceRecord | null {
    return this.assertSyncMethodUnsupported("getBuildProvenance");
  }

  async getBuildProvenanceAsync(buildId: string): Promise<BuildProvenanceRecord | null> {
    const record = await this.selectSingleByField<BuildProvenanceRecord>(
      "build_provenance",
      "build_id",
      buildId,
    );
    if (record) {
      this.buildProvenance.set(record.buildId, record);
    }
    return record;
  }

  listReleaseProvenance(_releaseId: string): BuildProvenanceRecord[] {
    return this.assertSyncMethodUnsupported("listReleaseProvenance");
  }

  async listReleaseProvenanceAsync(releaseId: string): Promise<BuildProvenanceRecord[]> {
    const records = await this.selectManyByClauses<BuildProvenanceRecord>(
      "build_provenance",
      ["release_id = $1"],
      [releaseId],
      { orderBy: "captured_at DESC" },
    );
    for (const record of records) {
      this.buildProvenance.set(record.buildId, record);
    }
    return records;
  }

  upsertRollback(_record: RollbackOperationRecord): void {
    this.assertSyncMethodUnsupported("upsertRollback");
  }

  async upsertRollbackAsync(record: RollbackOperationRecord): Promise<void> {
    this.rollbacks.set(record.rollbackId, record);
    await this.executeDirect(
      `upsertRollback:${record.rollbackId}`,
      `INSERT INTO ${this.table("rollback_operations")} (
         rollback_id, project_key, environment, channel, status, updated_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (rollback_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         record_json = EXCLUDED.record_json`,
      [
        record.rollbackId,
        record.projectKey,
        record.environment,
        record.channel,
        record.status,
        record.completedAt ?? record.createdAt,
        JSON.stringify(record),
      ],
    );
  }

  getRollback(_rollbackId: string): RollbackOperationRecord | null {
    return this.assertSyncMethodUnsupported("getRollback");
  }

  async getRollbackAsync(rollbackId: string): Promise<RollbackOperationRecord | null> {
    const record = await this.selectSingleByField<RollbackOperationRecord>(
      "rollback_operations",
      "rollback_id",
      rollbackId,
    );
    if (record) {
      this.rollbacks.set(record.rollbackId, record);
    }
    return record;
  }

  listRollbacks(_params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): RollbackOperationRecord[] {
    return this.assertSyncMethodUnsupported("listRollbacks");
  }

  async listRollbacksAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    limit?: number;
  }): Promise<RollbackOperationRecord[]> {
    const clauses = ["project_key = $1"];
    const values: unknown[] = [params.projectKey];
    if (params.environment) {
      values.push(params.environment);
      clauses.push(`environment = $${values.length}`);
    }
    if (params.channel) {
      values.push(params.channel);
      clauses.push(`channel = $${values.length}`);
    }
    const records = await this.selectManyByClauses<RollbackOperationRecord>(
      "rollback_operations",
      clauses,
      values,
      { orderBy: "updated_at DESC", limit: params.limit },
    );
    for (const record of records) {
      this.rollbacks.set(record.rollbackId, record);
    }
    return records;
  }

  upsertRollout(_record: RolloutRecord): void {
    this.assertSyncMethodUnsupported("upsertRollout");
  }

  async upsertRolloutAsync(record: RolloutRecord): Promise<void> {
    this.rollouts.set(record.rolloutId, record);
    await this.executeDirect(
      `upsertRollout:${record.rolloutId}`,
      `INSERT INTO ${this.table("rollouts")} (
         rollout_id, project_key, environment, channel, release_id, status, updated_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (rollout_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         record_json = EXCLUDED.record_json`,
      [
        record.rolloutId,
        record.projectKey,
        record.environment,
        record.channel,
        record.releaseId,
        record.status,
        record.updatedAt,
        JSON.stringify(record),
      ],
    );
  }

  getRollout(_rolloutId: string): RolloutRecord | null {
    return this.assertSyncMethodUnsupported("getRollout");
  }

  async getRolloutAsync(rolloutId: string): Promise<RolloutRecord | null> {
    const record = await this.selectSingleByField<RolloutRecord>(
      "rollouts",
      "rollout_id",
      rolloutId,
    );
    if (record) {
      this.rollouts.set(record.rolloutId, record);
    }
    return record;
  }

  listRollouts(_params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    releaseId?: string;
    statuses?: RolloutRecord["status"][];
    limit?: number;
  }): RolloutRecord[] {
    return this.assertSyncMethodUnsupported("listRollouts");
  }

  async listRolloutsAsync(params: {
    projectKey: string;
    environment?: string;
    channel?: string;
    releaseId?: string;
    statuses?: RolloutRecord["status"][];
    limit?: number;
  }): Promise<RolloutRecord[]> {
    const clauses = ["project_key = $1"];
    const values: unknown[] = [params.projectKey];
    if (params.environment) {
      values.push(params.environment);
      clauses.push(`environment = $${values.length}`);
    }
    if (params.channel) {
      values.push(params.channel);
      clauses.push(`channel = $${values.length}`);
    }
    if (params.releaseId) {
      values.push(params.releaseId);
      clauses.push(`release_id = $${values.length}`);
    }
    if (params.statuses?.length) {
      values.push(params.statuses);
      clauses.push(`status = ANY($${values.length}::text[])`);
    }
    const records = await this.selectManyByClauses<RolloutRecord>("rollouts", clauses, values, {
      orderBy: "updated_at DESC",
      limit: params.limit,
    });
    for (const record of records) {
      this.rollouts.set(record.rolloutId, record);
    }
    return records;
  }

  insertEvent(_record: EventLogRecord): void {
    this.assertSyncMethodUnsupported("insertEvent");
  }

  listEvents(_params: {
    projectKey: string;
    objectType?: string;
    objectId?: string;
    eventType?: string;
    eventTypePrefix?: string;
    limit?: number;
  }): EventLogRecord[] {
    return this.assertSyncMethodUnsupported("listEvents");
  }

  async listEventsAsync(params: {
    projectKey: string;
    objectType?: string;
    objectId?: string;
    eventType?: string;
    eventTypePrefix?: string;
    limit?: number;
  }): Promise<EventLogRecord[]> {
    const clauses = ["project_key = $1"];
    const values: unknown[] = [params.projectKey];
    if (params.objectType) {
      values.push(params.objectType);
      clauses.push(`object_type = $${values.length}`);
    }
    if (params.objectId) {
      values.push(params.objectId);
      clauses.push(`object_id = $${values.length}`);
    }
    if (params.eventType) {
      values.push(params.eventType);
      clauses.push(`event_type = $${values.length}`);
    } else if (params.eventTypePrefix) {
      values.push(`${params.eventTypePrefix}%`);
      clauses.push(`event_type LIKE $${values.length}`);
    }
    const records = await this.selectManyByClauses<EventLogRecord>("event_logs", clauses, values, {
      orderBy: "created_at DESC",
      limit: params.limit,
    });
    for (const record of records) {
      this.events.set(record.eventId, record);
    }
    return records;
  }

  getIdempotencyReceipt(_scope: string, _idempotencyKey: string): IdempotencyReceiptRecord | null {
    return this.assertSyncMethodUnsupported("getIdempotencyReceipt");
  }

  async getIdempotencyReceiptAsync(
    scope: string,
    idempotencyKey: string,
  ): Promise<IdempotencyReceiptRecord | null> {
    const record = await this.selectSingleByField<IdempotencyReceiptRecord>(
      "idempotency_receipts",
      "receipt_key",
      `${scope}:${idempotencyKey}`,
    );
    if (record) {
      this.idempotencyReceipts.set(record.receiptKey, record);
    }
    return record;
  }

  upsertIdempotencyReceipt(_record: IdempotencyReceiptRecord): void {
    this.assertSyncMethodUnsupported("upsertIdempotencyReceipt");
  }

  async upsertIdempotencyReceiptAsync(record: IdempotencyReceiptRecord): Promise<void> {
    this.idempotencyReceipts.set(record.receiptKey, record);
    await this.executeDirect(
      `upsertIdempotencyReceipt:${record.receiptKey}`,
      `INSERT INTO ${this.table("idempotency_receipts")} (
         receipt_key, scope, created_at, updated_at, record_json
       ) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (receipt_key) DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         record_json = EXCLUDED.record_json`,
      [record.receiptKey, record.scope, record.createdAt, record.updatedAt, JSON.stringify(record)],
    );
  }

  purgeExpiredCallbackNonces(_now = nowIso()): void {
    this.assertSyncMethodUnsupported("purgeExpiredCallbackNonces");
  }

  async purgeExpiredCallbackNoncesAsync(now = nowIso()): Promise<void> {
    await this.waitForPendingWrites();
    const rows = await this.getClient().unsafe(
      `SELECT record_json FROM ${this.table("callback_nonces")} WHERE expires_at <= $1`,
      [now],
    );
    const expired = rows
      .map((row) => parsePostgresJson<CallbackNonceRecord>(row.record_json))
      .filter((record): record is CallbackNonceRecord => Boolean(record));
    if (expired.length === 0) {
      return;
    }
    const expiredKeys = expired.map((record) => record.nonceKey);
    this.removeMany(expiredKeys, this.callbackNonces);
    await this.executeDirect(
      `purgeExpiredCallbackNonces:${expiredKeys.length}`,
      `DELETE FROM ${this.table("callback_nonces")} WHERE nonce_key = ANY($1::text[])`,
      [expiredKeys],
    );
  }

  purgeIdempotencyReceipts(_before: string): number {
    return this.assertSyncMethodUnsupported("purgeIdempotencyReceipts");
  }

  claimCallbackNonce(_record: CallbackNonceRecord): boolean {
    return this.assertSyncMethodUnsupported("claimCallbackNonce");
  }

  async claimCallbackNonceAsync(record: CallbackNonceRecord): Promise<boolean> {
    await this.waitForPendingWrites();
    const inserted = await this.getClient().begin(async (sql) => {
      await sql.unsafe(`DELETE FROM ${this.table("callback_nonces")} WHERE expires_at <= $1`, [
        record.createdAt,
      ]);
      const rows = await sql.unsafe(
        `INSERT INTO ${this.table("callback_nonces")} (
           nonce_key, scope, expires_at, record_json
         ) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (nonce_key) DO NOTHING
         RETURNING record_json`,
        [record.nonceKey, record.scope, record.expiresAt, JSON.stringify(record)],
      );
      return rows.length > 0;
    });
    if (!inserted) {
      return false;
    }
    this.callbackNonces.set(record.nonceKey, record);
    return true;
  }

  insertNotification(_record: NotificationOutboxRecord): void {
    this.assertSyncMethodUnsupported("insertNotification");
  }

  async insertNotificationAsync(
    record: NotificationOutboxRecord,
  ): Promise<NotificationOutboxRecord> {
    await this.waitForPendingWrites();
    const inserted = await this.getClient().begin(async (sql) => {
      const rows = await sql.unsafe(
        `INSERT INTO ${this.table("notification_outbox")} (
           notification_id, event_id, project_key, delivery_channel, event_type, status, dedupe_key, created_at, updated_at, record_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (delivery_channel, dedupe_key) DO NOTHING
         RETURNING record_json`,
        [
          record.notificationId,
          record.eventId,
          record.projectKey,
          record.deliveryChannel,
          record.eventType,
          record.status,
          record.dedupeKey,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record),
        ],
      );
      if (rows.length > 0) {
        return parsePostgresJson<NotificationOutboxRecord>(rows[0]?.record_json) ?? record;
      }
      const existingRows = await sql.unsafe(
        `SELECT record_json FROM ${this.table("notification_outbox")}
         WHERE delivery_channel = $1 AND dedupe_key = $2
         LIMIT 1`,
        [record.deliveryChannel, record.dedupeKey],
      );
      return parsePostgresJson<NotificationOutboxRecord>(existingRows[0]?.record_json) ?? record;
    });
    this.notifications.set(inserted.notificationId, inserted);
    return inserted;
  }

  upsertNotification(_record: NotificationOutboxRecord): void {
    this.assertSyncMethodUnsupported("upsertNotification");
  }

  async upsertNotificationAsync(record: NotificationOutboxRecord): Promise<void> {
    await this.executeDirect(
      `upsertNotification:${record.notificationId}`,
      `INSERT INTO ${this.table("notification_outbox")} (
         notification_id, event_id, project_key, delivery_channel, event_type, status, dedupe_key, created_at, updated_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (notification_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         record_json = EXCLUDED.record_json`,
      [
        record.notificationId,
        record.eventId,
        record.projectKey,
        record.deliveryChannel,
        record.eventType,
        record.status,
        record.dedupeKey,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record),
      ],
    );
    this.notifications.set(record.notificationId, record);
  }

  getNotification(_notificationId: string): NotificationOutboxRecord | null {
    return this.assertSyncMethodUnsupported("getNotification");
  }

  async getNotificationAsync(notificationId: string): Promise<NotificationOutboxRecord | null> {
    const record = await this.selectSingleByField<NotificationOutboxRecord>(
      "notification_outbox",
      "notification_id",
      notificationId,
    );
    if (record) {
      this.notifications.set(record.notificationId, record);
    }
    return record;
  }

  getNotificationByDedupeKey(
    _deliveryChannel: NotificationOutboxRecord["deliveryChannel"],
    _dedupeKey: string,
  ): NotificationOutboxRecord | null {
    return this.assertSyncMethodUnsupported("getNotificationByDedupeKey");
  }

  async getNotificationByDedupeKeyAsync(
    deliveryChannel: NotificationOutboxRecord["deliveryChannel"],
    dedupeKey: string,
  ): Promise<NotificationOutboxRecord | null> {
    const rows = await this.getClient().unsafe(
      `SELECT record_json FROM ${this.table("notification_outbox")}
       WHERE delivery_channel = $1 AND dedupe_key = $2
       LIMIT 1`,
      [deliveryChannel, dedupeKey],
    );
    const record = parsePostgresJson<NotificationOutboxRecord>(rows[0]?.record_json);
    if (record) {
      this.notifications.set(record.notificationId, record);
    }
    return record ?? null;
  }

  listNotifications(_params?: {
    deliveryChannel?: NotificationOutboxRecord["deliveryChannel"];
    statuses?: NotificationOutboxRecord["status"][];
    limit?: number;
  }): NotificationOutboxRecord[] {
    return this.assertSyncMethodUnsupported("listNotifications");
  }

  async listNotificationsAsync(params?: {
    deliveryChannel?: NotificationOutboxRecord["deliveryChannel"];
    statuses?: NotificationOutboxRecord["status"][];
    limit?: number;
  }): Promise<NotificationOutboxRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (params?.deliveryChannel) {
      values.push(params.deliveryChannel);
      clauses.push(`delivery_channel = $${values.length}`);
    }
    if (params?.statuses?.length) {
      values.push(params.statuses);
      clauses.push(`status = ANY($${values.length}::text[])`);
    }
    const records = await this.selectManyByClauses<NotificationOutboxRecord>(
      "notification_outbox",
      clauses,
      values,
      {
        orderBy: "created_at ASC",
        limit: params?.limit,
      },
    );
    for (const record of records) {
      this.notifications.set(record.notificationId, record);
    }
    return records;
  }

  purgeNotifications(_params: {
    before: string;
    statuses?: NotificationOutboxRecord["status"][];
  }): number {
    return this.assertSyncMethodUnsupported("purgeNotifications");
  }

  async purgeNotificationsAsync(params: {
    before: string;
    statuses?: NotificationOutboxRecord["status"][];
  }): Promise<number> {
    const clauses = ["updated_at <= $1"];
    const values: unknown[] = [params.before];
    if (params.statuses?.length) {
      values.push(params.statuses);
      clauses.push(`status = ANY($${values.length}::text[])`);
    }
    const rows = await this.getClient().unsafe(
      `SELECT record_json FROM ${this.table("notification_outbox")} WHERE ${clauses.join(" AND ")}`,
      values,
    );
    const deletedIds = rows
      .map((row) => parsePostgresJson<NotificationOutboxRecord>(row.record_json))
      .filter((record): record is NotificationOutboxRecord => Boolean(record))
      .map((record) => record.notificationId);
    this.removeMany(deletedIds, this.notifications);
    if (deletedIds.length === 0) {
      return 0;
    }
    await this.executeDirect(
      `purgeNotifications:${deletedIds.length}`,
      `DELETE FROM ${this.table("notification_outbox")} WHERE notification_id = ANY($1::text[])`,
      [deletedIds],
    );
    return deletedIds.length;
  }

  upsertBaseline(_record: BaselineRecord): void {
    this.assertSyncMethodUnsupported("upsertBaseline");
  }

  async upsertBaselineAsync(record: BaselineRecord): Promise<void> {
    this.baselines.set(record.baselineId, record);
    await this.executeDirect(
      `upsertBaseline:${record.baselineId}`,
      `INSERT INTO ${this.table("patch_baselines")} (
         baseline_id, project_key, environment, channel, platform, created_at, record_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (baseline_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
      [
        record.baselineId,
        record.projectKey,
        record.environment,
        record.channel,
        record.platform,
        record.createdAt,
        JSON.stringify(record),
      ],
    );
  }

  listBaselines(_params: {
    projectKey: string;
    environment: string;
    channel: string;
    platform: string;
  }): BaselineRecord[] {
    return this.assertSyncMethodUnsupported("listBaselines");
  }

  async listBaselinesAsync(params: {
    projectKey: string;
    environment: string;
    channel: string;
    platform: string;
  }): Promise<BaselineRecord[]> {
    const records = await this.selectManyByClauses<BaselineRecord>(
      "patch_baselines",
      ["project_key = $1", "environment = $2", "channel = $3", "platform = $4"],
      [params.projectKey, params.environment, params.channel, params.platform],
      { orderBy: "created_at DESC" },
    );
    for (const record of records) {
      this.baselines.set(record.baselineId, record);
    }
    return records;
  }

  purgeEvents(_before: string): number {
    return this.assertSyncMethodUnsupported("purgeEvents");
  }

  async purgeEventsAsync(before: string): Promise<number> {
    const rows = await this.getClient().unsafe(
      `SELECT record_json FROM ${this.table("event_logs")} WHERE created_at <= $1`,
      [before],
    );
    const deletedIds = rows
      .map((row) => parsePostgresJson<EventLogRecord>(row.record_json))
      .filter((record): record is EventLogRecord => Boolean(record))
      .map((record) => record.eventId);
    this.removeMany(deletedIds, this.events);
    if (deletedIds.length === 0) {
      return 0;
    }
    await this.executeDirect(
      `purgeEvents:${deletedIds.length}`,
      `DELETE FROM ${this.table("event_logs")} WHERE event_id = ANY($1::text[])`,
      [deletedIds],
    );
    return deletedIds.length;
  }

  async purgeIdempotencyReceiptsAsync(before: string): Promise<number> {
    const rows = await this.getClient().unsafe(
      `SELECT record_json FROM ${this.table("idempotency_receipts")} WHERE updated_at <= $1`,
      [before],
    );
    const expiredKeys = rows
      .map((row) => parsePostgresJson<IdempotencyReceiptRecord>(row.record_json))
      .filter((record): record is IdempotencyReceiptRecord => Boolean(record))
      .map((record) => record.receiptKey);
    this.removeMany(expiredKeys, this.idempotencyReceipts);
    if (expiredKeys.length === 0) {
      return 0;
    }
    await this.executeDirect(
      `purgeIdempotencyReceipts:${expiredKeys.length}`,
      `DELETE FROM ${this.table("idempotency_receipts")} WHERE receipt_key = ANY($1::text[])`,
      [expiredKeys],
    );
    return expiredKeys.length;
  }

  acquireLock(
    _record: OperationLockRecord,
  ): { ok: true } | { ok: false; lock: OperationLockRecord } {
    return this.assertSyncMethodUnsupported("acquireLock");
  }

  async acquireLockAsync(
    record: OperationLockRecord,
  ): Promise<{ ok: true } | { ok: false; lock: OperationLockRecord }> {
    await this.waitForPendingWrites();
    const result = await this.getClient().begin(async (sql) => {
      await sql.unsafe(
        `DELETE FROM ${this.table("operation_locks")} WHERE lock_key = $1 AND expires_at <= $2`,
        [record.lockKey, record.createdAt],
      );
      const currentRows = await sql.unsafe(
        `SELECT record_json FROM ${this.table("operation_locks")} WHERE lock_key = $1 LIMIT 1 FOR UPDATE`,
        [record.lockKey],
      );
      const current = parsePostgresJson<OperationLockRecord>(currentRows[0]?.record_json);
      if (current && new Date(current.expiresAt).getTime() > Date.now()) {
        return { ok: false as const, lock: current };
      }
      await sql.unsafe(
        `INSERT INTO ${this.table("operation_locks")} (
           lock_key, project_key, environment, scope, expires_at, record_json
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (lock_key) DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           record_json = EXCLUDED.record_json`,
        [
          record.lockKey,
          record.projectKey,
          record.environment,
          record.lockScope,
          record.expiresAt,
          JSON.stringify(record),
        ],
      );
      return { ok: true as const };
    });
    if (result.ok) {
      this.locks.set(record.lockKey, record);
      return { ok: true };
    }
    this.locks.set(result.lock.lockKey, result.lock);
    return result;
  }

  releaseLock(_lockKey: string): void {
    this.assertSyncMethodUnsupported("releaseLock");
  }

  async releaseLockAsync(lockKey: string): Promise<void> {
    this.locks.delete(lockKey);
    await this.executeDirect(
      `releaseLock:${lockKey}`,
      `DELETE FROM ${this.table("operation_locks")} WHERE lock_key = $1`,
      [lockKey],
    );
  }

  purgeExpiredLocks(): void {
    this.assertSyncMethodUnsupported("purgeExpiredLocks");
  }

  async purgeExpiredLocksAsync(): Promise<void> {
    const now = nowIso();
    await this.waitForPendingWrites();
    const rows = await this.getClient().unsafe(
      `SELECT record_json FROM ${this.table("operation_locks")} WHERE expires_at <= $1`,
      [now],
    );
    const expired = rows
      .map((row) => parsePostgresJson<OperationLockRecord>(row.record_json))
      .filter((record): record is OperationLockRecord => Boolean(record));
    if (expired.length === 0) {
      return;
    }
    const expiredKeys = expired.map((record) => record.lockKey);
    this.removeMany(expiredKeys, this.locks);
    await this.executeDirect(
      `purgeExpiredLocks:${expiredKeys.length}`,
      `DELETE FROM ${this.table("operation_locks")} WHERE lock_key = ANY($1::text[])`,
      [expiredKeys],
    );
  }

  private assertHealthy(): void {
    if (!this.loaded || !this.client) {
      throw new Error("lobster-release postgres store is not loaded");
    }
    if (this.fatalWriteError) {
      throw this.fatalWriteError;
    }
  }

  private async waitForPendingWrites(): Promise<void> {
    this.assertHealthy();
  }

  private getClient(): PostgresClient {
    this.assertHealthy();
    if (!this.client) {
      throw new Error("lobster-release postgres store client unavailable");
    }
    return this.client;
  }

  private async executeDirect(
    description: string,
    query: string,
    params: readonly unknown[],
  ): Promise<void> {
    const client = this.getClient();
    try {
      await client.unsafe(query, params);
    } catch (error) {
      const directError =
        error instanceof Error ? error : new Error(`postgres direct write failed: ${description}`);
      this.fatalWriteError = directError;
      throw directError;
    }
  }

  private async selectSingleByField<T>(
    tableName: string,
    fieldName: string,
    value: unknown,
  ): Promise<T | null> {
    await this.waitForPendingWrites();
    const rows = await this.getClient().unsafe(
      `SELECT record_json FROM ${this.table(tableName)} WHERE ${quoteSchemaIdentifier(fieldName)} = $1 LIMIT 1`,
      [value],
    );
    return parsePostgresJson<T>(rows[0]?.record_json);
  }

  private async selectManyByClauses<T>(
    tableName: string,
    clauses: string[],
    values: unknown[],
    options?: { orderBy?: string; limit?: number },
  ): Promise<T[]> {
    await this.waitForPendingWrites();
    let query = `SELECT record_json FROM ${this.table(tableName)}`;
    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(" AND ")}`;
    }
    if (options?.orderBy) {
      query += ` ORDER BY ${options.orderBy}`;
    }
    if (options?.limit && options.limit > 0) {
      values.push(options.limit);
      query += ` LIMIT $${values.length}`;
    }
    const rows = await this.getClient().unsafe(query, values);
    return rows
      .map((row) => parsePostgresJson<T>(row.record_json))
      .filter((record): record is T => Boolean(record));
  }

  private table(name: string): string {
    return `${this.quotedSchema}.${quoteSchemaIdentifier(name)}`;
  }

  private channelStateKey(projectKey: string, environment: string, channel: string): string {
    return `${projectKey}:${environment}:${channel}`;
  }

  private assertSyncMethodUnsupported<T>(method: string): T {
    this.assertHealthy();
    throw new Error(
      `lobster-release postgres store requires async direct-store access for ${method}; use the Async variant instead`,
    );
  }

  private removeMany<T>(keys: string[], cache: Map<string, T>): void {
    for (const key of keys) {
      cache.delete(key);
    }
  }

  private async bootstrapSchema(): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error("lobster-release postgres store client unavailable");
    }
    const statements = [
      `CREATE SCHEMA IF NOT EXISTS ${this.quotedSchema}`,
      `CREATE TABLE IF NOT EXISTS ${this.table("schema_meta")} (
         meta_key TEXT PRIMARY KEY,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("projects")} (
         project_key TEXT PRIMARY KEY,
         updated_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("releases")} (
         release_id TEXT PRIMARY KEY,
         project_key TEXT NOT NULL,
         environment TEXT NOT NULL,
         channel TEXT NOT NULL,
         version TEXT NOT NULL,
         status TEXT NOT NULL,
         stable BOOLEAN NOT NULL,
         frozen BOOLEAN NOT NULL,
         updated_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS releases_project_env_channel_version_uq
         ON ${this.table("releases")}(project_key, environment, channel, version)`,
      `CREATE INDEX IF NOT EXISTS releases_project_env_channel_updated_idx
         ON ${this.table("releases")}(project_key, environment, channel, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${this.table("builds")} (
         build_id TEXT PRIMARY KEY,
         release_id TEXT NOT NULL,
         project_key TEXT NOT NULL,
         environment TEXT NOT NULL,
         channel TEXT NOT NULL,
         status TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS builds_release_idx
         ON ${this.table("builds")}(release_id, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${this.table("artifacts")} (
         artifact_id TEXT PRIMARY KEY,
         build_id TEXT NOT NULL,
         release_id TEXT NOT NULL,
         project_key TEXT NOT NULL,
         artifact_type TEXT NOT NULL,
         created_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS artifacts_build_idx
         ON ${this.table("artifacts")}(build_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${this.table("channel_state")} (
         state_key TEXT PRIMARY KEY,
         project_key TEXT NOT NULL,
         environment TEXT NOT NULL,
         channel TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("release_relations")} (
         relation_id TEXT PRIMARY KEY,
         project_key TEXT NOT NULL,
         from_release_id TEXT NOT NULL,
         to_release_id TEXT NOT NULL,
         relation_type TEXT NOT NULL,
         created_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS release_relations_from_idx
         ON ${this.table("release_relations")}(project_key, from_release_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS release_relations_to_idx
         ON ${this.table("release_relations")}(project_key, to_release_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${this.table("build_provenance")} (
         build_id TEXT PRIMARY KEY,
         release_id TEXT NOT NULL,
         project_key TEXT NOT NULL,
         captured_at TEXT NOT NULL,
         provenance_hash TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("rollback_operations")} (
         rollback_id TEXT PRIMARY KEY,
         project_key TEXT NOT NULL,
         environment TEXT NOT NULL,
         channel TEXT NOT NULL,
         status TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("rollouts")} (
         rollout_id TEXT PRIMARY KEY,
         project_key TEXT NOT NULL,
         environment TEXT NOT NULL,
         channel TEXT NOT NULL,
         release_id TEXT NOT NULL,
         status TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS rollouts_project_env_channel_idx
         ON ${this.table("rollouts")}(project_key, environment, channel, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS rollouts_release_idx
         ON ${this.table("rollouts")}(release_id, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${this.table("operation_locks")} (
         lock_key TEXT PRIMARY KEY,
         project_key TEXT NOT NULL,
         environment TEXT NOT NULL,
         scope TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("event_logs")} (
         event_id TEXT PRIMARY KEY,
         project_key TEXT NOT NULL,
         object_type TEXT NOT NULL,
         object_id TEXT NOT NULL,
         event_type TEXT NOT NULL,
         created_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("callback_nonces")} (
         nonce_key TEXT PRIMARY KEY,
         scope TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("idempotency_receipts")} (
         receipt_key TEXT PRIMARY KEY,
         scope TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${this.table("notification_outbox")} (
         notification_id TEXT PRIMARY KEY,
         event_id TEXT NOT NULL,
         project_key TEXT NOT NULL,
         delivery_channel TEXT NOT NULL,
         event_type TEXT NOT NULL,
         status TEXT NOT NULL,
         dedupe_key TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedupe_uq
         ON ${this.table("notification_outbox")}(delivery_channel, dedupe_key)`,
      `CREATE INDEX IF NOT EXISTS notification_outbox_status_idx
         ON ${this.table("notification_outbox")}(status, updated_at ASC)`,
      `CREATE TABLE IF NOT EXISTS ${this.table("patch_baselines")} (
         baseline_id TEXT PRIMARY KEY,
         project_key TEXT NOT NULL,
         environment TEXT NOT NULL,
         channel TEXT NOT NULL,
         platform TEXT NOT NULL,
         created_at TEXT NOT NULL,
         record_json JSONB NOT NULL
       )`,
    ];
    for (const statement of statements) {
      await client.unsafe(statement);
    }
  }
}

export function createLobsterReleaseStore(
  input: string | LobsterReleaseStoreOptions,
): LobsterReleaseStoreApi {
  if (typeof input === "string") {
    return new LobsterReleaseStore(input);
  }
  if (input.driver === "postgres") {
    return new PostgresLobsterReleaseStore(input.connectionString, input.schema);
  }
  return new LobsterReleaseStore(input.sqlitePath);
}
