# Mac Dev Memo

面向后续在 Mac 上继续开发 `CPSwitch / CLIProxy` 时的固定执行清单。

## 当前项目位置

- `C:\Users\Administrator\Documents\xieyuqiyu\CLIProxy\CLIProxyApp`
- `C:\Users\Administrator\Documents\xieyuqiyu\CLIProxy\CLIProxyCloud`

如果是在 Mac 上，优先同步这两个仓库：

- `CLIProxyApp`
- `CLIProxyCloud`

不要默认去动：

- `CLIProxyApi`
- `CLIProxyManagement`

除非本次需求明确涉及这两个仓库。

## 云端环境

当前正式后端基地址：

- `https://cliproxy.szxsai.com/api/v1`

当前官网地址：

- `https://cliproxy.szxsai.com`

当前线上服务器：

- `root@124.223.111.163`

如果需要登录服务器，先确认：

- 服务目录：`/var/www/CLIProxyCloud`
- systemd 服务：`cliproxycloud`

## 每次开工默认顺序

1. 同步 `CLIProxyApp` 和 `CLIProxyCloud` 到远端最新。
2. 先看用户需求是改桌面端、云端接口、还是官网静态页。
3. 如果是桌面端 UI / Tauri / 本地代理联动，优先改 `CLIProxyApp`。
4. 如果是会员、支付、共享号池、官网、下载分发，优先看 `CLIProxyCloud`。

## 本地开发

`CLIProxyApp`：

1. 需要桌面调试时，进入 `CLIProxyApp` 后运行：
   - `npm run tauri dev`
2. 如果遇到窗口或 sidecar 占用，先关闭：
   - `cargo`
   - `node`
   - `cliproxyapi`
   - `app`
3. 构建校验优先执行：
   - `npm run build`

`CLIProxyCloud`：

1. 修改后至少执行：
   - `go test ./...`
2. 官网改动主要看：
   - `web/index.html`
   - `web/assets/*`

## Windows 打包

在 `CLIProxyApp` 目录执行：

```powershell
npm run tauri build -- --bundles nsis
```

产物路径：

- `src-tauri/target/release/bundle/nsis/`

如果需要给用户直接安装：

- 复制 `.exe` 到桌面

## 官网下载区

官网现在应当依赖：

- `/downloads/cliproxyapp/latest.json`

它决定：

- 版本号显示
- Windows 下载链接
- macOS 下载链接

如果上传了新的安装包，要同步更新：

- `/var/www/CLIProxyCloud/storage/downloads/cliproxyapp/latest.json`

## 线上部署

`CLIProxyCloud` 推荐发布方式：

1. 本地完成修改并提交。
2. 推远端。
3. 如果服务器 git 工作区不干净，不要硬 `git pull`。
4. 直接以本地最新源码为准上传覆盖，再编译重启。

常用命令目标：

- 工作目录：`/var/www/CLIProxyCloud`
- 重编译：
  - `go build -o /var/www/CLIProxyCloud/cliproxy-cloud ./cmd/server`
- 重启：
  - `systemctl restart cliproxycloud`
- 健康检查：
  - `curl http://127.0.0.1:8090/healthz`

## 当前已知注意点

- `Codex 配置` 弹窗之前受外层轮询影响会闪烁，已经做过隔离处理。
- 会员弹窗价格切换现在会重新触发后端报价并刷新缓存。
- 共享号池支持单条删除，不再只有清空。
- 官网下载区应该同时展示 Win / Mac 下载按钮和版本号。

## 默认回答策略

如果我在 Mac 上只问一句“接下来该干什么”，默认按下面执行：

1. 同步 `CLIProxyApp` 与 `CLIProxyCloud`
2. 检查需求属于桌面端还是云端
3. 先跑基础构建校验
4. 再开始改代码

