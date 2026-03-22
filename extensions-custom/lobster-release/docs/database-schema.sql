-- Lobster Release database schema
-- Target: PostgreSQL 15+
-- Notes:
-- 1. IDs use text to keep app-generated IDs portable.
-- 2. JSONB is used for flexible metadata and audit snapshots.
-- 3. Channels and environments are intentionally modeled as text + CHECK for easier evolution.

begin;

create table if not exists projects (
  project_id text primary key,
  project_key text not null unique,
  name text not null,
  engine text not null default 'godot',
  default_channel text not null default 'dev',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (default_channel in ('dev', 'beta', 'release'))
);

create table if not exists releases (
  release_id text primary key,
  project_id text not null references projects(project_id) on delete cascade,
  environment text not null default 'test',
  channel text not null,
  version text not null,
  display_version text,
  version_scheme text not null default 'semver3',
  version_major integer not null,
  version_minor integer not null,
  version_patch integer not null,
  version_prerelease text,
  version_buildmeta text,
  version_bump_type text not null,
  version_source text not null default 'manual',
  status text not null,
  stable boolean not null default false,
  frozen boolean not null default false,
  git_branch text,
  git_commit text,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  check (environment in ('test', 'staging', 'production')),
  check (channel in ('dev', 'beta', 'release')),
  check (version_bump_type in ('patch', 'minor', 'major')),
  check (version_source in ('manual', 'suggested', 'enforced')),
  check (status in ('draft', 'building', 'built', 'awaiting_approval', 'published', 'failed', 'rolled_back'))
);

create unique index if not exists releases_project_env_channel_version_uq
  on releases(project_id, environment, channel, version);

create index if not exists releases_project_env_channel_idx
  on releases(project_id, environment, channel, created_at desc);

create table if not exists builds (
  build_id text primary key,
  release_id text not null references releases(release_id) on delete cascade,
  project_id text not null references projects(project_id) on delete cascade,
  environment text not null default 'test',
  channel text not null,
  status text not null,
  result text,
  triggered_by text,
  trigger_source text not null default 'manual',
  source_git_url text,
  source_git_branch text,
  source_git_commit text,
  source_git_commit_short text,
  jenkins_job text,
  jenkins_build_number integer,
  jenkins_queue_id text,
  baseline_version text,
  baseline_manifest_url text,
  rebuild_of_build_id text references builds(build_id),
  idempotency_key text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (environment in ('test', 'staging', 'production')),
  check (channel in ('dev', 'beta', 'release')),
  check (status in ('queued', 'triggering', 'building', 'uploaded', 'finished', 'failed', 'canceled'))
);

