# 回调鉴权说明

## 1. 适用范围

当前 `lobster-release` 有两类回调入口：

- CI 统一接口
  - `/api/ci/v1/builds/resolve-baseline`
  - `/api/ci/v1/builds/start`
  - `/api/ci/v1/builds/publish`
  - `/api/ci/v1/builds/finish`
- 已签名的 build 定向接口
  - `/projects/:projectKey/builds/:buildId/start`
  - `/projects/:projectKey/builds/:buildId/publish`
  - `/projects/:projectKey/builds/:buildId/finish`

## 2. CI 统一接口鉴权

CI 统一接口使用 `X-Lobster-*` 头：

- `X-Lobster-Key`
- `X-Lobster-Timestamp`
- `X-Lobster-Nonce`
- `X-Lobster-Content-SHA256`
- `X-Lobster-Signature`

签名串：

```text
<HTTP_METHOD>
<REQUEST_PATH>
<TIMESTAMP>
<NONCE>
<CONTENT_SHA256>
```

签名算法：

- `HMAC-SHA256`

密钥：

- `ciApiSecret`

## 3. 已签名 build 定向接口鉴权

定向接口当前使用：

- `X-Timestamp`
- `X-Nonce`
- `X-Signature`

签名串：

```text
<TIMESTAMP>
<NONCE>
<RAW_BODY>
```

签名算法：

- `HMAC-SHA256`

密钥：

- `callbackToken`

## 4. 当前额外安全措施

两类 callback 当前都已经启用：

- `timestamp` 过期校验
- `nonce` 防重放
- `idempotency-key` 幂等消费
- callback 最小限流
- retryable 失败时返回 `Retry-After`

## 5. 失败语义

### 不应重试

- 签名错误
- body hash 错误
- nonce 重放
- idempotency key 冲突
- patch schema 或 conflict 校验失败

### 可以重试

- 服务内部异常
- 临时 IO 问题
- 暂时性状态竞争

这类失败当前会：

- 写入 `callback.failed` 事件
- 返回 `500`
- 带 `Retry-After`

## 6. 运维建议

- `ciApiKey/ciApiSecret` 和 `callbackToken` 必须放在 `.env` 或 Jenkins credentials
- 生产环境不要把这些值直接写进已提交配置
- 如果看到大量 `replayed nonce`，优先检查上游是否错误重放了旧请求
- 如果看到 `idempotency key reused with different request body`，说明上游复用了 key 但 payload 已变化
