# CLIProxyApp

`CLIProxyApp` is a desktop application built with `Tauri 2 + React + TypeScript`. It hosts `CLIProxyApi` locally and provides an independent desktop management experience.

## Current Scope

Phase 1 is focused on the desktop runtime wrapper:

- Tauri desktop host
- React runtime dashboard
- CPA bootstrap settings
- CPA process start, stop, and restart
- Runtime paths and logs inspection

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
npm run tauri dev
```

## Notes

- The current implementation targets workspace development mode first.
- In development mode, `CLIProxyApp` will try to run the sibling repository at `../CLIProxyApi`.
- Later phases will add packaged sidecar support and richer management pages.
