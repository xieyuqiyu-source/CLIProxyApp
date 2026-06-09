#!/usr/bin/env bash
#
# CPSwitch macOS release helper.
#
# Flow:
#   1. sync CLIProxy repositories
#   2. choose release version interactively
#   3. update app / website fallback versions
#   4. build macOS DMG
#   5. commit and push App / Cloud changes
#   6. upload DMG to the production server
#   7. update latest.json while preserving the existing Windows download
#
# Usage:
#   ./scripts/mac-release.sh
#
# Useful overrides:
#   SERVER=aitools-server ./scripts/mac-release.sh
#   PUBLIC_BASE_URL=https://cliproxy.szxsai.com ./scripts/mac-release.sh
#   RELEASE_NOTES="CPSwitch 1.1.7 已发布：..." ./scripts/mac-release.sh
#   SYNC_PROJECTS="CLIProxyApp CLIProxyManagement CLIProxyDeploy CLIProxyApi CLIProxyCloud" ./scripts/mac-release.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/CLIProxyApp"
CLOUD_DIR="$ROOT_DIR/CLIProxyCloud"

SERVER="${SERVER:-aitools-server}"
SERVER_CLOUD_DIR="${SERVER_CLOUD_DIR:-/var/www/CLIProxyCloud}"
SERVER_DOWNLOAD_DIR="${SERVER_DOWNLOAD_DIR:-$SERVER_CLOUD_DIR/storage/downloads/cliproxyapp}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://cliproxy.szxsai.com}"
SYNC_PROJECTS="${SYNC_PROJECTS:-CLIProxyApp CLIProxyManagement CLIProxyDeploy CLIProxyApi CLIProxyCloud}"

info() { printf '\033[1;34m[mac-release]\033[0m %s\n' "$*" >&2; }
ok() { printf '\033[1;32m[mac-release]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[mac-release]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[mac-release]\033[0m %s\n' "$*" >&2; exit 1; }

ask_yes_no() {
  local prompt="$1"
  local default="${2:-y}"
  local suffix="[y/N]"
  [ "$default" = "y" ] && suffix="[Y/n]"
  local answer
  read -r -p "$prompt $suffix " answer
  answer="${answer:-$default}"
  case "$answer" in
    y|Y|yes|YES|是) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

ensure_env() {
  [ "$(uname -s)" = "Darwin" ] || die "macOS DMG 只能在 macOS 上打包。"
  [ -d "$APP_DIR" ] || die "找不到 CLIProxyApp：$APP_DIR"
  [ -d "$CLOUD_DIR" ] || die "找不到 CLIProxyCloud：$CLOUD_DIR"

  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi

  require_cmd git
  require_cmd node
  require_cmd npm
  require_cmd go
  require_cmd cargo
  require_cmd shasum
  require_cmd ssh
  require_cmd scp
}

current_branch() {
  git -C "$1" branch --show-current
}

sync_repo() {
  local dir="$1"
  local name
  name="$(basename "$dir")"
  [ -d "$dir/.git" ] || {
    warn "$name 不是 Git 仓库，跳过同步。"
    return
  }
  local branch
  branch="$(current_branch "$dir")"
  [ -n "$branch" ] || die "$name 当前不在普通分支上。"
  info "同步 $name ($branch)..."
  git -C "$dir" fetch --all --prune
  git -C "$dir" pull --rebase --autostash origin "$branch"
}

sync_projects() {
  local project
  for project in $SYNC_PROJECTS; do
    sync_repo "$ROOT_DIR/$project"
  done
}

read_app_version() {
  node -e "const p=require(process.argv[1]); process.stdout.write(String(p.version || ''))" "$APP_DIR/package.json"
}

bump_patch_version() {
  node - "$1" <<'NODE'
const input = process.argv[2]
const parts = input.split('.').map((item) => Number(item))
if (parts.length !== 3 || parts.some((item) => !Number.isInteger(item) || item < 0)) {
  throw new Error(`invalid semver: ${input}`)
}
parts[2] += 1
process.stdout.write(parts.join('.'))
NODE
}

