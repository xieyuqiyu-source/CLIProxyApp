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

## Notes

- Packaged builds now prefer a bundled `CLIProxyApi` sidecar.
- In development mode, `CLIProxyApp` first tries the locally built sidecar and then falls back to the sibling repository at `../CLIProxyApi`.
- Browser control panel access is disabled by default. Management access is intended to move behind Tauri commands instead of direct browser visits.
- Later phases will expand the management pages and release pipeline.
