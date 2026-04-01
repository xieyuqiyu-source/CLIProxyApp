# OpenClaw 自定义 OpenAI 兼容代理自动接入说明

下面是这次为 `OpenClaw` 自动接入自定义 OpenAI 兼容代理时，实际采用的实现方式。目标是把一个本地 OpenAI 格式接口自动注册成 `OpenClaw` 的自定义模型提供方，并让它出现在 `openclaw models list` 中可直接使用。

## 目标

将以下代理自动接入 `OpenClaw`：

- `baseUrl`: `http://127.0.0.1:8317/v1`
- `apiKey`: `api-xuanshukejiapi`
- provider 名称：`cliproxy`

并完成：

- 写入 OpenClaw 配置文件
- 注册 `/v1/models` 返回的全部模型
- 在 `agents.defaults.models` 中启用这些模型
- 给 `cliproxy/gpt-5.4` 设置别名 `cliproxy`
- 运行配置校验，确认生效

## 配置文件位置

自动化修改的目标文件是：

[openclaw.json](C:\Users\Administrator\.openclaw\openclaw.json)

实际定位方式是通过命令获取，而不是硬编码：

```powershell
openclaw config file
```

这样做的原因是：

- 不依赖用户目录猜测
- 支持未来 profile 或配置路径变化
- 更适合自动化脚本复用

## 自动化流程

### 1. 检测 OpenClaw CLI 是否可用

先确认 `openclaw` 命令存在，并能正常执行：

```powershell
Get-Command openclaw
openclaw --help
```

目的：

- 确认本机已安装 `OpenClaw`
- 确认后续 `config validate`、`models list` 可用

### 2. 定位当前活动配置文件

通过 CLI 获取当前真实配置路径：

```powershell
openclaw config file
```

本机结果为：

```text
~\.openclaw\openclaw.json
```

对应绝对路径：

[openclaw.json](C:\Users\Administrator\.openclaw\openclaw.json)

### 3. 验证自定义代理接口可用

在真正写配置前，先请求代理服务，避免写入无效 endpoint。

实际做了两类探测：

```http
GET /v1/models
POST /v1/chat/completions
```

验证内容：

- 端口是否可访问
- `Authorization: Bearer api-xuanshukejiapi` 是否有效
- 是否是 OpenAI 兼容格式
- `/v1/models` 是否能列出模型
- `/v1/chat/completions` 是否能正常返回内容

只有连通性正常，才进入写配置阶段。

### 4. 读取现有配置 JSON

自动化实现不是直接覆盖整个文件，而是先读取现有 JSON，再按路径修改局部字段。

关键原因：

- 避免破坏已有配置
- 保留 Telegram、gateway、plugins、auth 等已有内容
- 只增量更新 `models` 与 `agents.defaults.models`

### 5. 写入自定义 provider

在配置中的 `models.providers` 下新增或更新一个 provider：

```json
"models": {
  "mode": "merge",
  "providers": {
    "cliproxy": {
      "baseUrl": "http://127.0.0.1:8317/v1",
      "apiKey": "api-xuanshukejiapi",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

这里的核心字段含义：

- `cliproxy`: provider 标识名
- `baseUrl`: OpenAI 兼容服务地址
- `apiKey`: 用于鉴权
- `api: "openai-completions"`: 告诉 OpenClaw 这是 OpenAI 风格接口
- `models`: 这个 provider 暴露的模型清单

### 6. 将 `/v1/models` 返回结果映射为 OpenClaw 模型定义

这是自动化的关键步骤。

从代理接口返回的模型列表，例如：

- `gpt-5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `claude-sonnet-4-6`
- `gemini-3-flash`

自动转换成 OpenClaw 所需的配置对象，例如：

```json
{
  "id": "gpt-5.4",
  "name": "gpt-5.4",
  "api": "openai-completions",
  "reasoning": true,
  "input": ["text", "image"],
  "cost": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0
  },
  "contextWindow": 266000,
  "maxTokens": 4096
}
```

映射规则是人工制定并写入的，主要原则如下：

