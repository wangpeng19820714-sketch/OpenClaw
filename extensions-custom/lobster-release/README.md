# Lobster Release

Custom OpenClaw plugin workspace for a Godot release center.

## Install on another OpenClaw

If this package is published to npm, another OpenClaw host can install it with:

```bash
openclaw plugins install @openclaw/lobster-release
openclaw plugins enable lobster-release
```

Then restart the gateway and configure:

- `plugins.entries.lobster-release.enabled=true`
- `plugins.entries.lobster-release.config.*`

Current package shape is compatible with OpenClaw's npm plugin installer:

- `package.json` includes `openclaw.extensions`
- `openclaw.plugin.json` provides manifest + config schema
- runtime dependencies are declared in `dependencies`
- package publish boundary is limited through `files`
- optional host compatibility is declared through `peerDependencies.openclaw`

If you do not control the `@openclaw` npm scope, rename these fields before publishing your fork:

- `package.json.name`
- `package.json.openclaw.install.npmSpec`

Current state:

- `docs/` stores the product and technical design notes.
- Runtime code exists for release creation, Jenkins trigger, CI callback intake, manifest generation, approval, and rollback.
- Runtime also includes rollout controls for gray release experiments and channel route resolution.
- Runtime also supports release maintenance, retention cleanup, and store status inspection.
- OpenClaw local config can load the plugin from `configs/openclaw.json`.

Current integration contract:

- `lobster-release` actively triggers Jenkins `buildWithParameters`.
- Jenkins calls back to `lobster-release` through `/api/ci/v1/builds/resolve-baseline|start|publish|finish`.
- Jenkins CI auth uses `X-Lobster-*` HMAC headers.
- Jenkins callbacks may optionally include `environmentInfo` metadata to archive Godot/export/config/script fingerprints into build provenance.

## Publish as an npm plugin

From `extensions-custom/lobster-release`:

```bash
npm publish --access public
```

Recommended release checklist:

1. Confirm the final npm package name and scope.
2. Confirm `openclaw.install.npmSpec` matches the published package.
3. Confirm `openclaw.plugin.json` still exposes the intended plugin id: `lobster-release`.
4. Confirm sensitive defaults are still injected through `.env` or target host config, not committed package files.
5. Confirm the target OpenClaw host can reach PostgreSQL and Jenkins.

Before real end-to-end testing, fill these `configs/openclaw.json` values:

- `plugins.entries.lobster-release.config.publicBaseUrl`
- `plugins.entries.lobster-release.config.ciApiKey`
- `plugins.entries.lobster-release.config.ciApiSecret`
- `plugins.entries.lobster-release.config.jenkinsUser`
- `plugins.entries.lobster-release.config.jenkinsApiToken`

If Android export signing is required, also fill:

- `plugins.entries.lobster-release.config.jenkinsAndroidKeystoreBase64CredentialsId`
- `plugins.entries.lobster-release.config.jenkinsAndroidKeystoreAliasCredentialsId`
- `plugins.entries.lobster-release.config.jenkinsAndroidKeystorePasswordCredentialsId`

If Jenkins should execute the publish callback, also fill:

- `plugins.entries.lobster-release.config.uploadDestinationDir`
- `plugins.entries.lobster-release.config.uploadBaseUrl`

For local integration, `uploadBaseUrl` can point back to the gateway, for example:

- `http://127.0.0.1:18789/plugins/lobster-release/api/uploads`