choose_version() {
  local current="$1"
  local next
  next="$(bump_patch_version "$current")"
  info "当前版本号：$current"
  if ask_yes_no "是否版本号 +1 到 ${next}？" "y"; then
    printf '%s' "$next"
    return
  fi
  if ask_yes_no "是否保持当前版本号 ${current} 不变？" "y"; then
    printf '%s' "$current"
    return
  fi
  local custom
  read -r -p "请输入自定义版本号（例如 1.1.7）：" custom
  custom="${custom//[[:space:]]/}"
  [[ "$custom" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "版本号格式不正确：$custom"
  printf '%s' "$custom"
}

update_versions() {
  local version="$1"
  local notes="$2"
  local mac_file_name="CPSwitch_${version}_aarch64.dmg"

  info "更新 App / 官网 fallback 版本号到 $version..."
  node - "$APP_DIR" "$CLOUD_DIR" "$version" "$notes" "$mac_file_name" <<'NODE'
const fs = require('fs')
const path = require('path')

const [appDir, cloudDir, version, notes, macFileName] = process.argv.slice(2)

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

for (const file of ['package.json', 'package-lock.json']) {
  const target = path.join(appDir, file)
  const json = JSON.parse(fs.readFileSync(target, 'utf8'))
  json.version = version
  if (json.packages && json.packages['']) {
    json.packages[''].version = version
  }
  writeJson(target, json)
}

const tauriConfig = path.join(appDir, 'src-tauri', 'tauri.conf.json')
const tauri = JSON.parse(fs.readFileSync(tauriConfig, 'utf8'))
tauri.version = version
writeJson(tauriConfig, tauri)

const cargoToml = path.join(appDir, 'src-tauri', 'Cargo.toml')
let cargo = fs.readFileSync(cargoToml, 'utf8')
cargo = cargo.replace(/^version = ".+"$/m, `version = "${version}"`)
fs.writeFileSync(cargoToml, cargo)

const website = path.join(cloudDir, 'web', 'index.html')
if (fs.existsSync(website)) {
  let html = fs.readFileSync(website, 'utf8')
  html = html.replace(/site\.css\?v=[0-9]+\.[0-9]+\.[0-9]+/g, `site.css?v=${version}`)
  html = html.replace(/id="download-version">v[^<]+</, `id="download-version">v${version}<`)
  html = html.replace(/id="download-notes">[^<]*</, `id="download-notes">${notes.replace(/[<>&]/g, (ch) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]))}<`)
  html = html.replace(/id="download-mac" href="[^"]+"/, `id="download-mac" href="/downloads/cliproxyapp/${macFileName}"`)
  fs.writeFileSync(website, html)
}
NODE
}

ensure_node_modules() {
  if [ ! -d "$APP_DIR/node_modules" ]; then
    info "安装 CLIProxyApp 依赖..."
    (cd "$APP_DIR" && npm install)
  fi
}

build_mac_dmg() {
  info "开始构建 macOS DMG..."
  ensure_node_modules
  (cd "$APP_DIR" && npm run tauri build -- --bundles dmg)

  local dmg_dir="$APP_DIR/src-tauri/target/release/bundle/dmg"
  local dmg
  dmg="$(ls -t "$dmg_dir"/*.dmg 2>/dev/null | head -1 || true)"
  [ -n "$dmg" ] || die "打包完成但没有找到 DMG：$dmg_dir"
  DMG_PATH="$dmg"
}

run_checks() {
  info "运行后端测试..."
  (cd "$CLOUD_DIR" && go test ./...)
}

show_repo_status() {
  local dir="$1"
  local name
  name="$(basename "$dir")"
  if [ -n "$(git -C "$dir" status --short)" ]; then
    info "$name 当前变更："
    git -C "$dir" status --short
    git -C "$dir" diff --stat
  else
    ok "$name 没有待提交变更。"
  fi
}

commit_if_dirty() {
  local dir="$1"
  local message="$2"
  local name
  name="$(basename "$dir")"
  if [ -z "$(git -C "$dir" status --short)" ]; then
    ok "$name 无需提交。"
    return
  fi
  git -C "$dir" add -A
  git -C "$dir" commit -m "$message"
}

push_repo() {
  local dir="$1"
  local branch
  branch="$(current_branch "$dir")"
  git -C "$dir" push origin "$branch"
}

commit_and_push() {
  show_repo_status "$APP_DIR"
  show_repo_status "$CLOUD_DIR"
  ask_yes_no "是否提交并推送 CLIProxyApp 和 CLIProxyCloud 当前变更？" "y" || die "已取消提交推送。"

  commit_if_dirty "$APP_DIR" "Release CPSwitch $VERSION"
  commit_if_dirty "$CLOUD_DIR" "Update CPSwitch $VERSION website release"
  push_repo "$APP_DIR"
  push_repo "$CLOUD_DIR"
}

upload_dmg_and_manifest() {
  local dmg="$1"
  local version="$2"
  local notes="$3"
  local base_name="CPSwitch_${version}_aarch64.dmg"
  local temp_file="/tmp/$base_name"
  local sha256
  sha256="$(shasum -a 256 "$dmg" | awk '{print $1}')"

  info "上传 DMG 到 $SERVER:$SERVER_DOWNLOAD_DIR/$base_name ..."
  ssh "$SERVER" "mkdir -p '$SERVER_DOWNLOAD_DIR'"
  scp "$dmg" "$SERVER:$temp_file"
  ssh "$SERVER" "mv '$temp_file' '$SERVER_DOWNLOAD_DIR/$base_name' && chmod 0644 '$SERVER_DOWNLOAD_DIR/$base_name'"

  info "更新服务器 latest.json..."
  local payload
  payload="$(node -e "process.stdout.write(Buffer.from(JSON.stringify({
    version: process.argv[1],
    notes: process.argv[2],
    publicBaseUrl: process.argv[3],
    macFile: process.argv[4],
    sha256: process.argv[5],
    manifest: process.argv[6],
  })).toString('base64'))" "$version" "$notes" "$PUBLIC_BASE_URL" "$base_name" "$sha256" "$SERVER_DOWNLOAD_DIR/latest.json")"
  ssh "$SERVER" "RELEASE_PAYLOAD_B64='$payload' node" <<'NODE'
const fs = require('fs')
const path = require('path')

const payload = JSON.parse(Buffer.from(process.env.RELEASE_PAYLOAD_B64, 'base64').toString('utf8'))
const manifestPath = payload.manifest
let manifest = { downloads: {} }
if (fs.existsSync(manifestPath)) {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}
if (!manifest.downloads) manifest.downloads = {}
const base = (payload.publicBaseUrl || '').replace(/\/$/, '')
manifest.version = payload.version
manifest.notes = payload.notes
manifest.publishedAt = new Date().toISOString()
manifest.downloads.macos = `${base}/downloads/cliproxyapp/${encodeURIComponent(payload.macFile)}`
manifest.sha256 = manifest.sha256 && typeof manifest.sha256 === 'object' ? manifest.sha256 : {}
manifest.sha256.macos = payload.sha256
fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
NODE

  ok "DMG: $dmg"
  ok "SHA256: $sha256"
}

verify_online() {
  local manifest_url="$PUBLIC_BASE_URL/downloads/cliproxyapp/latest.json"
  info "验证线上 manifest：$manifest_url"
  curl -fsSL "$manifest_url" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log(JSON.stringify({version:j.version, macos:j.downloads&&j.downloads.macos, windows:j.downloads&&j.downloads.windows}, null, 2))})"
  curl -fsSL "$PUBLIC_BASE_URL/healthz" >/dev/null && ok "healthz 正常。"
}

main() {
  ensure_env
  sync_projects

  local current_version
  current_version="$(read_app_version)"
  VERSION="$(choose_version "$current_version")"
  export VERSION

  RELEASE_NOTES="${RELEASE_NOTES:-CPSwitch $VERSION 已发布：更新桌面端与云端服务}"
  read -r -p "发布说明 [$RELEASE_NOTES]：" input_notes
  RELEASE_NOTES="${input_notes:-$RELEASE_NOTES}"

  update_versions "$VERSION" "$RELEASE_NOTES"
  run_checks
  build_mac_dmg
  local dmg="$DMG_PATH"
  commit_and_push
  upload_dmg_and_manifest "$dmg" "$VERSION" "$RELEASE_NOTES"
  verify_online
  ok "macOS 发布流程完成。"
}

main "$@"
