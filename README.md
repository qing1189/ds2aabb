# DS Gateway

DeepSeek Web 会话转 OpenAI 兼容 API 的私有网关服务。

## 功能特性

- **OpenAI 兼容接口** — 支持 `/v1/chat/completions` 和 `/v1/models`
- **DeepSeek 原生接口** — 支持 `/api/v0/chat/completion`
- **多令牌池** — 支持多个 Token 并发轮询，自动负载均衡
- **自动刷新** — 令牌失效后自动通过账号重新登录获取
- **视觉模型** — 支持图片上传和视觉理解
- **请求队列** — 流量排队管理，防止并发溢出
- **管理面板** — 内置 Web 管理界面，实时监控状态
- **代理支持** — 支持 HTTP/HTTPS 代理出站请求
- **PoW 验证** — 内置 DeepSeekHashV1 验证求解器（WASM + BigInt 双引擎）

## 模型映射

### 基础模型

| API 模型名 | 类型 | 思考 | 搜索 | 说明 |
|---|---|---|---|---|
| `deepseek-v4-flash` | default | ✅ | ❌ | 默认模型，带深度思考 |
| `deepseek-v4-pro` | expert | ✅ | ❌ | 专家模型，带深度思考 |
| `deepseek-v4-vision` | vision | ✅ | ❌ | 视觉模型，带深度思考 |

### 搜索变体（思考 + 搜索）

| API 模型名 | 类型 | 思考 | 搜索 | 说明 |
|---|---|---|---|---|
| `deepseek-v4-flash-search` | default | ✅ | ✅ | 默认模型 + 联网搜索 |
| `deepseek-v4-pro-search` | expert | ✅ | ✅ | 专家模型 + 联网搜索 |

### 无思考变体

| API 模型名 | 类型 | 思考 | 搜索 | 说明 |
|---|---|---|---|---|
| `deepseek-v4-flash-nothinking` | default | ❌ | ❌ | 直接回答，不推理 |
| `deepseek-v4-pro-nothinking` | expert | ❌ | ❌ | 专家直答，不推理 |
| `deepseek-v4-vision-nothinking` | vision | ❌ | ❌ | 视觉直答，不推理 |

### 搜索 + 无思考变体

| API 模型名 | 类型 | 思考 | 搜索 | 说明 |
|---|---|---|---|---|
| `deepseek-v4-flash-search-nothinking` | default | ❌ | ✅ | 联网搜索，不推理 |
| `deepseek-v4-pro-search-nothinking` | expert | ❌ | ✅ | 专家搜索，不推理 |

### 1M 上下文变体

所有上述模型均支持 `[1m]` 后缀，启用 100万 token 超长上下文窗口：

| API 模型名 | 说明 |
|---|---|
| `deepseek-v4-flash[1m]` | 1M 上下文 - 默认模型 |
| `deepseek-v4-pro[1m]` | 1M 上下文 - 专家模型 |
| `deepseek-v4-vision[1m]` | 1M 上下文 - 视觉模型 |
| `deepseek-v4-flash-search[1m]` | 1M 上下文 - 搜索 |
| `deepseek-v4-pro-search[1m]` | 1M 上下文 - 专家搜索 |
| `deepseek-v4-flash-nothinking[1m]` | 1M 上下文 - 无思考 |
| `deepseek-v4-pro-nothinking[1m]` | 1M 上下文 - 专家无思考 |
| `deepseek-v4-vision-nothinking[1m]` | 1M 上下文 - 视觉无思考 |
| `deepseek-v4-flash-search-nothinking[1m]` | 1M 上下文 - 搜索无思考 |
| `deepseek-v4-pro-search-nothinking[1m]` | 1M 上下文 - 专家搜索无思考 |

### 模型别名

支持通过常见第三方模型名调用，自动映射到对应 DeepSeek 模型：

