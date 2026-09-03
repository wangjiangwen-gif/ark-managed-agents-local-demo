import http from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL_ID = "doubao-seed-2-1-turbo-260628";
const TERMINAL_EVENTS = new Set(["session.status_idle", "session.status_terminated", "session.error"]);

export function createState({ sessions = [] } = {}) {
  return {
    apiKey: "",
    baseUrl: DEFAULT_BASE_URL,
    modelId: DEFAULT_MODEL_ID,
    agent: null,
    environment: null,
    workdir: "",
    worker: null,
    workerStartedAt: null,
    workerExit: null,
    session: sessions[0] || null,
    sessions,
    logs: [],
    clients: new Set(),
  };
}

function publicState(state) {
  return {
    configured: Boolean(state.apiKey),
    baseUrl: state.baseUrl,
    modelId: state.modelId,
    agent: state.agent,
    environment: state.environment,
    workdir: state.workdir,
    worker: {
      running: Boolean(state.worker && state.worker.exitCode === null),
      startedAt: state.workerStartedAt,
      exit: state.workerExit,
    },
    session: state.session,
    sessions: state.sessions.slice(0, 20),
    logs: state.logs.slice(-80),
  };
}

function observedEvent(event, annotations = {}) {
  const text = eventText(event).trim();
  const errorMessage = event?.error?.message || event?.message || event?.data?.error?.message || "";
  return {
    id: event.id || null,
    type: event.type || "unknown",
    at: event.processed_at || event.created_at || new Date().toISOString(),
    ...(text ? { text } : {}),
    ...(event.tool_use_id ? { toolUseId: event.tool_use_id } : {}),
    ...((event.name || event?.tool?.name || event?.data?.name) ? { toolName: event.name || event.tool?.name || event.data?.name } : {}),
    ...(typeof event.is_error === "boolean" ? { isError: event.is_error } : {}),
    ...(errorMessage ? { error: String(errorMessage) } : {}),
    ...annotations,
  };
}

function updateSession(state, id, changes) {
  const index = state.sessions.findIndex((item) => item.id === id);
  const current = index >= 0 ? state.sessions[index] : { id };
  const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
  if (index >= 0) state.sessions.splice(index, 1);
  state.sessions.unshift(next);
  state.sessions = state.sessions.slice(0, 20);
  state.session = next;
  emit(state, "state", publicState(state));
  return next;
}

function emit(state, event, payload) {
  const item = { event, payload, at: new Date().toISOString() };
  if (event === "log") {
    state.logs.push(item);
    if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
  }
  const frame = `event: ${event}\ndata: ${JSON.stringify(item)}\n\n`;
  for (const response of state.clients) response.write(frame);
}

function redact(value, secret) {
  if (!secret || typeof value !== "string") return value;
  return value.split(secret).join("[REDACTED]");
}

