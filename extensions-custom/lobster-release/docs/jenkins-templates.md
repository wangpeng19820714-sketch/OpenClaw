# Jenkins Templates

## 1. Trigger Flow

Recommended flow:

1. `lobster-release` creates release and build
2. `lobster-release` calls Jenkins `buildWithParameters`
3. Jenkins uses the existing `LOBSTER_*` callbacks to query baseline and report state
4. Jenkins executes build
5. Jenkins callbacks `start`, `publish`, `finish`

## 2. Jenkins Trigger Example

```bash
curl -X POST \
  "https://jenkins.example.com/job/GameXpert_Godot_CI/buildWithParameters" \
  --user "lobster-release:${JENKINS_API_TOKEN}" \
  --data-urlencode "GIT_URL=git@github.com:example/GameXpert_Godot.git" \
  --data-urlencode "GIT_BRANCH=main" \
  --data-urlencode "GIT_COMMIT=8de107b1234567890" \
  --data-urlencode "BUILD_ANDROID_APK=true" \
  --data-urlencode "BUILD_ANDROID_AAB=false" \
  --data-urlencode "BUILD_MACOS_APP=true" \
  --data-urlencode "BUILD_PATCH=true" \
  --data-urlencode "BUILD_TARGETS=android_apk,macos_app,patch" \
  --data-urlencode "APP_VERSION=1.2.3" \
  --data-urlencode "RESOURCE_VERSION=1.2.3" \
  --data-urlencode "LOBSTER_RESOLVE_BASELINE=true" \
  --data-urlencode "LOBSTER_NOTIFY_BUILD_START=true" \
  --data-urlencode "LOBSTER_NOTIFY_PUBLISH=true" \
  --data-urlencode "LOBSTER_NOTIFY_BUILD_FINISH=true" \
  --data-urlencode "LOBSTER_API_BASE_URL=https://release.example.com" \
  --data-urlencode "LOBSTER_CHANNEL=beta" \
  --data-urlencode "LOBSTER_PLATFORM=android" \
  --data-urlencode "LOBSTER_ENDPOINT_RESOLVE_BASELINE=/api/ci/v1/builds/resolve-baseline" \
  --data-urlencode "LOBSTER_ENDPOINT_BUILD_START=/api/ci/v1/builds/start" \
  --data-urlencode "LOBSTER_ENDPOINT_PUBLISH=/api/ci/v1/builds/publish" \
  --data-urlencode "LOBSTER_ENDPOINT_FINISH=/api/ci/v1/builds/finish" \
  --data-urlencode "LOBSTER_API_KEY_CREDENTIALS_ID=lobster-api-key" \
  --data-urlencode "LOBSTER_API_SECRET_CREDENTIALS_ID=lobster-api-secret"
```

## 3. Jenkinsfile Parameter Template

```groovy
pipeline {
  agent none

  parameters {
    string(name: 'GIT_URL', defaultValue: '')
    string(name: 'GIT_BRANCH', defaultValue: 'main')
    string(name: 'GIT_COMMIT', defaultValue: '')

    booleanParam(name: 'BUILD_ANDROID_APK', defaultValue: true)
    booleanParam(name: 'BUILD_ANDROID_AAB', defaultValue: false)
    booleanParam(name: 'BUILD_MACOS_APP', defaultValue: false)
    booleanParam(name: 'BUILD_PATCH', defaultValue: true)

    text(name: 'BUILD_TARGETS', defaultValue: '')
    string(name: 'APP_VERSION', defaultValue: '1.2.3')
    string(name: 'RESOURCE_VERSION', defaultValue: '1.2.3')

    booleanParam(name: 'LOBSTER_RESOLVE_BASELINE', defaultValue: true)
    booleanParam(name: 'LOBSTER_NOTIFY_BUILD_START', defaultValue: true)
    booleanParam(name: 'LOBSTER_NOTIFY_PUBLISH', defaultValue: true)
    booleanParam(name: 'LOBSTER_NOTIFY_BUILD_FINISH', defaultValue: true)
    string(name: 'LOBSTER_API_BASE_URL', defaultValue: 'https://release.example.com')
    string(name: 'LOBSTER_CHANNEL', defaultValue: 'beta')
    string(name: 'LOBSTER_PLATFORM', defaultValue: 'android')
    string(name: 'LOBSTER_ENDPOINT_RESOLVE_BASELINE', defaultValue: '/api/ci/v1/builds/resolve-baseline')
    string(name: 'LOBSTER_ENDPOINT_BUILD_START', defaultValue: '/api/ci/v1/builds/start')
    string(name: 'LOBSTER_ENDPOINT_PUBLISH', defaultValue: '/api/ci/v1/builds/publish')
    string(name: 'LOBSTER_ENDPOINT_FINISH', defaultValue: '/api/ci/v1/builds/finish')
    string(name: 'LOBSTER_API_KEY_CREDENTIALS_ID', defaultValue: 'lobster-api-key')
    string(name: 'LOBSTER_API_SECRET_CREDENTIALS_ID', defaultValue: 'lobster-api-secret')
  }
}
```

## 4. Recommended Environment Variables