create unique index if not exists builds_idempotency_uq
  on builds(project_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists builds_release_idx
  on builds(release_id, created_at desc);

create table if not exists artifacts (
  artifact_id text primary key,
  build_id text not null references builds(build_id) on delete cascade,
  release_id text not null references releases(release_id) on delete cascade,
  project_id text not null references projects(project_id) on delete cascade,
  environment text not null default 'test',
  channel text not null,
  artifact_type text not null,
  platform text not null,
  file_name text not null,
  file_size_bytes bigint not null default 0,
  sha256 text not null,
  storage_provider text not null,
  storage_bucket text,
  storage_path text not null,
  download_url text not null unique,
  manifest_role text,
  immutable boolean not null default true,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (environment in ('test', 'staging', 'production')),
  check (channel in ('dev', 'beta', 'release')),
  check (artifact_type in ('android_apk', 'android_aab', 'macos_zip', 'patch_bundle', 'patch_manifest', 'patch_list', 'build_report', 'bundle_layout', 'manifest', 'sha256'))
);

create unique index if not exists artifacts_build_type_uq
  on artifacts(build_id, artifact_type, file_name);

create index if not exists artifacts_release_idx
  on artifacts(release_id, artifact_type);

create table if not exists patch_baselines (
  baseline_id text primary key,
  project_id text not null references projects(project_id) on delete cascade,
  environment text not null default 'test',
  channel text not null,
  platform text not null,
  from_release_id text references releases(release_id),
  to_release_id text references releases(release_id),
  from_version text not null,
  to_version text not null,
  baseline_manifest_url text not null,
  patch_manifest_url text,
  compatibility_rule text not null default 'validate',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  check (environment in ('test', 'staging', 'production')),
  check (channel in ('dev', 'beta', 'release')),
  check (compatibility_rule in ('reuse', 'validate', 'reset')),
  check (status in ('active', 'deprecated', 'blocked'))
);

create index if not exists patch_baselines_project_idx
  on patch_baselines(project_id, environment, channel, platform, created_at desc);

create table if not exists release_channel_state (
  project_id text not null references projects(project_id) on delete cascade,
  environment text not null,
  channel text not null,
  current_release_id text references releases(release_id),
  previous_release_id text references releases(release_id),
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (project_id, environment, channel),
  check (environment in ('test', 'staging', 'production')),
  check (channel in ('dev', 'beta', 'release'))
);

create table if not exists release_relations (
  relation_id text primary key,
  project_id text not null references projects(project_id) on delete cascade,
  from_release_id text not null references releases(release_id) on delete cascade,
  to_release_id text not null references releases(release_id) on delete cascade,
  relation_type text not null,
  context_json jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  check (relation_type in ('derived_from', 'patch_based_on', 'promoted_from', 'rolled_back_to', 'rebuilt_from', 'replaced_by'))
);

create index if not exists release_relations_from_idx
  on release_relations(project_id, from_release_id);

create index if not exists release_relations_to_idx
  on release_relations(project_id, to_release_id);

create index if not exists release_relations_type_idx
  on release_relations(project_id, relation_type, created_at desc);

create table if not exists build_provenance (
  provenance_id text primary key,
  build_id text not null unique references builds(build_id) on delete cascade,
  release_id text not null references releases(release_id) on delete cascade,
  source_git_url text,
  source_git_branch text,
  source_git_commit text,
  source_git_commit_short text,
  source_git_tag text,
  workspace_revision text,
  jenkins_job text,
  jenkins_build_number integer,
  jenkins_queue_id text,
  executor_node text,
  executor_label text,
  godot_version text,
  godot_bin text,
  dotnet_version text,
  export_presets jsonb not null default '[]'::jsonb,
  build_targets jsonb not null default '[]'::jsonb,
  baseline_version text,
  baseline_manifest_url text,
  config_fingerprint text,
  asset_groups_fingerprint text,
  scripts_fingerprint text,
  env_snapshot_json jsonb not null default '{}'::jsonb,
  parameters_json jsonb not null default '{}'::jsonb,
  provenance_hash text not null,
  captured_at timestamptz not null default now()
);

create index if not exists build_provenance_release_idx
  on build_provenance(release_id, captured_at desc);

create table if not exists rollback_operations (
  rollback_id text primary key,
  project_id text not null references projects(project_id) on delete cascade,
  environment text not null,
  channel text not null,
  from_release_id text not null references releases(release_id),
  to_release_id text not null references releases(release_id),
  status text not null,
  reason text not null,
  triggered_by text not null,
  approved_by text,
  strategy text not null,
  manifest_action jsonb not null default '{}'::jsonb,
  freeze_current_release boolean not null default true,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (environment in ('test', 'staging', 'production')),
  check (channel in ('dev', 'beta', 'release')),
  check (status in ('requested', 'approved', 'executing', 'completed', 'failed', 'canceled')),
  check (strategy in ('pointer_switch', 'manifest_republish', 'rebuild_and_publish'))
);

create index if not exists rollback_operations_channel_idx
  on rollback_operations(project_id, environment, channel, created_at desc);

create table if not exists operation_locks (
  lock_id text primary key,
  project_id text not null references projects(project_id) on delete cascade,
  environment text not null,
  lock_scope text not null,
  lock_key text not null,
  owner text not null,
  reason text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (environment in ('test', 'staging', 'production')),
  check (lock_scope in ('channel', 'release', 'build', 'rollback'))
);

create unique index if not exists operation_locks_scope_uq
  on operation_locks(project_id, environment, lock_scope, lock_key);

create table if not exists event_logs (
  event_id text primary key,
  project_id text not null references projects(project_id) on delete cascade,
  environment text,
  object_type text not null,
  object_id text not null,
  event_type text not null,
  request_id text,
  idempotency_key text,
  payload_json jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists event_logs_object_idx
  on event_logs(project_id, object_type, object_id, created_at desc);

create index if not exists event_logs_request_idx
  on event_logs(project_id, request_id)
  where request_id is not null;

commit;
