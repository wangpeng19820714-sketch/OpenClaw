# Feishu Card Templates

## 1. Build Started Card

```json
{
  "msg_type": "interactive",
  "card": {
    "config": {
      "wide_screen_mode": true
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "Lobster Release: Build Started"
      },
      "template": "blue"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**Project**: gamexpert\n**Env**: staging\n**Channel**: beta\n**Version**: 1.2.3"
        }
      },
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**Release ID**: rel_20260322_001\n**Build ID**: bld_20260322_001\n**Commit**: 8de107b"
        }
      }
    ]
  }
}
```

## 2. Awaiting Approval Card

```json
{
  "msg_type": "interactive",
  "card": {
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "Lobster Release: Approval Required"
      },
      "template": "orange"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**Project**: gamexpert\n**Env**: staging\n**Channel**: beta\n**Version**: 1.2.3"
        }
      },
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**Artifacts**: android_apk, macos_zip, patch_bundle\n**Patch Baseline**: 1.2.2\n**Risk**: medium"
        }
      },
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": {
              "tag": "plain_text",
              "content": "Approve"
            },
            "type": "primary",
            "value": {
              "action": "approve_release",
              "releaseId": "rel_20260322_001"
            }
          },
          {
            "tag": "button",
            "text": {
              "tag": "plain_text",
              "content": "Reject"
            },
            "type": "default",
            "value": {
              "action": "reject_release",
              "releaseId": "rel_20260322_001"
            }
          }
        ]
      }
    ]
  }
}
```

## 3. Publish Success Card

```json
{
  "msg_type": "interactive",
  "card": {
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "Lobster Release: Published"
      },
      "template": "green"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**Project**: gamexpert\n**Env**: production\n**Channel**: release\n**Version**: 1.2.3"
        }
      },
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**Current Release**: rel_20260322_001\n**Manifest**: [open](https://cdn.example.com/gamexpert/production/release/1.2.3/release_manifest.json)"
        }
      }
    ]
  }
}
```

## 4. Rollback Alert Card

```json
{
  "msg_type": "interactive",
  "card": {
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "Lobster Release: Rollback Executed"
      },
      "template": "red"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**Env**: production\n**Channel**: release\n**From**: 1.2.3\n**To**: 1.2.2"
        }
      },
      {
        "tag": "div",
        "text": {
          "tag": "lark_md",
          "content": "**Strategy**: pointer_switch\n**Frozen Release**: rel_20260322_001\n**Reason**: hotupdate loading failure"
        }
      }
    ]
  }
}
```