async function jsonBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { status: 400 });
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function unwrap(payload) {
  if (payload && typeof payload === "object" && payload.data && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload;
}

export class ArkApiError extends Error {
  constructor(message, { status, requestId, body } = {}) {
    super(message);
    this.name = "ArkApiError";
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

export async function arkRequest(state, path, options = {}) {
  if (!state.apiKey) throw Object.assign(new Error("请先填写并验证 API Key"), { status: 400 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(`${state.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${state.apiKey}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
      throw new ArkApiError(String(detail), {
        status: response.status,
        requestId: response.headers.get("x-request-id") || response.headers.get("x-tt-logid"),
        body: payload,
      });
    }
    return unwrap(payload);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new ArkApiError("请求方舟超时", { status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function agentPayload(modelId) {
  return {
    name: `local-computer-demo-${Date.now()}`,
    description: "在本地电脑执行 Bash 与文件操作的 Managed Agents 演示 Agent",
    model: { id: modelId },
    system: [
      "你是一个运行在用户本地电脑工作目录中的通用助手。",
      "凡是涉及文件、HTML、代码或目录的任务，必须调用 bash 工具在当前工作目录中实际完成，不要只给示例。",
      "只操作当前工作目录及其子目录，不读取其他路径，不删除用户已有文件。",
      "完成后用中文简要说明创建或修改了哪些相对路径。",
    ].join("\n"),
    tools: [{
      type: "agent_toolset_20260401",
      configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_allow" } }],
      default_config: { enabled: false },
    }],
    skills: [],
    mcp_servers: [],
    metadata: { created_via: "local-computer-demo" },
  };
}

function environmentPayload() {
  return {
    name: `local-computer-demo-${Date.now()}`,
    description: "Self-hosted Environment for local computer demo",
    config: { type: "self_hosted" },
    metadata: { created_via: "local-computer-demo" },
  };
}

function sessionPayload(state) {
  return {
    agent: { type: "agent", id: state.agent.id, version: state.agent.version },
    environment_id: state.environment.id,
    vault_ids: [],
    title: `本地电脑体验 ${new Date().toLocaleString("zh-CN")}`,
  };
}

function userMessagePayload(message) {
  return { events: [{ type: "user.message", content: [{ type: "text", text: message }] }] };
}

function eventText(event) {
  if (!Array.isArray(event?.content)) return "";
  return event.content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
}

function normalizeEvents(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.events)) return payload.events;
  return [];
}

async function chooseDirectory() {
  if (process.platform !== "darwin") {
    throw Object.assign(new Error("当前 Demo 的可视化目录选择器仅支持 macOS，可改为手动输入绝对路径"), { status: 400 });
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn("osascript", [
      "-e", "POSIX path of (choose folder with prompt \"选择 Agent 可操作的本地文件夹\")",
    ]);
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    child.on("close", (code) => {
      if (code === 0 && output.trim()) resolvePromise(output.trim().replace(/\/$/, ""));
      else reject(Object.assign(new Error(errorOutput.includes("User canceled") ? "已取消选择" : "无法打开目录选择器"), { status: 400 }));
    });
  });
}

async function startWorker(state) {
  if (!state.environment?.id) throw Object.assign(new Error("请先初始化 Self-hosted Environment"), { status: 400 });
  if (!state.workdir) throw Object.assign(new Error("请先选择本地工作目录"), { status: 400 });
  if (state.worker && state.worker.exitCode === null) return;
  const worker = spawn("go", ["run", "."], {
    cwd: join(ROOT, "worker"),
    env: {
      ...process.env,
      ARK_API_KEY: state.apiKey,
      ARK_BASE_URL: state.baseUrl,
      MA_ENVIRONMENT_ID: state.environment.id,
      MA_WORKDIR: state.workdir,
      MA_WORKER_ID: `local-demo-${process.pid}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.worker = worker;
  state.workerStartedAt = new Date().toISOString();
  state.workerExit = null;
  const onData = (chunk) => emit(state, "log", { source: "worker", text: redact(chunk.toString().trim(), state.apiKey) });
  worker.stdout.on("data", onData);
  worker.stderr.on("data", onData);
  worker.on("error", (error) => emit(state, "log", { source: "worker", level: "error", text: error.message }));
  worker.on("close", (code, signal) => {
    state.workerExit = { code, signal, at: new Date().toISOString() };
    if (state.session?.status === "running") {
      const message = `Worker 意外退出（code=${code ?? "-"}, signal=${signal ?? "-"}）`;
      updateSession(state, state.session.id, {
        status: "worker_error",
        terminal: "worker_error",
        events: [...(state.session.events || []), { type: "worker.error", at: new Date().toISOString(), error: message }],
      });
    }
    emit(state, "state", publicState(state));
    emit(state, "log", { source: "worker", text: `Worker 已退出（code=${code ?? "-"}, signal=${signal ?? "-"}）` });
  });
  emit(state, "state", publicState(state));
}

async function stopWorker(state) {
  if (!state.worker || state.worker.exitCode !== null) return;
  state.worker.kill("SIGTERM");
}

async function listArtifacts(workdir) {
  if (!workdir) return [];
  const root = resolve(workdir);
  const results = [];
  async function walk(directory, depth) {
    if (depth > 3 || results.length >= 100) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else {
        const info = await stat(absolute);
        results.push({ path: rel, size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
  }
  await walk(root, 0);
  return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function safeArtifactPath(workdir, requested) {
  const root = resolve(workdir);
  const target = resolve(root, requested || "");
  const rel = relative(root, target);
  if (!requested || rel.startsWith("..") || isAbsolute(rel)) {
    throw Object.assign(new Error("非法文件路径"), { status: 400 });
  }
  return target;
}

async function runTurn(state, message) {
  if (!state.agent?.id || !state.environment?.id) throw Object.assign(new Error("请先完成方舟资源初始化"), { status: 400 });
  if (!state.worker || state.worker.exitCode !== null) throw Object.assign(new Error("请先启动本地 Worker"), { status: 400 });

  const created = await arkRequest(state, "/sessions", { method: "POST", body: sessionPayload(state) });
  const createdAt = new Date().toISOString();
  updateSession(state, created.id, {
    status: "running",
    message,
    reply: "",
    terminal: null,
    createdAt,
    events: [{ id: null, type: "user.message", at: createdAt, text: message }],
    artifacts: [],
  });
  await arkRequest(state, `/sessions/${encodeURIComponent(created.id)}/events`, {
    method: "POST",
    body: userMessagePayload(message),
  });

  const seen = new Set();
  const outstandingToolUses = new Set();
  const replies = [];
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    const payload = await arkRequest(state, `/sessions/${encodeURIComponent(created.id)}/events?limit=100`, { timeoutMs: 20_000 });
    for (const event of normalizeEvents(payload)) {
      const key = event.id || `${event.type}:${event.processed_at || ""}:${JSON.stringify(event.content || event)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (event.type === "agent.tool_use") {
        const toolUseId = event.tool_use_id || event.id;
        if (toolUseId) outstandingToolUses.add(toolUseId);
      }
      if (event.type === "user.tool_result" && event.tool_use_id) {
        outstandingToolUses.delete(event.tool_use_id);
      }
      const waitingForToolResult = event.type === "session.status_idle" && outstandingToolUses.size > 0;
      const observation = observedEvent(event, waitingForToolResult ? {
        waitingForToolResult: true,
        outstandingToolUses: outstandingToolUses.size,
      } : {});
      const current = state.sessions.find((item) => item.id === created.id);
      updateSession(state, created.id, { events: [...(current?.events || []), observation] });
      emit(state, "session-event", { sessionId: created.id, event: observation });
      if (event.type === "agent.message") {
        const text = eventText(event).trim();
        if (text) replies.push(text);
      }
      if (TERMINAL_EVENTS.has(event.type)) {
        if (waitingForToolResult) continue;
        const artifacts = await listArtifacts(state.workdir);
        updateSession(state, created.id, {
          status: event.type,
          terminal: event.type,
          reply: replies.join("\n\n"),
          artifacts,
          completedAt: new Date().toISOString(),
        });
        return {
          sessionId: created.id,
          terminal: event.type,
          reply: replies.join("\n\n"),
          artifacts,
        };
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  updateSession(state, created.id, { status: "timed_out", terminal: "timed_out" });
  throw Object.assign(new Error("等待 Session 终态超时，可在方舟控制台按 Session ID 排查"), { status: 504 });
}

function contentType(pathname) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
  })[extname(pathname)] || "application/octet-stream";
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = safeArtifactPath(PUBLIC_DIR, requested);
  const data = await readFile(file);
  response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-cache" });
  response.end(data);
}

export function createDemoServer({ state = createState(), onRestart = null } = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        return sendJson(response, 200, publicState(state));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        const session = state.sessions.find((item) => item.id === sessionId);
        if (!session) throw Object.assign(new Error("未找到本地 Session 观测记录"), { status: 404 });
        return sendJson(response, 200, { data: session });
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.write(`event: state\ndata: ${JSON.stringify({ event: "state", payload: publicState(state) })}\n\n`);
        state.clients.add(response);
        request.on("close", () => state.clients.delete(response));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/config") {
        const body = await jsonBody(request);
        if (!String(body.apiKey || "").trim()) throw Object.assign(new Error("API Key 不能为空"), { status: 400 });
        const nextState = { ...state, apiKey: String(body.apiKey).trim(), baseUrl: String(body.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ""), modelId: String(body.modelId || DEFAULT_MODEL_ID).trim() };
        await arkRequest(nextState, "/agents?limit=1", { timeoutMs: 15_000 });
        state.apiKey = nextState.apiKey;
        state.baseUrl = nextState.baseUrl;
        state.modelId = nextState.modelId;
        emit(state, "state", publicState(state));
        return sendJson(response, 200, { ok: true, state: publicState(state) });
      }
      if (request.method === "POST" && url.pathname === "/api/provision") {
        if (!state.agent) {
          emit(state, "log", { source: "server", text: "正在创建通用 Agent…" });
          const created = await arkRequest(state, "/agents", { method: "POST", body: agentPayload(state.modelId) });
          state.agent = { id: created.id, version: created.version, name: created.name };
          emit(state, "state", publicState(state));
        }
        if (!state.environment) {
          emit(state, "log", { source: "server", text: "正在创建 Self-hosted Environment…" });
          const created = await arkRequest(state, "/environments", { method: "POST", body: environmentPayload() });
          state.environment = { id: created.id, name: created.name, type: created.config?.type || "self_hosted" };
          emit(state, "state", publicState(state));
        }
        return sendJson(response, 200, { ok: true, state: publicState(state) });
      }
      if (request.method === "POST" && url.pathname === "/api/select-directory") {
        const body = await jsonBody(request);
        const selected = body.path ? normalize(String(body.path)) : await chooseDirectory();
        if (!isAbsolute(selected)) throw Object.assign(new Error("请输入绝对路径"), { status: 400 });
        const info = await stat(selected);
        if (!info.isDirectory()) throw Object.assign(new Error("选择的路径不是文件夹"), { status: 400 });
        state.workdir = selected;
        emit(state, "state", publicState(state));
        return sendJson(response, 200, { path: selected });
      }
      if (request.method === "POST" && url.pathname === "/api/worker/start") {
        await startWorker(state);
        return sendJson(response, 200, { ok: true, state: publicState(state) });
      }
      if (request.method === "POST" && url.pathname === "/api/worker/stop") {
        await stopWorker(state);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/restart") {
        if (!onRestart) throw Object.assign(new Error("请使用 ./start.sh 启动 Demo，才能在页面内重启服务"), { status: 409 });
        await stopWorker(state);
        sendJson(response, 202, { ok: true, message: "本地服务正在重新启动" });
        if (onRestart) setTimeout(() => onRestart(), 80);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await jsonBody(request);
        const message = String(body.message || "").trim();
        if (!message) throw Object.assign(new Error("请输入任务内容"), { status: 400 });
        return sendJson(response, 200, await runTurn(state, message));
      }
      if (request.method === "GET" && url.pathname === "/api/artifacts") {
        return sendJson(response, 200, { data: await listArtifacts(state.workdir) });
      }
      if (request.method === "GET" && url.pathname === "/api/artifact") {
        const file = safeArtifactPath(state.workdir, url.searchParams.get("path"));
        const info = await stat(file);
        response.writeHead(200, {
          "Content-Type": contentType(file),
          "Content-Length": info.size,
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.split("/").pop())}`,
        });
        return createReadStream(file).pipe(response);
      }
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        return await serveStatic(response, url.pathname);
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (request.method === "POST" && url.pathname === "/api/chat" && state.session?.status === "running") {
        updateSession(state, state.session.id, {
          status: "client_error",
          terminal: "client_error",
          events: [...(state.session.events || []), {
            type: "client.error",
            at: new Date().toISOString(),
            error: redact(error.message, state.apiKey),
          }],
        });
      }
      emit(state, "log", { source: "server", level: "error", text: redact(error.message, state.apiKey) });
      sendJson(response, status, {
        error: redact(error.message, state.apiKey),
        requestId: error.requestId || null,
      });
    }
  });

  server.on("close", () => stopWorker(state));
  return { server, state };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const port = Number(process.env.PORT || 4173);
  const supervised = process.env.ARK_DEMO_SUPERVISED === "1";
  const { server } = createDemoServer({ onRestart: supervised ? () => process.exit(75) : null });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n方舟 Managed Agents · 本地电脑 Demo 已启动：${url}\n`);
    if (process.env.ARK_DEMO_OPEN_BROWSER === "1" && process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    }
  });
}
