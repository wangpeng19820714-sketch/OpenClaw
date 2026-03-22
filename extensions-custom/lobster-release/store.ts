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

export class LobsterReleaseStore {
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

  getProject(projectKey: string): ProjectRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM projects WHERE project_key = ?")
      .get(projectKey) as JsonRow | undefined;
    return parseJson<ProjectRecord>(row?.record_json);
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

  getRelease(releaseId: string): ReleaseRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM releases WHERE release_id = ?")
      .get(releaseId) as JsonRow | undefined;
    return parseJson<ReleaseRecord>(row?.record_json);
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

  getBuild(buildId: string): BuildRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM builds WHERE build_id = ?")
      .get(buildId) as JsonRow | undefined;
    return parseJson<BuildRecord>(row?.record_json);
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

  listArtifactsForBuild(buildId: string): ArtifactRecord[] {
    const rows = this.getDb()
      .prepare("SELECT record_json FROM artifacts WHERE build_id = ? ORDER BY created_at ASC")
      .all(buildId) as JsonRow[];
    return rows
      .map((row) => parseJson<ArtifactRecord>(row.record_json))
      .filter((row): row is ArtifactRecord => Boolean(row));
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

  getBuildProvenance(buildId: string): BuildProvenanceRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM build_provenance WHERE build_id = ?")
      .get(buildId) as JsonRow | undefined;
    return parseJson<BuildProvenanceRecord>(row?.record_json);
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

  getRollback(rollbackId: string): RollbackOperationRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM rollback_operations WHERE rollback_id = ?")
      .get(rollbackId) as JsonRow | undefined;
    return parseJson<RollbackOperationRecord>(row?.record_json);
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

  getNotification(notificationId: string): NotificationOutboxRecord | null {
    const row = this.getDb()
      .prepare("SELECT record_json FROM notification_outbox WHERE notification_id = ?")
      .get(notificationId) as JsonRow | undefined;
    return parseJson<NotificationOutboxRecord>(row?.record_json);
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

  releaseLock(lockKey: string): void {
    this.getDb().prepare("DELETE FROM operation_locks WHERE lock_key = ?").run(lockKey);
  }

  purgeExpiredLocks(): void {
    this.getDb().prepare("DELETE FROM operation_locks WHERE expires_at <= ?").run(nowIso());
  }
}
