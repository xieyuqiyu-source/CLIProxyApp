# Continue 自定义 OpenAI 兼容代理一键接入说明

下面记录 `CLIProxyApp` 当前为 `Continue` 实现的一键接入方式。目标是把本地 `CLIProxyApi` 暴露出来的 OpenAI 兼容接口，直接写入 Continue 的本地 `config.yaml`，让用户不需要手改配置。

## 目标

将当前本地代理：

- `apiBase`: `http://127.0.0.1:8317/v1`
- `apiKey`: `api-xuanshukejiapi`

自动写入 Continue，并生成两类模型配置：

- `CLIProxy Chat`
- `CLIProxy Autocomplete`

## Continue 配置文件位置

Continue 官方本地配置文件位置为：

- macOS / Linux: `~/.continue/config.yaml`
- Windows: `%USERPROFILE%\\.continue\\config.yaml`

`CLIProxyApp` 不依赖 Continue CLI，而是直接定位这个文件并写入 YAML。

## 自动化流程

### 1. 读取本地代理运行信息

从 `CLIProxyApp` 当前运行时读取：

- host
- port
- management key

然后组装 Continue 需要的：

```text
http://127.0.0.1:8317/v1
```

### 2. 探测模型列表

先请求：

```http
GET /v1/models
Authorization: Bearer <managementKey>
```

如果模型列表为空，则中止写入，避免生成不可用配置。

### 3. 选择推荐模型

当前实现会自动挑两个模型：

- 聊天 / 编辑 / 应用优先选择：`gpt-5.4` -> `gpt-5.3-codex` -> `gpt-5.2` -> `gpt-5.4-mini`
- 补全优先选择：`gpt-5.4-mini` -> `gpt-5.3-codex-spark` -> `gpt-5.3-codex` -> `gpt-5.2`

如果优先模型不存在，则回退到当前代理实际返回的首个可用模型。

当前 UI 会把这两个推荐值显示出来，并允许用户手动改成代理返回的其他模型：

- `聊天 / 编辑 / 应用模型`
- `补全模型`

### 4. 自动备份原配置

在首次写入前，`CLIProxyApp` 会把原始 Continue 配置备份到自己的运行目录中：

```text
runtime/config/continue-config-backup.json
```

这样可以在 UI 中执行“恢复默认”。

### 5. 写入 Continue YAML

会在 `models` 下新增或更新两个固定名称的模型块：

```yaml
models:
  - name: CLIProxy Chat
    provider: openai
    model: gpt-5.4
    apiBase: http://127.0.0.1:8317/v1
    apiKey: api-xuanshukejiapi
    roles:
      - chat
      - edit
      - apply
    useResponsesApi: false
    capabilities:
      - tool_use

  - name: CLIProxy Autocomplete
    provider: openai
    model: gpt-5.4-mini
    apiBase: http://127.0.0.1:8317/v1
    apiKey: api-xuanshukejiapi
    roles:
      - autocomplete
```

实现原则：

- `provider` 固定为 `openai`
- `apiBase` 指向本地代理 `/v1`
- `chat/edit/apply` 使用主模型
- `autocomplete` 使用更快模型
- `useResponsesApi: false` 强制 Continue 走 `/chat/completions`

### 6. 保留其他 Continue 配置

当前实现不会重建整个 `config.yaml`，只会：

- 补齐缺失的 `name` / `version` / `schema`
- 在 `models` 数组中 upsert 这两个固定名称的模型项

其他已有配置会尽量保留。

## 为什么这样实现

采用“直接修改 Continue 本地 YAML + 应用内备份恢复”的方式，而不是依赖 Continue 自己的界面去点配置，原因是：

- Continue 官方就是以 `config.yaml` 作为本地配置源
- 不依赖 Continue 版本里的具体按钮位置
- 不需要用户理解 provider / roles / apiBase 这些概念
- 更适合做成桌面应用里的“一键配置”

## 当前限制

- 目前只写入两个固定模型块，不会把 `/v1/models` 的全部模型都展开写入
- 不会写入 `~/.continue/.env`，而是直接把 key 写进 `config.yaml`

## 后续建议

如果后续继续做增强，优先级建议如下：

1. 在 UI 中允许手动选择 chat / autocomplete 模型
2. 支持写入 `~/.continue/.env`，把 API key 从 YAML 中移出
3. 支持把更多模型写入 Continue，交给用户在 Continue 内切换
