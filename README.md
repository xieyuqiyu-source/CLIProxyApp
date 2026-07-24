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
├── CLIProxyCloud/
├── CLIProxyDeploy/
└── CLIProxyApp/
```

## Key Docs

- [docs/cpa-runtime-wrapper.md](docs/cpa-runtime-wrapper.md)
- [docs/cpapp-architecture.md](docs/cpapp-architecture.md)
- [docs/cpswitch-user-guide.zh-CN.md](docs/cpswitch-user-guide.zh-CN.md)
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

## macOS Release

Use the interactive release helper from `CLIProxyApp`:

```bash
./scripts/mac-release.sh
```

The script will:

- sync the CLIProxy repositories with `git pull --rebase --autostash`
- ask whether to bump the patch version, keep the current version, or enter a custom version
- update `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the website fallback version
- build the macOS `.dmg`
- commit and push `CLIProxyApp` and `CLIProxyCloud`
- upload the `.dmg` to the server
- update `/downloads/cliproxyapp/latest.json` while preserving the existing Windows download link

Useful overrides:

```bash
SERVER=aitools-server ./scripts/mac-release.sh
RELEASE_NOTES="CPSwitch 1.1.7 已发布：..." ./scripts/mac-release.sh
SYNC_PROJECTS="CLIProxyApp CLIProxyManagement CLIProxyDeploy CLIProxyApi CLIProxyCloud" ./scripts/mac-release.sh
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
  "version": "1.1.6",
  "notes": "Release notes here",
  "publishedAt": "2026-06-09T08:00:00Z",
  "downloads": {
    "windows": "https://cliproxy.szxsai.com/downloads/cliproxyapp/CPSwitch_1.1.5_x64-setup.exe",
    "macos": "https://cliproxy.szxsai.com/downloads/cliproxyapp/CPSwitch_1.1.6_aarch64.dmg"
  }
}
```

## Notes

- Packaged builds now prefer a bundled `CLIProxyApi` sidecar.
- In development mode, `CLIProxyApp` first tries the locally built sidecar and then falls back to the sibling repository at `../CLIProxyApi`.
- Browser control panel access is disabled by default. Management access is intended to move behind Tauri commands instead of direct browser visits.
- Later phases will expand the management pages and release pipeline.
