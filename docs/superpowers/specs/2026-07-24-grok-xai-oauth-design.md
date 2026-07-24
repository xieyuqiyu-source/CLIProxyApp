# Grok / xAI OAuth 登录接入设计

## 目标

在 CPSwitch App 的账号登录入口中暴露 CLIProxyApi 已支持的 xAI OAuth 流程，让用户可以用 Grok/xAI 账号登录，并通过本地 CLIProxyApi 代理使用 Grok 模型。

## 范围

- 在 OAuth 面板新增 `Grok / xAI` provider。
- 调用现有管理接口 `xai-auth-url` 发起授权。
- 沿用现有 `get-auth-status` 轮询授权结果。
- 在额度 provider 标签中新增 `Grok`，并让 `Grok` 标签打开账号登录时只展示 xAI 登录入口。
- 在认证文件列表中识别 `xai` provider。

## 非目标

- 不新增 xAI API Key 配置入口。
- 不修改 CLIProxyApi 的 xAI executor、OAuth 实现或模型路由。
- 不修改 Cloud、发布流程或支付逻辑。

## 数据流

用户在 App 中点击 `Grok / xAI` 的 `发起授权` 后，App 通过 Tauri 管理代理请求本地 CPA：

```text
GET /v0/management/xai-auth-url
```

CPA 返回授权 URL 和可选 state。App 打开外部浏览器。如果返回 state，App 复用当前轮询逻辑：

```text
GET /v0/management/get-auth-status?state=...
```

授权成功后，认证文件由 CPA 写入本地认证目录。后续本地代理按 CPA 的 `xai` provider 能力暴露 Grok 模型。

## 测试

新增编译期覆盖文件，要求：

- OAuth provider id 包含 `xai`。
- 全量 OAuth provider 列表包含 `xai`。
- `xai` 有面板展示定义。
- 额度 provider `xai` 能映射到 OAuth provider `xai`。

最终以 `npm run build` 作为 App 的完整 TypeScript 和 Vite 构建验证。
