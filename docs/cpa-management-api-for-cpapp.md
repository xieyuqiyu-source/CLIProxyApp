# CPA Management API for CPAPP

This document captures the `CLIProxyApi` management endpoints already used by `CLIProxyManagement` and expected to be reused by `CLIProxyApp`.

## Base Rules

- Base path: `/v0/management`
- Auth header: `Authorization: Bearer <managementKey>`
- Model list endpoint: `/v1/models`

## Runtime and Overview

- `GET /usage`
- `GET /latest-version`
- `GET /logs`
- `GET /request-log`
- `GET /request-log-by-id/:id`
- `GET /request-error-logs`
- `GET /request-error-logs/:name`

## Config and Basic Settings

- `GET /config`
- `GET /config.yaml`
- `PUT /config.yaml`
- `GET /debug`
- `PUT /debug`
- `GET /logging-to-file`
- `PUT /logging-to-file`
- `GET /logs-max-total-size-mb`
- `PUT /logs-max-total-size-mb`
- `GET /error-logs-max-files`
- `PUT /error-logs-max-files`
- `GET /usage-statistics-enabled`
- `PUT /usage-statistics-enabled`
- `GET /proxy-url`
- `PUT /proxy-url`
- `DELETE /proxy-url`
- `GET /request-log`
- `PUT /request-log`
- `GET /ws-auth`
- `PUT /ws-auth`
- `GET /request-retry`
- `PUT /request-retry`
- `GET /max-retry-interval`
- `PUT /max-retry-interval`
- `GET /force-model-prefix`
- `PUT /force-model-prefix`
- `GET /routing/strategy`
- `PUT /routing/strategy`

## API Keys and Providers

- `GET /api-keys`
- `PUT /api-keys`
- `PATCH /api-keys`
- `DELETE /api-keys`
- `GET /gemini-api-key`
- `PUT /gemini-api-key`
- `PATCH /gemini-api-key`
- `DELETE /gemini-api-key`
- `GET /claude-api-key`
- `PUT /claude-api-key`
- `PATCH /claude-api-key`
- `DELETE /claude-api-key`
- `GET /codex-api-key`
- `PUT /codex-api-key`
- `PATCH /codex-api-key`
- `DELETE /codex-api-key`
- `GET /openai-compatibility`
- `PUT /openai-compatibility`
- `PATCH /openai-compatibility`
- `DELETE /openai-compatibility`
- `GET /vertex-api-key`
- `PUT /vertex-api-key`
- `PATCH /vertex-api-key`
- `DELETE /vertex-api-key`

## Auth Files and OAuth

- `GET /auth-files`
- `GET /auth-files/models`
- `GET /auth-files/download`
- `POST /auth-files`
- `DELETE /auth-files`
- `PATCH /auth-files/status`
- `PATCH /auth-files/fields`
- `POST /vertex/import`
- `GET /oauth-excluded-models`
- `PUT /oauth-excluded-models`
- `PATCH /oauth-excluded-models`
- `DELETE /oauth-excluded-models`
- `GET /oauth-model-alias`
- `PUT /oauth-model-alias`
- `PATCH /oauth-model-alias`
- `DELETE /oauth-model-alias`
- `GET /anthropic-auth-url`
- `GET /codex-auth-url`
- `GET /gemini-cli-auth-url`
- `GET /antigravity-auth-url`
- `GET /qwen-auth-url`
- `GET /kimi-auth-url`
- `GET /iflow-auth-url`
- `POST /iflow-auth-url`
- `POST /oauth-callback`
- `GET /get-auth-status`

## Usage Import and Export

- `GET /usage/export`
- `POST /usage/import`

## API Proxy Helper

- `POST /api-call`
- `GET /v1/models`

## CPAPP Recommendation

`CLIProxyApp` should not expose the full `CPM` feature surface immediately.

Recommended rollout:

1. Desktop runtime and diagnostics
2. Core settings and config editing
3. Provider and auth file pages
4. Usage and logs pages
5. OAuth flows and advanced provider-specific pages
