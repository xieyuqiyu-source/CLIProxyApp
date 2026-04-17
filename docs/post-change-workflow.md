# Post-Change Workflow

每次 `CLIProxyApp` 或 `CLIProxyCloud` 有可发布改动后，默认按这套顺序执行。

## 目标

避免出现下面这些常见问题：

- 改了代码但没提交
- 提交了但没推远端
- 打了本地包但没上传线上
- 官网下载链接和版本号没同步
- 改完后没有留下后续可复用的备忘

## 固定顺序

1. 检查改动范围
   - `git status --short`
   - `git diff --stat`

2. 构建校验
   - `CLIProxyApp`:
     - `npm run build`
   - `CLIProxyCloud`:
     - `go test ./...`

3. 版本决策
   - 如果是正式发布，先确认是否需要 bump 版本
   - 如果只是同版本热修补，明确说明“不改版本号”

4. 提交代码
   - `CLIProxyApp` 单独提交
   - `CLIProxyCloud` 单独提交
   - 不把无关产物和随机文件混进去

5. 推送远端
   - `git push origin main`

6. 打包桌面端
   - `npm run tauri build -- --bundles nsis`
   - 确认产物路径：
     - `src-tauri/target/release/bundle/nsis/`

7. 上传线上
   - 上传新的 Windows 包到：
     - `/var/www/CLIProxyCloud/storage/downloads/cliproxyapp/`
   - 必要时更新：
     - `latest.json`
   - 如果官网静态页有变更，同步发布：
     - `/var/www/CLIProxyCloud/web/index.html`
     - `/var/www/CLIProxyCloud/web/assets/*`

8. 验证线上
   - `https://cliproxy.szxsai.com/healthz`
   - `https://cliproxy.szxsai.com/downloads/cliproxyapp/latest.json`
   - 新安装包下载地址是否返回 `200`

9. 关闭本地开发进程
   - `cargo`
   - `node`
   - `cliproxyapi`
   - `app`

10. 补备忘
   - 如果这次改动会影响后续开发方式、部署方式、发布方式，追加文档
   - 优先写到：
     - `docs/mac-dev-memo.md`
     - 或新建对应流程文档

## 默认执行原则

- 只要用户说“重复一遍流程”，默认就是按本文件顺序执行。
- 除非用户明确要求，否则不要跳过：
  - 提交
  - 推送
  - 打包
  - 上传
  - 线上验证

