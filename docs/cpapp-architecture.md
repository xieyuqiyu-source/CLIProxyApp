# CLIProxyApp Architecture

## Product Goal

`CLIProxyApp` is a desktop application that hosts `CLIProxyApi` locally and provides its own management experience.

## Main Layers

### 1. Desktop host layer

Implemented with Tauri 2 and Rust.

Responsibilities:

- application lifecycle
- runtime directories
- child process control
- local file operations
- desktop integration

### 2. Frontend layer

Implemented with React 19, TypeScript, and Vite.

Responsibilities:

- desktop control dashboard
- local service diagnostics
- independent management pages
- settings and onboarding

### 3. Managed service layer

`CLIProxyApi` runs as a child process managed by the desktop host.

Responsibilities:

- proxy requests
- expose Management API
- manage provider config and auth flows
- provide usage, logs, and config endpoints

## Interface Boundaries

### React -> Tauri

Use Tauri commands for:

- process lifecycle
- runtime paths
- connection info
- local directory opening
- recent log reading
- bootstrap settings persistence

### React -> CPA Management API

Use HTTP for:

- `/v0/management/*`
- `/v1/models`

The frontend should obtain host, port, and key from the desktop host before making management requests.

## Phase Plan

### Phase 1

- scaffold desktop app
- implement CPA wrapper
- build runtime dashboard
- verify local spawn and stop flow

### Phase 2

- document `CPM`-used endpoints
- add management API client inside `CLIProxyApp`
- build settings and diagnostics pages

### Phase 3

- implement independent management pages
- selectively reuse concepts from `CLIProxyManagement`
- improve packaging and update flow

## UI Direction

The first UI should prioritize desktop operations over full configuration parity.

Initial screens:

- overview dashboard
- runtime control panel
- connection details
- bootstrap settings
- recent logs

## Technical Stack

- Tauri 2
- Rust
- React 19
- TypeScript
- Vite
- Zustand

## Repository Conventions

- `src-tauri/` contains desktop host code
- `src/` contains frontend code
- `docs/` contains architecture and API notes
- `src/lib/cpa/` contains frontend runtime abstractions
- `src-tauri/src/cpa/` contains Rust wrapper implementation