- `id` 直接使用 `/v1/models` 返回值
- `name` 默认与 `id` 一致
- `api` 统一使用 `openai-completions`
- `cost` 统一先置零
- `contextWindow` 统一先给 `266000`
- `maxTokens` 统一先给 `4096`

能力判断规则：

- 明显支持图像的模型，写成 `input: ["text", "image"]`
- 其他默认写成 `input: ["text"]`
- 推理型模型写 `reasoning: true`
- 非推理型模型写 `reasoning: false`

这一步不是 OpenClaw 自动扫描出来的，而是根据模型名做的配置映射。

### 7. 在 `agents.defaults.models` 中注册模型

仅在 provider 下写模型还不够，还需要把这些模型加到 agent 默认模型白名单中，否则不会作为可配置模型暴露出来。

实际写入结构如下：

```json
"agents": {
  "defaults": {
    "models": {
      "cliproxy/claude-opus-4-6-thinking": {},
      "cliproxy/gpt-5": {},
      "cliproxy/gpt-5.4": {
        "alias": "cliproxy"
      },
      "cliproxy/gpt-5.4-mini": {}
    }
  }
}
```

作用：

- 让 `OpenClaw` 将这些模型视为可配置模型
- 允许在 `models list` 中展示
- 允许后续 `set`、`alias`、默认模型切换等操作

### 8. 设置别名

将下面的别名写进 `agents.defaults.models`：

```json
"cliproxy/gpt-5.4": {
  "alias": "cliproxy"
}
```

作用：

以后可以直接把 `cliproxy` 当作模型名使用，它等价于：

```text
cliproxy/gpt-5.4
```

### 9. 配置校验

修改完成后，不直接假设成功，而是调用：

```powershell
openclaw config validate
```

如果通过，说明：

- JSON 格式合法
- 结构满足 OpenClaw schema
- provider、models、agent defaults 没写坏

### 10. 生效确认

校验通过后，再执行：

```powershell
openclaw models list
openclaw models aliases list
```

确认两件事：

- `cliproxy/...` 模型全部出现
- 别名 `cliproxy -> cliproxy/gpt-5.4` 已生效

这一步是自动化闭环中非常重要的验证步骤。

## 本次自动化修改的实际结果

已完成的内容：

- 原 provider `custom-127-0-0-1-8317` 改成了 `cliproxy`
- `apiKey` 改成了 `api-xuanshukejiapi`
- `/v1/models` 返回的全部模型都被注册进了 `cliproxy`
- `cliproxy/gpt-5.4` 设置了别名 `cliproxy`
- `openclaw config validate` 通过
- `openclaw models list` 已能列出所有 `cliproxy/...` 模型

## 为什么这样实现

采用的是“直接修改配置文件 + CLI 校验”的方式，而不是只调用 `openclaw models` 子命令，原因是：

- 你的需求是批量接入一个 OpenAI 兼容代理返回的全部模型
- OpenClaw 的 CLI 更适合查看、设置、校验，不适合一次性高效写入大量自定义模型
- 直接改 JSON 可完整控制 provider、models、alias、agent defaults
- 最后再用 `openclaw config validate` 和 `openclaw models list` 做收尾确认，稳定且可重复

## 如果做成真正的一键自动化

脚本的完整职责应当是：

1. 调 `openclaw config file`
2. 读取现有 `openclaw.json`
3. 请求 `http://127.0.0.1:8317/v1/models`
4. 生成 `cliproxy` provider 配置
5. 生成全部模型定义
6. 更新 `agents.defaults.models`
7. 设置 `cliproxy/gpt-5.4` 的 alias
8. 写回 JSON
9. 运行 `openclaw config validate`
10. 运行 `openclaw models list` 做结果确认

也就是说，这个自动化的本质不是“调用某个单独命令”，而是：

- 发现配置文件
- 拉取模型列表
- 组装 OpenClaw 认可的 JSON 结构
- 写入配置
- 通过 CLI 验证结果

## 后续建议

如果要继续落地脚本，下一步建议二选一：

- “脚本实现规格说明”
- “PowerShell 版本的一键配置脚本设计稿”