| 别名 | 映射到 |
|---|---|
| `deepseek-chat` / `deepseek-reasoner` / `deepseek-coder` | `deepseek-v4-flash` |
| `gpt-4` / `gpt-4o` / `gpt-4o-mini` / `gpt-4.1` | `deepseek-v4-flash` |
| `o1` / `o3` / `o3-mini` / `o4-mini` | `deepseek-v4-pro` |
| `claude-sonnet-4-6` / `claude-3-5-sonnet-latest` | `deepseek-v4-flash` |
| `claude-opus-4-6` / `claude-opus-4-1` | `deepseek-v4-pro` |
| `gemini-2.5-flash` / `gemini-2.0-flash` | `deepseek-v4-flash` |
| `gemini-2.5-pro` / `gemini-pro` | `deepseek-v4-pro` |
| `gemini-pro-vision` | `deepseek-v4-vision` |

### 后缀命名规则

```
deepseek-v4-{flash|pro|vision}[-search][-nothinking][[1m]]
```

- **flash** — 快速模型（default 类型）
- **pro** — 专家模型（expert 类型）
- **vision** — 视觉模型
- **-search** — 启用联网搜索
- **-nothinking** — 关闭深度思考/推理
- **[1m]** — 使用 1M（100万 token）超长上下文窗口

> 💡 客户端也可以通过请求 body 中的 `thinking_enabled` / `search_enabled` 字段显式覆盖模型默认配置。

## 快速开始

### Docker Compose 部署（推荐）

1. 创建 `.env` 文件：

```bash
# 必填：至少配置一种令牌方式
DS_TOKENS=token1,token2,token3

# 或使用账号密码（自动登录获取令牌）
# DS_ACCOUNTS=email1:pass1,email2:pass2

# 可选：API 访问密钥（不设则无需认证）
API_KEY=your-secret-key

# 可选：出站代理
# HTTPS_PROXY=http://proxy:port

# 可选：服务端口映射（默认 3000）
# PORT=3000
```

2. 启动服务：

```bash
docker compose up -d
```

3. 查看日志：

```bash
docker compose logs -f
```

4. 停止服务：

```bash
docker compose down
```

### Docker 单独构建运行

```bash
# 构建镜像
docker build -t ds2aabb .

# 运行容器
docker run -d \
  --name ds2aabb \
  --restart unless-stopped \
  -p 3000:3000 \
  -e DS_TOKENS="token1,token2" \
  -e API_KEY="your-secret-key" \
  ds2aabb
```

### 本地运行（开发）

```bash
npm install
# 编辑 .env 文件配置令牌
npm start
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DS_TOKEN` | 二选一 | 单个 DeepSeek 令牌 |
| `DS_TOKENS` | 二选一 | 多个令牌，逗号分隔 |
| `DS_ACCOUNTS` | 可选 | 账号密码对 `email:pass`，逗号分隔 |
| `DS_ACCOUNTS_EXTENDED` | 可选 | 扩展格式 `email:pass:token_prefix`，关联已有令牌 |
| `API_KEY` | 可选 | API 访问密钥，设置后所有请求需携带 Bearer Token |
| `PORT` | 可选 | 服务端口，默认 `3000` |
| `HTTPS_PROXY` | 可选 | HTTPS 代理地址 |
| `HTTP_PROXY` | 可选 | HTTP 代理地址 |

## 使用示例

### 非流式请求

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role":"user","content":"你好"}]
  }'
```

### 流式请求

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "deepseek-v4-pro",
    "stream": true,
    "messages": [{"role":"user","content":"解释量子计算"}]
  }'
```

### 查看可用模型

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## 管理面板

访问 `http://localhost:3000/admin` 打开管理面板，可以：

- 查看令牌池状态（健康度、并发数、视觉能力）
- 查看会话缓存信息
- 查看请求队列状态
- 在线添加令牌或通过账号登录添加

## 获取令牌

1. 登录 [chat.deepseek.com](https://chat.deepseek.com)
2. 打开浏览器开发者工具 → Application → Cookies
3. 复制 `userToken` 的值

或者直接配置 `DS_ACCOUNTS` 使用邮箱密码自动获取。

## 注意事项

- 每个令牌最大并发数为 2，建议多配几个令牌
- 令牌有效期较长，但可能因频繁使用被限制
- 视觉模型需要令牌账号开通了视觉权限
- 建议配置 `API_KEY` 防止未授权访问
- 如遇到 WAF 拦截，可配置代理
