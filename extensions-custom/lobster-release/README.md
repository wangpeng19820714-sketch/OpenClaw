# Lobster Release

Custom OpenClaw extension workspace for a Godot release center.

Current state:

- `docs/` stores the product and technical design notes.
- Runtime code exists for release creation, Jenkins trigger, CI callback intake, manifest generation, approval, and rollback.
- OpenClaw local config can load the plugin from `configs/openclaw.json`.

Current integration contract:

- `lobster-release` actively triggers Jenkins `buildWithParameters`.
- Jenkins calls back to `lobster-release` through `/api/ci/v1/builds/resolve-baseline|start|publish|finish`.
- Jenkins CI auth uses `X-Lobster-*` HMAC headers.

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