```text
LOBSTER_RELEASE_PROJECT_KEY=gamexpert
LOBSTER_RELEASE_ENVIRONMENT=staging
GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot
GRADLE_USER_HOME=/Users/jenkins/.gradle
UPLOAD_DESTINATION_DIR=/mnt/artifacts/gamexpert
```

## 4.1 Plugin Config Needed In OpenClaw

`lobster-release` currently needs these plugin config keys to match the Jenkins scripts:

```json
{
  "defaultProjectKey": "gamexpert",
  "publicBaseUrl": "https://release.example.com",
  "ciRoutePrefix": "/api/ci/v1",
  "ciApiKey": "lobster-api-key-value",
  "ciApiSecret": "lobster-api-secret-value",
  "jenkinsBaseUrl": "https://jenkins.example.com",
  "jenkinsJob": "GameXpert_Godot_CI",
  "jenkinsLobsterApiKeyCredentialsId": "lobster-api-key",
  "jenkinsLobsterApiSecretCredentialsId": "lobster-api-secret"
}
```

## 5. Callback Shell Template

### 5.1 Shared HMAC Helper

```bash
generate_signature() {
  local body_file="$1"
  local ts="$2"
  local nonce="$3"
  local payload
  payload="$(printf '%s\n%s\n' "$ts" "$nonce"; cat "$body_file")"
  printf '%s' "$payload" \
    | openssl dgst -sha256 -hmac "$CALLBACK_TOKEN" -binary \
    | xxd -p -c 256
}
```

### 5.2 Build Start Callback

```bash
callback_build_start() {
  local body_file
  local ts nonce sig
  body_file="$(mktemp)"
  ts="$(date +%s)"
  nonce="$(uuidgen | tr 'A-Z' 'a-z')"

  cat >"$body_file" <<EOF
{
  "jenkinsJob": "${JOB_NAME}",
  "jenkinsBuildNumber": ${BUILD_NUMBER},
  "jenkinsQueueId": "${QUEUE_ID:-}",
  "executorNode": "${NODE_NAME:-}",
  "executorLabel": "${NODE_LABELS:-}",
  "startedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

  sig="$(generate_signature "$body_file" "$ts" "$nonce")"

  curl -X POST "${CALLBACK_BASE_URL}/start" \
    -H "Content-Type: application/json" \
    -H "X-Request-Id: jenkins-${BUILD_ID}-start" \
    -H "X-Idempotency-Key: ${BUILD_ID}:start" \
    -H "X-Timestamp: ${ts}" \
    -H "X-Nonce: ${nonce}" \
    -H "X-Signature: sha256=${sig}" \
    --data @"$body_file"
}
```

### 5.3 Publish Callback

```bash
callback_publish() {
  local body_file
  local ts nonce sig
  body_file="$(mktemp)"
  ts="$(date +%s)"
  nonce="$(uuidgen | tr 'A-Z' 'a-z')"

  cat >"$body_file" <<EOF
{
  "environment": "${LOBSTER_RELEASE_ENVIRONMENT}",
  "channel": "${LOBSTER_RELEASE_CHANNEL}",
  "artifacts": $(cat build/jenkins/reports/uploaded_artifacts.json)
}
EOF

  sig="$(generate_signature "$body_file" "$ts" "$nonce")"

  curl -X POST "${CALLBACK_BASE_URL}/publish" \
    -H "Content-Type: application/json" \
    -H "X-Request-Id: jenkins-${BUILD_ID}-publish" \
    -H "X-Idempotency-Key: ${BUILD_ID}:publish" \
    -H "X-Timestamp: ${ts}" \
    -H "X-Nonce: ${nonce}" \
    -H "X-Signature: sha256=${sig}" \
    --data @"$body_file"
}
```

### 5.4 Finish Callback

```bash
callback_finish() {
  local body_file
  local ts nonce sig
  body_file="$(mktemp)"
  ts="$(date +%s)"
  nonce="$(uuidgen | tr 'A-Z' 'a-z')"

  cat >"$body_file" <<EOF
{
  "status": "success",
  "summary": "build completed",
  "durationSeconds": ${BUILD_DURATION_SECONDS:-0},
  "reports": {
    "buildReportUrl": "${BUILD_REPORT_URL:-}"
  },
  "artifactsCount": ${ARTIFACTS_COUNT:-0},
  "error": null
}
EOF

  sig="$(generate_signature "$body_file" "$ts" "$nonce")"

  curl -X POST "${CALLBACK_BASE_URL}/finish" \
    -H "Content-Type: application/json" \
    -H "X-Request-Id: jenkins-${BUILD_ID}-finish" \
    -H "X-Idempotency-Key: ${BUILD_ID}:finish" \
    -H "X-Timestamp: ${ts}" \
    -H "X-Nonce: ${nonce}" \
    -H "X-Signature: sha256=${sig}" \
    --data @"$body_file"
}
```

## 6. Recommended Jenkins Stages

- Source
- Prepare
- Build Android
- Build macOS
- Build Patch
- Upload
- Callback Publish
- Callback Finish

## 7. Required Output Files

Jenkins should produce at least:

- `build/jenkins/reports/uploaded_artifacts.json`
- `build/jenkins/reports/build_report.json`
- `build/jenkins/reports/environment_snapshot.json`
- `build/jenkins/reports/patch_artifacts.env`
