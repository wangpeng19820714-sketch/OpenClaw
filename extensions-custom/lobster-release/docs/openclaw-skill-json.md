# OpenClaw Integration JSON

## 1. Note

OpenClaw skills themselves are Markdown-based, not JSON-only. This document focuses on the JSON side needed for `lobster-release` integration:

- plugin manifest proposal
- tool contracts
- agent configuration examples

## 2. Proposed `openclaw.plugin.json`

```json
{
  "id": "lobster-release",
  "name": "Lobster Release",
  "description": "Release center for Godot build, patch, rollback, and approval workflows.",
  "version": "0.1.0",
  "tools": [
    "release_create",
    "release_status",
    "release_graph",
    "release_provenance",
    "release_approve",
    "release_rollback"
  ],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "baseUrl": {
        "type": "string"
      },
      "apiToken": {
        "type": "string"
      },
      "defaultProjectKey": {
        "type": "string"
      },
      "defaultEnvironment": {
        "type": "string",
        "enum": ["test", "staging", "production"]
      },
      "defaultChannel": {
        "type": "string",
        "enum": ["dev", "beta", "release"]
      }
    },
    "required": ["baseUrl", "apiToken", "defaultProjectKey"]
  }
}
```

## 3. Tool Input JSON

### 3.1 `release_create`

```json
{
  "projectKey": "gamexpert",
  "environment": "staging",
  "channel": "beta",
  "version": "1.2.3",
  "git": {
    "branch": "main",
    "commit": "8de107b1234567890"
  },
  "targets": {
    "androidApk": true,
    "macosApp": true,
    "patch": true
  },
  "triggerBuild": true
}
```

### 3.2 `release_status`

```json
{
  "projectKey": "gamexpert",
  "environment": "staging",
  "channel": "beta"
}
```

### 3.3 `release_graph`

```json
{
  "projectKey": "gamexpert",
  "releaseId": "rel_20260322_001",
  "direction": "both",
  "depth": 3
}
```

### 3.4 `release_provenance`

```json
{
  "projectKey": "gamexpert",
  "buildId": "bld_20260322_001"
}
```

### 3.5 `release_approve`

```json
{
  "projectKey": "gamexpert",
  "releaseId": "rel_20260322_001",
  "comment": "approved after smoke test"
}
```

### 3.6 `release_rollback`

```json
{
  "projectKey": "gamexpert",
  "environment": "production",
  "channel": "release",
  "targetReleaseId": "rel_20260318_002",
  "strategy": "pointer_switch",
  "reason": "client hotupdate loading failure"
}
```

## 4. Agent Configuration Example

```json
{
  "plugins": {
    "entries": {
      "lobster-release": {
        "enabled": true,
        "config": {
          "baseUrl": "https://release.example.com/api",
          "apiToken": "${LOBSTER_RELEASE_TOKEN}",
          "defaultProjectKey": "gamexpert",
          "defaultEnvironment": "staging",
          "defaultChannel": "beta"
        }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "release-manager",
        "tools": {
          "alsoAllow": ["release_create", "release_status", "release_graph", "release_provenance"]
        }
      },
      {
        "id": "release-ops",
        "tools": {
          "alsoAllow": ["release_approve", "release_rollback"]
        }
      }
    ]
  }
}
```

## 5. Suggested Skill Behaviors

The skill layer should teach the agent to:

- ask for project, environment, channel, version, and target platforms
- check current channel state before creating a release
- inspect graph and provenance before recommending rollback
- require confirmation before `release` publish or production rollback
