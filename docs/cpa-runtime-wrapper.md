# CPA Runtime Wrapper

## Goal

`CLIProxyApp` must run `CLIProxyApi` as a local managed background service on desktop platforms.

The wrapper layer is responsible for process management, runtime directories, bootstrap configuration, and safe handoff of connection details to the frontend.

`CLIProxyApp` does not reimplement `CLIProxyApi` business logic. It hosts `CLIProxyApi` as a black-box local service.

## Runtime Model

`CLIProxyApp` consists of:

- Tauri backend: desktop host and process manager
- React frontend: local management UI
- `CLIProxyApi`: managed child process

## Responsibilities

### Tauri backend

- Resolve `CLIProxyApi` binary path
- Resolve app data, config, and logs directories
- Create and update bootstrap config
- Start, stop, restart, and monitor the `CLIProxyApi` process
- Expose stable commands to the frontend
- Provide connection information for the management API
- Stream or return recent runtime logs

### React frontend

- Display `CLIProxyApi` runtime state
- Show connection and environment diagnostics
- Provide an independent management UI for end users
- Call Tauri commands for desktop-only operations
- Call `CLIProxyApi` Management API for service configuration and data pages

### CLIProxyApi

- Keep serving proxy and management endpoints
- Keep all existing `/v0/management` behavior
- Remain independently updatable from upstream

## Runtime Directories

The wrapper will use app-scoped directories under the Tauri app data root.

- `runtime/`
- `runtime/logs/`
- `runtime/bin/`
- `runtime/config/`

The first implementation uses these logical files:

- `runtime/config/config.yaml`
- `runtime/config/bootstrap.json`
- `runtime/logs/cpa.stdout.log`
- `runtime/logs/cpa.stderr.log`

## Bootstrap Settings

Bootstrap settings are owned by `CLIProxyApp`, not by `CLIProxyApi`.

Suggested shape:

```json
{
  "apiPort": 8317,
  "managementKey": "",
  "host": "127.0.0.1",
  "autoStart": true,
  "binaryMode": "development"
}
```

## Frontend-facing Desktop Commands

These commands define the desktop boundary used by the React app.

- `get_app_state`
- `get_cpa_state`
- `start_cpa`
- `stop_cpa`
- `restart_cpa`
- `get_cpa_connection_info`
- `get_cpa_runtime_paths`
- `get_cpa_recent_logs`
- `save_bootstrap_settings`
- `open_cpa_config_dir`
- `open_cpa_log_dir`

## CPA State Model

Suggested state shape:

```json
{
  "status": "stopped",
  "pid": null,
  "startedAt": null,
  "host": "127.0.0.1",
  "apiPort": 8317,
  "managementBaseUrl": "http://127.0.0.1:8317/v0/management",
  "managementKeyConfigured": false,
  "binaryPath": "",
  "configPath": "",
  "logsDir": "",
  "lastError": null
}
```

Valid `status` values:

- `stopped`
- `starting`
- `running`
- `stopping`
- `error`

## Process Policy

- Only one managed `CLIProxyApi` process may exist per app instance.
- Restart must be implemented as stop then start.
- The wrapper must write stdout and stderr to files for diagnosis.
- The wrapper must detect repeated start failures and keep the error visible to the UI.

## Binary Resolution Strategy

The first implementation supports development mode.

Priority:

1. Explicit binary path from bootstrap config
2. Workspace-relative development binary
3. Future packaged sidecar binary

The wrapper must expose the final resolved path to the UI.

## Health Model

Initial health checks should be lightweight:

- process existence
- successful spawn
- TCP reachability of configured port

Management API health probing can be added after the wrapper is stable.

## Security Boundaries

- `managementKey` remains required for `/v0/management`
- The frontend should never invent host or port rules on its own
- Desktop code is the source of truth for local runtime connection info

## Phase 1 Scope

Phase 1 delivers:

- local process lifecycle control
- bootstrap settings storage
- runtime paths discovery
- recent logs inspection
- connection info handoff
- a minimal desktop control panel

It does not yet deliver:

- binary auto-download
- packaged sidecar release pipeline
- auto-upgrade for `CLIProxyApi`
- full `CPM` parity
