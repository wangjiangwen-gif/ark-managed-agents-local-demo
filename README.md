# 方舟 Managed Agents · 本地电脑 Demo

这是一个 Self-hosted 快速体验 Demo：Agent 推理、Session 编排和 Work Queue 运行在火山方舟，本地 Worker 负责执行 Bash 与文件系统操作。

用户只需一条命令启动 Web UI，然后依次完成 API Key 配置、云端资源初始化、本地 Worker 连接和对话体验。Worker 仅主动发起出站 HTTPS 请求，不要求为本机开放公网入站端口。

## 能力概览

- 一键创建支持 Bash 的通用 Agent 和 Self-hosted Environment。
- 选择一个本地目录作为 Agent 的工作空间。
- 使用方舟 Self-hosted Worker SDK 轮询并执行 Tool Use。
- 通过 Web UI 创建 Session、发送任务并观察运行状态。
- 展示 Agent 回复及本地生成的 HTML、Markdown 等文件。
- 在当前服务进程内保存最近 20 次 Session，刷新页面后可以继续查看。

## 使用前准备

- macOS（当前目录选择器使用系统原生 `osascript`）。
- Node.js 18 或更高版本。
- Go 1.20 或更高版本。
- 一个可用的火山方舟 Managed Agents API Key。
- 能访问 GitHub 和方舟生产 API。

检查本机环境：

```bash
node --version
go version
git --version
```

## 一行启动

```bash
cd /path/to/local-agent-demo && ./start.sh
```

服务启动后会打开：

```text
http://127.0.0.1:4173
```

如果浏览器没有自动打开，可以手动访问上述地址。

页面右上角提供“重新开始”。点击确认后会停止当前 Worker、清空当前进程内的 API Key 和会话记录，自动重启本地服务并返回第一步。该能力依赖 `./start.sh` 的守护循环；直接运行 `node server.mjs` 或 `npm start` 时不会启用页面重启。

## Step by step

### 1. 连接方舟

在页面中填写方舟 API Key，然后点击“验证并继续”。API Key 只保存在当前 Node.js 进程内存中，不会写入浏览器存储或本地文件。

默认连接方舟生产环境。测试其他环境时，可以在“高级设置”中修改 Base URL 和模型 ID。

### 2. 初始化云端资源

点击“一键初始化”，Demo 将按顺序创建：

1. 一个启用 Bash Tool 的通用 Agent。
2. 一个 `self_hosted` Environment。

页面会展示创建得到的 `agent_id`、版本和 `environment_id`。

### 3. 连接本地电脑

点击“选择文件夹”，选择一个空目录或专用测试目录，再启动 Worker。

首次启动时，Go 会根据 `worker/go.mod` 自动下载公开的 [volcengine/ark-runtime-go](https://github.com/volcengine/ark-runtime-go) SDK。当前 Self-hosted Worker 已发布在公开仓库 `main`，Demo 固定具体提交以保证可复现。

也可以提前准备 SDK：

```bash
./setup-sdk.sh
```

Worker 启动后，会持续轮询该 Environment 的 Work Queue。每个 Session 使用独立的子目录：

```text
<选择的工作目录>/
└── <session_id>/
    ├── Agent 生成的文件
    └── .ma_self_host_worker/
        └── tool_ledger/
```

### 4. 创建 Session 并体验

选择一个预置问题，或输入自己的任务。每次发送都会：

1. 创建一个新的 Session，并绑定上一步创建的 Agent 和 Environment。
2. 写入 `user.message`。
3. 由方舟生成 Tool Use 并放入 Self-hosted 执行链路。
4. 本地 Worker 领取 Work Item，在 Session 子目录执行工具。
5. Worker 回传 Tool Result，方舟继续推理直至 Session 到达终态。

如果方舟在等待本地 Tool Result 时短暂返回 `session.status_idle`，页面会显示“等待本地工具结果”并继续拉取事件；只有不存在尚未回传的 Tool Use 时，才将该状态视为本轮结束。

推荐先测试：

```text
写一份单页 HTML PPT，介绍 Managed Agents 如何落在本地文件系统，并保存为 ma-local.html
```

完成后，页面会展示 Agent 回复、Session ID、终态、事件数量以及本地产物链接。

## Session 观测与刷新恢复

Demo 在当前服务进程内保存最近 20 次运行的以下信息：

- Session ID、创建时间与当前状态。
- 用户输入和 Agent 最终回复。
- Session 事件的类型、时间和必要摘要。
- 本地产物的路径、大小和更新时间。

刷新页面后，可以在“最近运行”中恢复这些记录；停止并重新启动服务后，会话记录会被清空，避免不同体验批次相互干扰。API Key 同样只存在于当前服务进程内。

## 本地运行 Worker

Web 服务会以等价于以下配置启动 Worker：

```bash
export ARK_API_KEY="<your-api-key>"
export ARK_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
export MA_ENVIRONMENT_ID="<environment-id>"
export MA_WORKDIR="<selected-directory>"

cd worker
go run .
```

页面中的“查看本地运行日志”可以看到 Work Item 领取和 Tool Use 执行情况。

## 开发与测试

运行测试：

```bash
npm test
```

检查 JavaScript 语法：

```bash
node --check server.mjs
node --check public/app.js
```

当前项目不依赖第三方 Node.js 包，服务端和前端均使用 Node.js 与浏览器原生能力。

## 安全边界

- API Key 仅保存在本地 Node.js 进程内存中，不写入 LocalStorage、日志或 Session 历史文件。
- 浏览器不直接调用方舟 API，所有请求均经过本地服务端。
- Worker 仅操作用户明确选择的目录；建议始终使用空目录或专用测试目录。
- 本地产物接口会做路径校验并拒绝 `../` 越界访问。
- Session 观测可能包含用户输入、Agent 回复和产物元数据；停止服务即可清除内存记录。
- 这是体验型 Demo，不包含生产级登录鉴权、租户隔离、Secret Manager、资源回收和审计治理。

## 常见问题

### 端口 4173 已被占用

```bash
PORT=4174 ./start.sh
```

### Worker 一直没有领取任务

依次确认：

1. 页面显示的 Worker 状态是否为“运行中”。
2. API Key、Base URL 和 Environment 是否属于同一个方舟账号与环境。
3. Agent 是否启用了 Bash Tool。
4. 本机是否能够通过 HTTPS 访问方舟域名。
5. “查看本地运行日志”中是否出现鉴权、SDK 编译或 Poll 错误。

### 找不到生成文件

生成文件位于所选目录下以 Session ID 命名的子目录中，而不是直接位于所选目录根目录。

### 页面刷新后为什么需要重新填写 API Key

普通页面刷新不会清除 API Key；停止并重新启动本地服务后，API Key 和会话观测记录都会清除。这是 Demo 的安全设计，避免把密钥与输入持久化到磁盘。

## 项目结构

```text
local-agent-demo/
├── public/               # Web UI
├── tests/                # Node.js 测试
├── worker/               # Self-hosted Worker 适配代码
├── server.mjs            # 本地服务与方舟 API 编排
├── setup-sdk.sh          # Worker SDK 准备脚本
└── start.sh              # 一行启动入口
```
