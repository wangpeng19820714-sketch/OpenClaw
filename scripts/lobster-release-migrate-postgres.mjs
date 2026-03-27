#!/usr/bin/env -S node --import tsx

import * as path from "node:path";
import { createPostgresClient } from "../extensions-custom/lobster-release/postgres.runtime.ts";
import { requireNodeSqlite } from "../src/memory/sqlite.js";

const TABLE_MIGRATIONS = [
  {
    tableName: "schema_meta",
    selectSql: "SELECT meta_key, record_json FROM schema_meta",
    insertSql: `INSERT INTO {schema}."schema_meta" (meta_key, record_json)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (meta_key) DO UPDATE SET record_json = EXCLUDED.record_json`,
    mapRow: (row) => [readString(row.meta_key), readJsonText(row.record_json)],
  },
  {
    tableName: "projects",
    selectSql: "SELECT project_key, updated_at, record_json FROM projects",
    insertSql: `INSERT INTO {schema}."projects" (project_key, updated_at, record_json)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (project_key) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.project_key),
      readString(row.updated_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "releases",
    selectSql:
      "SELECT release_id, project_key, environment, channel, version, status, stable, frozen, updated_at, record_json FROM releases",
    insertSql: `INSERT INTO {schema}."releases" (
        release_id, project_key, environment, channel, version, status, stable, frozen, updated_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (release_id) DO UPDATE SET
        status = EXCLUDED.status,
        stable = EXCLUDED.stable,
        frozen = EXCLUDED.frozen,
        updated_at = EXCLUDED.updated_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.release_id),
      readString(row.project_key),
      readString(row.environment),
      readString(row.channel),
      readString(row.version),
      readString(row.status),
      asBoolean(row.stable),
      asBoolean(row.frozen),
      readString(row.updated_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "builds",
    selectSql:
      "SELECT build_id, release_id, project_key, environment, channel, status, updated_at, record_json FROM builds",
    insertSql: `INSERT INTO {schema}."builds" (
        build_id, release_id, project_key, environment, channel, status, updated_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (build_id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.build_id),
      readString(row.release_id),
      readString(row.project_key),
      readString(row.environment),
      readString(row.channel),
      readString(row.status),
      readString(row.updated_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "artifacts",
    selectSql:
      "SELECT artifact_id, build_id, release_id, project_key, artifact_type, created_at, record_json FROM artifacts",
    insertSql: `INSERT INTO {schema}."artifacts" (
        artifact_id, build_id, release_id, project_key, artifact_type, created_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (artifact_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.artifact_id),
      readString(row.build_id),
      readString(row.release_id),
      readString(row.project_key),
      readString(row.artifact_type),
      readString(row.created_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "channel_state",
    selectSql:
      "SELECT state_key, project_key, environment, channel, updated_at, record_json FROM channel_state",
    insertSql: `INSERT INTO {schema}."channel_state" (
        state_key, project_key, environment, channel, updated_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (state_key) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.state_key),
      readString(row.project_key),
      readString(row.environment),
      readString(row.channel),
      readString(row.updated_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "release_relations",
    selectSql:
      "SELECT relation_id, project_key, from_release_id, to_release_id, relation_type, created_at, record_json FROM release_relations",
    insertSql: `INSERT INTO {schema}."release_relations" (
        relation_id, project_key, from_release_id, to_release_id, relation_type, created_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (relation_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.relation_id),
      readString(row.project_key),
      readString(row.from_release_id),
      readString(row.to_release_id),
      readString(row.relation_type),
      readString(row.created_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "build_provenance",
    selectSql:
      "SELECT build_id, release_id, project_key, captured_at, provenance_hash, record_json FROM build_provenance",
    insertSql: `INSERT INTO {schema}."build_provenance" (
        build_id, release_id, project_key, captured_at, provenance_hash, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (build_id) DO UPDATE SET
        captured_at = EXCLUDED.captured_at,
        provenance_hash = EXCLUDED.provenance_hash,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.build_id),
      readString(row.release_id),
      readString(row.project_key),
      readString(row.captured_at),
      readString(row.provenance_hash),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "rollback_operations",
    selectSql:
      "SELECT rollback_id, project_key, environment, channel, status, updated_at, record_json FROM rollback_operations",
    insertSql: `INSERT INTO {schema}."rollback_operations" (
        rollback_id, project_key, environment, channel, status, updated_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (rollback_id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.rollback_id),
      readString(row.project_key),
      readString(row.environment),
      readString(row.channel),
      readString(row.status),
      readString(row.updated_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "rollouts",
    selectSql:
      "SELECT rollout_id, project_key, environment, channel, release_id, status, updated_at, record_json FROM rollouts",
    insertSql: `INSERT INTO {schema}."rollouts" (
        rollout_id, project_key, environment, channel, release_id, status, updated_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (rollout_id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.rollout_id),
      readString(row.project_key),
      readString(row.environment),
      readString(row.channel),
      readString(row.release_id),
      readString(row.status),
      readString(row.updated_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "operation_locks",
    selectSql:
      "SELECT lock_key, project_key, environment, scope, expires_at, record_json FROM operation_locks",
    insertSql: `INSERT INTO {schema}."operation_locks" (
        lock_key, project_key, environment, scope, expires_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (lock_key) DO UPDATE SET
        expires_at = EXCLUDED.expires_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.lock_key),
      readString(row.project_key),
      readString(row.environment),
      readString(row.scope),
      readString(row.expires_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "event_logs",
    selectSql:
      "SELECT event_id, project_key, object_type, object_id, event_type, created_at, record_json FROM event_logs",
    insertSql: `INSERT INTO {schema}."event_logs" (
        event_id, project_key, object_type, object_id, event_type, created_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (event_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.event_id),
      readString(row.project_key),
      readString(row.object_type),
      readString(row.object_id),
      readString(row.event_type),
      readString(row.created_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "callback_nonces",
    selectSql: "SELECT nonce_key, scope, expires_at, record_json FROM callback_nonces",
    insertSql: `INSERT INTO {schema}."callback_nonces" (
        nonce_key, scope, expires_at, record_json
      ) VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (nonce_key) DO NOTHING`,
    mapRow: (row) => [
      readString(row.nonce_key),
      readString(row.scope),
      readString(row.expires_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "idempotency_receipts",
    selectSql:
      "SELECT receipt_key, scope, created_at, updated_at, record_json FROM idempotency_receipts",
    insertSql: `INSERT INTO {schema}."idempotency_receipts" (
        receipt_key, scope, created_at, updated_at, record_json
      ) VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (receipt_key) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.receipt_key),
      readString(row.scope),
      readString(row.created_at),
      readString(row.updated_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "notification_outbox",
    selectSql:
      "SELECT notification_id, event_id, project_key, delivery_channel, event_type, status, dedupe_key, created_at, updated_at, record_json FROM notification_outbox",
    insertSql: `INSERT INTO {schema}."notification_outbox" (
        notification_id, event_id, project_key, delivery_channel, event_type, status, dedupe_key, created_at, updated_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (notification_id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.notification_id),
      readString(row.event_id),
      readString(row.project_key),
      readString(row.delivery_channel),
      readString(row.event_type),
      readString(row.status),
      readString(row.dedupe_key),
      readString(row.created_at),
      readString(row.updated_at),
      readJsonText(row.record_json),
    ],
  },
  {
    tableName: "patch_baselines",
    selectSql:
      "SELECT baseline_id, project_key, environment, channel, platform, created_at, record_json FROM patch_baselines",
    insertSql: `INSERT INTO {schema}."patch_baselines" (
        baseline_id, project_key, environment, channel, platform, created_at, record_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (baseline_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
    mapRow: (row) => [
      readString(row.baseline_id),
      readString(row.project_key),
      readString(row.environment),
      readString(row.channel),
      readString(row.platform),
      readString(row.created_at),
      readJsonText(row.record_json),
    ],
  },
];

function usage() {
  return [
    "Usage:",
    "  node scripts/lobster-release-migrate-postgres.mjs \\",
    "    --sqlite-path <path/to/lobster-release.sqlite> \\",
    "    --postgres-url <postgres://user:pass@host:5432/db> \\",
    "    [--schema lobster_release] [--truncate] [--dry-run]",
    "",
    "Env fallbacks:",
    "  LOBSTER_SQLITE_PATH",
    "  LOBSTER_POSTGRES_URL",
    "  LOBSTER_POSTGRES_SCHEMA",
  ].join("\n");
}

function readString(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

function readJsonText(value) {
  const text = readString(value);
  JSON.parse(text);
  return text;
}

function asBoolean(value) {
  return value === true || value === 1 || value === "1";
}

function requireArg(value, name) {
  if (value && value.trim()) {
    return value.trim();
  }
  throw new Error(`missing required ${name}\n\n${usage()}`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}\n\n${usage()}`);
    }
    const key = token.slice(2);
    if (key === "help") {
      console.log(usage());
      globalThis.process.exit(0);
    }
    if (key === "truncate" || key === "dry-run") {
      result[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for --${key}\n\n${usage()}`);
    }
    result[key] = next;
    index += 1;
  }
  return {
    sqlitePath: requireArg(
      result["sqlite-path"] ?? globalThis.process.env.LOBSTER_SQLITE_PATH,
      "--sqlite-path",
    ),
    postgresUrl: requireArg(
      result["postgres-url"] ?? globalThis.process.env.LOBSTER_POSTGRES_URL,
      "--postgres-url",
    ),
    schema: result.schema ?? globalThis.process.env.LOBSTER_POSTGRES_SCHEMA ?? "lobster_release",
    truncate: result.truncate === true,
    dryRun: result["dry-run"] === true,
  };
}

function quoteSchema(schema) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`invalid PostgreSQL schema: ${schema}`);
  }
  return `"${schema}"`;
}

async function ensurePostgresBootstrap(postgresUrl, schema) {
  const { createLobsterReleaseStore } =
    await import("../extensions-custom/lobster-release/store.ts");
  const store = createLobsterReleaseStore({
    driver: "postgres",
    connectionString: postgresUrl,
    schema,
  });
  await store.load();
  store.close();
}

async function main() {
  const args = parseArgs(globalThis.process.argv.slice(2));
  const sqlitePath = path.resolve(args.sqlitePath);
  const { DatabaseSync } = requireNodeSqlite();
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const schema = quoteSchema(args.schema);
  const sql = createPostgresClient(args.postgresUrl);

  try {
    await ensurePostgresBootstrap(args.postgresUrl, args.schema);
    const summary = [];
    if (args.truncate && !args.dryRun) {
      for (const table of [...TABLE_MIGRATIONS].toReversed()) {
        await sql.unsafe(`TRUNCATE TABLE ${schema}."${table.tableName}" RESTART IDENTITY CASCADE`);
      }
    }
    for (const table of TABLE_MIGRATIONS) {
      const rows = sqlite.prepare(table.selectSql).all();
      summary.push({ tableName: table.tableName, rows: rows.length });
      if (args.dryRun || rows.length === 0) {
        continue;
      }
      const query = table.insertSql.split("{schema}").join(schema);
      for (const row of rows) {
        await sql.unsafe(query, table.mapRow(row));
      }
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          sqlitePath,
          postgresSchema: args.schema,
          truncate: args.truncate,
          dryRun: args.dryRun,
          tables: summary,
        },
        null,
        2,
      ),
    );
  } finally {
    sqlite.close();
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  globalThis.process.exitCode = 1;
});
