# CLIProxyApp

`CLIProxyApp` 是 CPSwitch 的桌面客户端，基于 `Tauri 2 + React + TypeScript` 构建。它负责在本机拉起 `CLIProxyApi`，提供账号登录、额度查看、共享账号获取、本地代理配置和桌面端打包发布能力。

## 当前能力

- Tauri 桌面宿主，支持 macOS 和 Windows 打包。
- 自动准备并内置 `CLIProxyApi` sidecar，打包后优先使用随 App 分发的本地后端。
- React 中文管理界面，包含运行状态、日志、路径、账号和额度等常用操作。
- CPCloud 账号登录、会员套餐识别、共享账号池同步。
- 支持 OAuth 登录自己的模型账号，包括 Codex、Claude、Gemini 和 Grok / xAI。
- 支持 Token、JSON 和本地认证文件导入。
- 支持额度面板按 provider 查看状态。
- 支持 OpenAI 兼容接口配置。
- 支持一键写入 Continue、OpenClaw、Kiro、Codex 等工具的本地代理配置。
- 支持 Windows 托盘和后台运行。
- 支持手动检查更新和发布包更新提醒。

## 目录结构

```text
CLIProxy/
├── CLIProxyApi/          # 本地代理后端和 sidecar 来源
├── CLIProxyManagement/   # 内置管理端资源来源
├── CLIProxyCloud/        # 云端服务和下载页
├── CLIProxyDeploy/       # 部署相关配置
└── CLIProxyApp/          # 桌面客户端
```

## 常用文档

- [CPSwitch 用户使用指南](docs/cpswitch-user-guide.zh-CN.md)
- [CPA 运行时包装说明](docs/cpa-runtime-wrapper.md)
- [桌面端架构说明](docs/cpapp-architecture.md)
- [Continue 自动接入说明](docs/continue-auto-provider-setup.md)
- [OpenClaw 自动接入说明](docs/openclaw-auto-provider-setup.md)

## 开发环境

需要安装：

- Node.js
- Rust
- Go
- macOS 打包时需要 Xcode Command Line Tools

安装依赖：

```bash
npm install
```

拉起开发模式：

```bash
npm run tauri dev
```

开发模式会执行：

```bash
npm run prepare:sidecar
npm run prepare:cpm
npm run dev -- --host 0.0.0.0 --port 1420
```

其中 `prepare:sidecar` 会从相邻目录的 `CLIProxyApi` 构建本地后端，`prepare:cpm` 会从相邻目录的 `CLIProxyManagement` 构建内置管理端资源。

## 常用命令

```bash
npm run lint
npm run build
npm run tauri build -- --bundles dmg
```

构建 Apple Silicon DMG：

```bash
npm run tauri build -- --bundles dmg
```

构建 Intel DMG：

```bash
rustup target add x86_64-apple-darwin
mkdir -p src-tauri/resources/sidecar/darwin-x86_64
(cd ../CLIProxyApi && GOOS=darwin GOARCH=amd64 go build -o ../CLIProxyApp/src-tauri/resources/sidecar/darwin-x86_64/cliproxyapi ./cmd/server)
npm run tauri build -- --target x86_64-apple-darwin --bundles dmg
```

## macOS 发布流程

项目内置交互式发布脚本：

```bash
./scripts/mac-release.sh
```

脚本会执行：

- 同步 `CLIProxyApp`、`CLIProxyManagement`、`CLIProxyDeploy`、`CLIProxyApi`、`CLIProxyCloud`。
- 选择 patch、自定义或保留当前版本号。
- 更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。
- 构建 Apple Silicon 和 Intel 两个 macOS DMG。
- 提交并推送 `CLIProxyApp` 和需要更新的云端下载页。
- 上传 DMG 到服务器。
- 更新 `/downloads/cliproxyapp/latest.json`，同时保留已有 Windows 下载链接。

可用环境变量：

```bash
SERVER=aitools-server ./scripts/mac-release.sh
RELEASE_NOTES="CPSwitch 1.2.1 已发布：新增 Grok / xAI 登录代理。" ./scripts/mac-release.sh
SYNC_PROJECTS="CLIProxyApp CLIProxyManagement CLIProxyDeploy CLIProxyApi CLIProxyCloud" ./scripts/mac-release.sh
```

## 更新清单

打包后的客户端会从 CPCloud 同源服务器读取更新清单。

默认路径：

```text
/downloads/cliproxyapp/latest.json
```

示例结构：

```json
{
  "version": "1.2.1",
  "notes": "CPSwitch 1.2.1 已发布：新增 Grok / xAI 登录代理。",
  "publishedAt": "2026-07-24T06:00:00Z",
  "downloads": {
    "windows": "https://cliproxy.szxsai.com/downloads/cliproxyapp/CPSwitch_1.2.0_x64-setup.exe",
    "macos": "https://cliproxy.szxsai.com/downloads/cliproxyapp/CPSwitch_1.2.1_aarch64.dmg",
    "darwin-x64": "https://cliproxy.szxsai.com/downloads/cliproxyapp/CPSwitch_1.2.1_x64.dmg"
  }
}
```

## 注意事项

- 打包版本优先使用内置 `CLIProxyApi` sidecar。
- 开发模式会先构建本地 sidecar，再启动桌面端。
- 数据库、云端登录和共享账号能力仍由 CPCloud 提供。
- Grok / xAI 入口目前接入 OAuth 登录代理，不包含 xAI API Key 配置。
- 管理端资源通过 `public/cpm/index.html` 内嵌到桌面端发布包中。
