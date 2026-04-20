# CLIProxyApp

`CLIProxyApp` is a desktop application built with `Tauri 2 + React + TypeScript`. It hosts `CLIProxyApi` locally and provides an independent desktop management experience.

## Current Scope

Phase 1 is focused on the desktop runtime wrapper:

- Tauri desktop host
- React runtime dashboard with Chinese UI
- CPA bootstrap settings
- CPA process start, stop, and restart
- Runtime paths and logs inspection
- Bundled CPA sidecar for packaged builds
- Internal-only management access foundation through Tauri
- CPCloud account login and plan-aware user workspace
- Personal cloud auth sync and shared auth pool access
- Windows tray/background mode
- Manual update check and packaged update reminder support
- One-click Continue integration for local OpenAI-compatible proxy setup

## Workspace Layout

```text
CLIProxy/
├── CLIProxyApi/
├── CLIProxyManagement/
└── CLIProxyApp/
```

## Key Docs

- [docs/cpa-runtime-wrapper.md](docs/cpa-runtime-wrapper.md)
- [docs/cpapp-architecture.md](docs/cpapp-architecture.md)
- [docs/continue-auto-provider-setup.md](docs/continue-auto-provider-setup.md)

## Development

Requirements:

- Node.js
- Rust
- Go

Run:

```bash
npm install
npm run prepare:sidecar
npm run tauri dev
```

## Update Manifest

Packaged builds check a manifest on the same server host as `CPCloud`.

Expected path:

```text
/downloads/cliproxyapp/latest.json
```

Expected JSON shape:

```json
{
  "version": "0.1.6",
  "downloadUrl": "https://your-server.example.com/downloads/CLIProxyApp_0.1.6_x64-setup.exe",
  "notes": "Release notes here",
  "publishedAt": "2026-04-03T12:00:00+08:00"
}
```

## Notes

- Packaged builds now prefer a bundled `CLIProxyApi` sidecar.
- In development mode, `CLIProxyApp` first tries the locally built sidecar and then falls back to the sibling repository at `../CLIProxyApi`.
- Browser control panel access is disabled by default. Management access is intended to move behind Tauri commands instead of direct browser visits.
- Later phases will expand the management pages and release pipeline.
